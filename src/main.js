// Remote Browser Keeper — tray app.
// Connects to the service's keeper WebSocket, and on a "fill_request" pops up a
// prompt asking the user for the value, then sends it straight back to the
// service. The value never goes anywhere else.
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import QRCode from "qrcode";
import { loadConfig, keeperWsUrl } from "./config.js";
import { createSecretStore } from "./secrets.js";
import { loadCards, saveCards, autofillEnabled, isCardOnlyRequest, buildCardValues, cardOptions, mapCardToFields, hostFromUrl, findCardForDomain, approveDomain, approveAllSites, mergeRemoteCards, dropLegacyCardsFile } from "./cards.js";
import { available as secureStorageAvailable } from "./securestore.js";
import { getSaved, saveValue, forget as forgetField, listSaved, forgetAll as forgetAllFields, localVaultMap, mergeRemoteVault } from "./fieldstore.js";
import { syncVault, pullVault, putVault, emptyVault, generateVaultKey, userVaultKey, decryptLegacyV1, legacyV1SecretId, FORMAT_V1, VaultKeyMismatch } from "./vault.js";
import { loadVaultKey, saveVaultKey, ensureVaultKey, vaultKeyForPairing } from "./vaultkey.js";
import { buildDeviceReport } from "./device.js";
import { generateSharedValues, isNumericField } from "./genpassword.js";
import { loadSettings, saveSettings } from "./settings.js";
import { mergeHistory } from "./historymerge.js";
import { fetchServerHistory, fetchServerScreenshot } from "./historyapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Renderer is built by Vite to ../renderer-dist (one HTML per window). With
// KEEPER_DEV=1, load from the Vite dev server instead for hot-reload.
const KEEPER_DEV = process.env.KEEPER_DEV === "1";
function loadWindow(win, name) {
  // A window whose content fails to load still shows its frame, so the failure would
  // otherwise be a silent empty box. Name it in the log for EVERY window (the prompt
  // window additionally turns it into a user-visible failure — see failPrompt).
  const wc = win.webContents;
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) console.error(`[keeper] ${name} window failed to load: ${code} ${desc} ${url}`);
  });
  wc.on("preload-error", (_e, preloadPath, err) => {
    console.error(`[keeper] ${name} window preload error (${preloadPath}):`, (err && err.message) || err);
  });
  wc.on("render-process-gone", (_e, details) => {
    console.error(`[keeper] ${name} window renderer gone:`, (details && details.reason) || "?");
  });
  if (KEEPER_DEV) win.loadURL(`http://localhost:5173/${name}.html`);
  else win.loadFile(path.join(__dirname, "..", "renderer-dist", `${name}.html`));
}

// ---------- Local request history (NEVER stores values) ----------
const HISTORY_MAX = 2000;                       // keep at most this many entries
const HISTORY_MAX_AGE_MS = 6 * 30 * 24 * 3600 * 1000; // ~6 months
// History/screenshots live under ~/.remote-browser-keeper/<base-url>/ so dev and
// prod (different service URLs) are kept in separate folders automatically.
function sanitizeForPath(s) {
  return (
    String(s || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .replace(/[^A-Za-z0-9._-]/g, "_") || "default"
  );
}
function cardBaseUrl() { return loadConfig().baseUrl; }
let _dataDir = null;
function dataDir() {
  if (!_dataDir) {
    const { baseUrl } = loadConfig();
    _dataDir = path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl));
    try { fs.mkdirSync(_dataDir, { recursive: true }); } catch {}
  }
  return _dataDir;
}
function historyPath() {
  return path.join(dataDir(), "history.jsonl");
}
function screenshotsDir() {
  return path.join(dataDir(), "screenshots");
}
function screenshotFile(id) {
  return path.join(screenshotsDir(), id + ".jpg");
}
// request_id is a server UUID; restrict to safe chars to prevent path traversal.
function safeId(id) {
  return (typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) ? id : null;
}
// The proof screenshot (same image the prompt showed) is stored on the local
// machine next to the log, as screenshots/<request_id>.jpg. Values are still
// never stored.
function saveScreenshot(id, dataUrl) {
  const sid = safeId(id);
  if (!sid || typeof dataUrl !== "string" || !/^data:image\//.test(dataUrl)) return false;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return false;
  try {
    fs.mkdirSync(screenshotsDir(), { recursive: true });
    fs.writeFileSync(screenshotFile(sid), Buffer.from(dataUrl.slice(comma + 1), "base64"));
    return true;
  } catch { return false; }
}
// Delete screenshot files whose request_id is no longer in the (already-evicted)
// log — so screenshots are evicted together with their history entries.
function reconcileScreenshots(keepIds) {
  let files = [];
  try { files = fs.readdirSync(screenshotsDir()); } catch { return; }
  for (const f of files) {
    if (!f.endsWith(".jpg")) continue;
    if (!keepIds.has(f.slice(0, -4))) {
      try { fs.unlinkSync(path.join(screenshotsDir(), f)); } catch {}
    }
  }
}
// Add a new event and evict in the same operation: read the log, append the new
// record, drop anything older than HISTORY_MAX_AGE_MS, keep the last HISTORY_MAX,
// write once, then evict orphaned screenshots. Eviction therefore always runs at
// the moment an event is added.
function recordHistory(req, outcome) {
  if (!req) return;
  try {
    const now = new Date();
    const hasShot = saveScreenshot(req.request_id, req.screenshot);
    const rec = {
      request_id: req.request_id,
      session_id: req.session_id || null,
      url: req.url || null,
      requested_at: req._requested_at || null, // when the request arrived (ISO)
      resolved_at: now.toISOString(),
      outcome, // "submitted" (user sent values) | "cancelled"
      screenshot: hasShot ? "screenshots/" + req.request_id + ".jpg" : null,
      fields: (Array.isArray(req.fields) ? req.fields : []).map((f) => ({
        selector: f.selector,
        label: f.label || null,
        field: f.field || null,
        length: Number.isInteger(f.length) ? f.length : null,
        format: f.format || null,
      })),
    };
    const p = historyPath();
    let lines = [];
    try { lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean); } catch {}
    lines.push(JSON.stringify(rec));
    const cutoff = now.getTime() - HISTORY_MAX_AGE_MS;
    lines = lines.filter((ln) => {
      try {
        const t = Date.parse(JSON.parse(ln).resolved_at || "");
        return Number.isNaN(t) ? true : t >= cutoff;
      } catch { return false; } // drop unparseable lines
    });
    if (lines.length > HISTORY_MAX) lines = lines.slice(-HISTORY_MAX);
    fs.writeFileSync(p, lines.join("\n") + "\n");
    const keep = new Set();
    for (const ln of lines) { try { keep.add(JSON.parse(ln).request_id); } catch {} }
    reconcileScreenshots(keep);
  } catch (e) {
    console.warn("[keeper] history write failed:", e.message);
  }
}

// Parse the local history log (newest first); tolerant of partial/bad lines.
function readHistory() {
  try {
    const lines = fs.readFileSync(historyPath(), "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const ln of lines) { try { out.push(JSON.parse(ln)); } catch {} }
    return out.reverse();
  } catch { return []; }
}

let tray = null;
let promptWin = null;
let historyWin = null;
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000; // backoff, capped at 30s
let connected = false;
let heartbeatTimer = null;
let lastRx = 0; // last time any frame arrived (pong or otherwise)
const HEARTBEAT_MS = 25000; // how often we ping the service
const DEAD_AFTER_MS = 70000; // no inbound frame this long => socket is dead
const pending = new Map(); // request_id -> request payload (awaiting user)
const queue = []; // request_ids waiting for the prompt window

// ---------- Keeper WebSocket ----------
function connect() {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    console.warn("[keeper] no API key (AC_API_KEY / ~/.ac-api-key); will retry");
  }
  const url = keeperWsUrl(cfg);
  // Token goes in the Authorization header, NOT the URL, so it never leaks into
  // proxy/access logs. (Node's ws client supports request headers.)
  ws = new WebSocket(url, {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });

  ws.on("open", () => {
    connected = true;
    reconnectDelay = 1000;
    // Say who we are and which vault we hold, so the account can be asked "which devices
    // are paired, and is any of them stuck on the legacy key model?". Inert metadata only
    // (see device.js). `app`/`version` stay at the top level for older services.
    const report = deviceReport({ refresh: true });
    safeSend({ type: "hello", app: "remote-browser-keeper", version: app.getVersion(), ...report });
    lastSentReport = JSON.stringify(report);
    startHeartbeat();
    updateTray();
    console.log("[keeper] connected");
    // Pull any vault entries saved on another paired device (and push ours).
    void syncVaultNow();
  });

  ws.on("message", (data) => {
    lastRx = Date.now(); // any frame proves the link is alive
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "ping") { safeSend({ type: "pong" }); return; }
    if (msg.type === "pong") { return; } // heartbeat reply (already counted above)
    if (msg.type === "secret_request" && msg.request_id) { handleSecretRequest(msg); return; }
    // Another keeper (or a timeout) already resolved this request server-side —
    // dismiss our prompt for it so the user isn't asked twice.
    if (msg.type === "request_resolved" && msg.request_id) { dismissRequest(msg.request_id); return; }
    if (msg.type === "fill_request" && msg.request_id) {
      if (pending.has(msg.request_id)) return; // dedup: server replays pending on reconnect
      msg._requested_at = new Date().toISOString();
      if (tryAutofillCard(msg)) return; // answered from a saved card; no prompt
      if (tryAutofillGenerate(msg)) return; // generate-only request → create + fill, no prompt
      if (tryAutofillFields(msg)) return; // every field saved with "don't ask again"
      pending.set(msg.request_id, msg);
      queue.push(msg.request_id);
      showNextPrompt();
    }
  });

  ws.on("close", () => { connected = false; stopHeartbeat(); updateTray(); scheduleReconnect(); });
  ws.on("error", (e) => { console.warn("[keeper] ws error", e.message); try { ws.close(); } catch {} });
}

// App-level heartbeat so the tray status is truthful and we recover from half-open
// sockets (laptop sleep, network change, abrupt server restart) that deliver no
// close event. We ping the service every HEARTBEAT_MS; if nothing comes back for
// DEAD_AFTER_MS we terminate the socket, which fires "close" -> reconnect. The
// service does the symmetric check and answers our ping with a pong.
function startHeartbeat() {
  stopHeartbeat();
  lastRx = Date.now();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastRx > DEAD_AFTER_MS) {
      console.warn("[keeper] heartbeat timeout; socket is dead, forcing reconnect");
      connected = false;
      updateTray();
      try { ws.terminate(); } catch { try { ws.close(); } catch {} }
      return;
    }
    safeSend({ type: "ping" });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connect();
  }, reconnectDelay);
}

function safeSend(obj) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {}
}

// Service asked for a session-encryption secret by secret_id (zero-knowledge
// decryption). Phase 1: auto-respond from the per-env filesystem vault. The
// user-facing Approve Once/24h/Always/Deny prompt is the next phase. The secret
// is sent only over this authenticated socket and is never logged.
function handleSecretRequest(msg) {
  const sidShort = String(msg.secret_id || "").slice(0, 12) + "…";
  let secret = null;
  try {
    const { baseUrl } = loadConfig();
    secret = createSecretStore({ baseUrl }).getSecret(msg.secret_id);
  } catch (e) {
    console.warn("[keeper] secret store error:", e.message);
  }
  if (secret) {
    safeSend({ type: "secret_response", request_id: msg.request_id, secret, grant: "once" });
    console.log("[keeper] secret_request", sidShort, "-> responded");
  } else {
    safeSend({ type: "secret_response", request_id: msg.request_id, denied: true });
    console.warn("[keeper] secret_request", sidShort, "-> not in vault, denied");
  }
}

// Resolve the vault key to sync with. The vault has its own DEDICATED password
// (vaultkey.js), independent of the session secret. Returns { key } to sync with,
// { repair: true } when this device must re-pair to pick up a password another device
// set, or { transient: true } on a network hiccup. Handles the one-time v1->v2
// migration (the old vault was keyed by the session secret with a leaked secret_id).
let vaultNeedsRepair = false;
async function resolveVaultKey(cfg) {
  const existing = loadVaultKey(cfg.baseUrl);
  if (existing) return { key: existing };
  // No local vault key yet — decide from the server: fresh-generate, migrate, or re-pair.
  let status = 0, body = null;
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/api/vault", { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    status = res.status;
    if (res.ok) body = await res.json();
    else if (status !== 404) return { transient: true };
  } catch { return { transient: true }; }
  if (status === 404 || !body) return { key: saveVaultKey(cfg.baseUrl, generateVaultKey()) }; // brand-new
  if (body.format === FORMAT_V1) {
    let sessionSecret = null;
    try { sessionSecret = createSecretStore({ baseUrl: cfg.baseUrl }).firstSecret(); } catch { /* none */ }
    if (sessionSecret && body.secret_id === legacyV1SecretId(sessionSecret)) {
      const data = decryptLegacyV1(sessionSecret, body.ciphertext); // lift the old blob…
      const key = generateVaultKey();                                // …under a fresh dedicated key
      const put = await putVault(cfg, key, data, Number(body.version) || 0, {});
      if (put.conflict) return { transient: true };
      saveVaultKey(cfg.baseUrl, key);
      console.log("[keeper] vault migrated v1 -> v2 (dedicated key, leaked secret_id retired)");
      return { key };
    }
    return { repair: true }; // v1 but not ours to decrypt
  }
  return { repair: true }; // already v2 under an unknown password — re-pair to get it
}

// Merge the decrypted remote vault blob with this device's local state: "vault"-scoped
// saved fields AND saved cards (each merged per-entry, last-write-wins with tombstones).
// Unknown collections are preserved so a newer client can add more without loss.
function mergeVaultBlob(baseUrl, remoteBlob) {
  const fields = mergeRemoteVault(baseUrl, remoteBlob.fields || {});
  const c = mergeRemoteCards(baseUrl, remoteBlob.cards || {}, remoteBlob.cardsMeta || {});
  return { ...remoteBlob, fields, cards: c.cards, cardsMeta: c.cardsMeta };
}

// Sync the vault (fields + cards) with the service: pull the remote blob, merge it into
// the local caches (last-write-wins), and push the union back. The service only ever sees
// opaque ciphertext (see vault.js). Best-effort — quietly no-ops without an API key.
let vaultSyncing = false;
async function syncVaultNow() {
  if (vaultSyncing) return;
  let cfg;
  try { cfg = loadConfig(); } catch { return; }
  if (!cfg.apiKey) return;
  vaultSyncing = true;
  try {
    const r = await resolveVaultKey(cfg);
    if (r.transient) return;
    if (r.repair) {
      if (!vaultNeedsRepair) console.warn("[keeper] vault: this device needs to re-pair to get the vault password");
      vaultNeedsRepair = true;
      updateTray();
      return;
    }
    vaultNeedsRepair = false;
    await syncVault(
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      r.key,
      (remoteBlob) => mergeVaultBlob(cfg.baseUrl, remoteBlob),
      { onVersion: (v) => { vaultLastVersion = v; } },
    );
    console.log("[keeper] vault synced");
    // Cards now live only in the synced vault — once it has them, remove any legacy
    // on-disk cards.json so nothing card-related persists locally.
    dropLegacyCardsFile(cfg.baseUrl);
  } catch (e) {
    if (e instanceof VaultKeyMismatch) {
      if (!vaultNeedsRepair) console.warn("[keeper] vault:", e.message);
      vaultNeedsRepair = true;
      updateTray();
    } else {
      console.warn("[keeper] vault sync failed:", e.message);
    }
  } finally {
    vaultSyncing = false;
    reportDeviceState(); // the sync just settled our vault state — publish it if it moved
  }
}

// ---------- Device identity + vault state ----------
// What this device is and which vault it holds (device.js). Sent in `hello` on connect
// and again as `device_state` whenever it changes, so the account can list its paired
// devices and spot one stuck on the legacy v1 key model. The report is cached because
// building it derives the key id (pbkdf2 for a user password — too slow to redo on every
// tray redraw); anything that changes the vault state refreshes it.
let vaultLastVersion = null; // last vault version this device synced to
let vaultLegacyKey = false;  // cached: this device holds a legacy aesgcm-sha256-v1 key
let cachedReport = null;     // { device, vault }
let lastSentReport = "";     // JSON of the report we last put on the wire

function deviceReport({ refresh = false } = {}) {
  if (refresh || !cachedReport) {
    try {
      cachedReport = buildDeviceReport(loadConfig().baseUrl, { needsRepair: vaultNeedsRepair, version: vaultLastVersion });
      vaultLegacyKey = !!cachedReport.vault.legacy;
    } catch (e) {
      console.warn("[keeper] device report failed:", e.message);
      cachedReport = cachedReport || { device: null, vault: null };
    }
  }
  return cachedReport;
}

// Rebuild the report and, if anything actually changed, push it to the service. Cheap to
// call from every path that touches vault state — an unchanged state sends nothing.
function reportDeviceState() {
  const report = deviceReport({ refresh: true });
  if (!report.device) return;
  const json = JSON.stringify(report);
  if (json === lastSentReport) return;
  lastSentReport = json;
  safeSend({ type: "device_state", ...report });
  updateTray(); // the legacy-key warning lives in the tray menu
}

// Unattended card fill: if every requested field is a card-* kind and a saved
// card can satisfy it, answer automatically (no prompt) from cards.json. History
// (proof screenshot + field metadata, never values) is still recorded. Returns
// true when handled; false falls through to the normal prompt.
function tryAutofillCard(req) {
  const fields = Array.isArray(req.fields) ? req.fields : [];
  if (!isCardOnlyRequest(fields)) return false;
  let store;
  try { store = loadCards(cardBaseUrl()); } catch { return false; }
  if (!autofillEnabled(store)) return false; // master kill switch
  // Silent fill only on a domain the user has approved for a card.
  const host = hostFromUrl(req.url);
  const card = findCardForDomain(store, host);
  if (!card) return false; // not approved for this site → fall through to the prompt
  const values = buildCardValues(fields, card);
  if (!values) return false; // card can't fully satisfy it — let the user fill
  safeSend({ type: "fill_response", request_id: req.request_id, values });
  recordHistory(req, "autofilled");
  console.log("[keeper] card autofill (" + host + ") ->", fields.length, "field(s) for session", req.session_id || "?");
  return true;
}

// ---------- Prompt window ----------
// The prompt window is the ONLY surface a fill request can be answered from, so its
// render is supervised (issue #3: the window opened but painted nothing, and the request
// could never be approved). Three rules:
//   1. the window stays hidden until the renderer confirms the request is on screen, so
//      an empty frame is never shown;
//   2. the payload is BOTH pushed (on did-finish-load) and pulled (keeper:pending-request),
//      so no single missed event can leave the renderer with nothing to draw;
//   3. if the request is not on screen within PROMPT_RENDER_TIMEOUT_MS, that is a named,
//      visible failure and the requester is told the UI failed — never silence.
const PROMPT_RENDER_TIMEOUT_MS = Number(process.env.KEEPER_RENDER_TIMEOUT_MS) || 15000;
let promptState = null;        // { requestId, payload, loaded, rendered, timer } for the open prompt
let lastPromptFailure = null;  // { requestId, reason, at } — shown in the tray until dismissed

function showNextPrompt() {
  updateTray(); // every caller has just changed the queue — keep its pending list truthful
  if (promptWin || queue.length === 0) return;
  const requestId = queue[0];
  const req = pending.get(requestId);
  if (!req) { queue.shift(); return showNextPrompt(); }

  const fields = Array.isArray(req.fields) ? req.fields : [];
  // Offer a "use a saved card" picker when the request has any card field and
  // cards exist (e.g. auto-fill is off, or a mixed request).
  const hasCardField = fields.some((f) => String((f && f.field) || "").toLowerCase().startsWith("card-"));
  let cardOpts = [];
  if (hasCardField) { try { cardOpts = cardOptions(loadCards(cardBaseUrl())); } catch {} }
  const winHeight = Math.min(800, 260 + Math.max(1, fields.length) * 96 + (cardOpts.length ? 72 : 0));

  promptWin = new BrowserWindow({
    // Hidden until the renderer says the request is painted (keeper:prompt-rendered).
    // Showing on creation is what turned a render failure into a blank approval window.
    show: false,
    width: 480,
    height: winHeight,
    resizable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Remote Browser Keeper",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,          // renderer runs sandboxed; only the preload bridge is exposed
      webviewTag: false,
      spellcheck: false,
    },
  });
  const win = promptWin;
  const payload = {
    request_id: req.request_id,
    session_id: req.session_id,
    url: req.url || null,           // page URL being filled
    message: req.message || null,   // LLM's explanation of why
    screenshot: req.screenshot || null, // single proof image for the request
    fields,                         // [{selector,label,field,length,format}]
    cards: cardOpts,                // [{id,isDefault}] for the saved-card picker
    host: hostFromUrl(req.url || ""), // normalized site for the "remember" option
  };
  promptState = { requestId, payload, loaded: false, rendered: false, timer: null };
  promptWin.setAlwaysOnTop(true, "screen-saver");
  // The prompt only ever shows local content. Deny any attempt to navigate away
  // or open a new window (defense-in-depth on top of the renderer CSP), so no
  // server/agent-supplied string can turn into a navigation or popup.
  promptWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  promptWin.webContents.on("will-navigate", (e) => e.preventDefault());
  promptWin.webContents.on("will-redirect", (e) => e.preventDefault());
  promptWin.webContents.on("will-attach-webview", (e) => e.preventDefault());
  // Push the payload the moment the document is loaded (the renderer also pulls it on
  // mount — see keeper:pending-request). Not "ready-to-show": that fires on first paint,
  // so a window that loads but never paints would get the request never at all.
  promptWin.webContents.on("did-finish-load", () => {
    if (!promptState || promptState.requestId !== requestId) return;
    promptState.loaded = true;
    try { win.webContents.send("keeper:request", payload); } catch { /* fail-prompt below */ }
  });
  // Every way the renderer can fail to come up, named — so the cause is in the log
  // instead of being guessed at from a blank window.
  promptWin.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) failPrompt(requestId, `renderer load failed (${code} ${desc}) ${url}`);
  });
  promptWin.webContents.on("preload-error", (_e, preloadPath, err) => {
    failPrompt(requestId, `preload threw (${preloadPath}): ${(err && err.message) || err}`);
  });
  promptWin.webContents.on("render-process-gone", (_e, details) => {
    failPrompt(requestId, `renderer process gone (${(details && details.reason) || "?"})`);
  });
  loadWindow(promptWin, "prompt");
  // Nothing on screen within the deadline => the approval UI is broken, not the user
  // being slow (the user cannot even be slow yet — the window is still hidden).
  promptState.timer = setTimeout(() => {
    failPrompt(requestId, promptState && promptState.loaded
      ? "content loaded but never painted"
      : "content never finished loading");
  }, PROMPT_RENDER_TIMEOUT_MS);
  promptWin.on("closed", () => {
    if (promptState && promptState.requestId === requestId) {
      clearTimeout(promptState.timer);
      promptState = null;
    }
    // If closed without an explicit submit/cancel, treat as cancel.
    if (pending.has(requestId)) {
      recordHistory(pending.get(requestId), "cancelled");
      safeSend({ type: "fill_response", request_id: requestId, cancelled: true });
      pending.delete(requestId);
    }
    if (queue[0] === requestId) queue.shift();
    if (promptWin === win) promptWin = null; // a later prompt may already own promptWin
    showNextPrompt();
  });
}

// The renderer confirms (after an actual paint) that the request is on screen. Only then
// is the window shown, so the user never sees an empty approval window, and the render
// watchdog stands down.
ipcMain.on("keeper:prompt-rendered", (e, { request_id } = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!promptState || !win || win !== promptWin || promptState.requestId !== request_id) return;
  if (promptState.rendered) return;
  promptState.rendered = true;
  clearTimeout(promptState.timer);
  promptState.timer = null;
  promptWin.show();
  promptWin.focus();
  try { shell.beep(); } catch { /* play the OS alert sound to announce the prompt */ }
});
// Pull side of the delivery: the prompt renderer asks for the request it must draw, so
// it does not depend on having been listening when main pushed it.
ipcMain.handle("keeper:pending-request", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!promptState || !win || win !== promptWin) return null;
  return promptState.payload;
});

// A prompt that never made it onto the screen. Name the cause, make it visible (log +
// tray + History), and tell the service the APPROVAL UI failed — a distinct outcome from
// "the user did not answer", so an automation can stop instead of retrying a login into
// an account lockout.
function failPrompt(requestId, reason) {
  if (!promptState || promptState.requestId !== requestId || promptState.rendered) return;
  console.error("[keeper] approval window failed to render:", reason, "— request", requestId);
  if (CONTENT_PROTECTION) {
    console.error("[keeper] screen-capture protection is ON for this window;"
      + " re-run with KEEPER_NO_CONTENT_PROTECTION=1 to rule it in or out as the cause");
  }
  lastPromptFailure = { requestId, reason, at: new Date().toISOString() };
  const req = pending.get(requestId);
  if (req) {
    recordHistory(req, "ui_failed");
    safeSend({ type: "fill_response", request_id: requestId, cancelled: true, error: "keeper_ui_failed", reason });
    pending.delete(requestId);
  }
  if (queue[0] === requestId) queue.shift();
  const w = promptWin;
  promptWin = null;
  clearTimeout(promptState.timer);
  promptState = null;
  if (w && !w.isDestroyed()) w.destroy(); // its "closed" handler is now a no-op (nothing pending)
  updateTray();
  showNextPrompt();
}

// Bring a queued request to the front: the tray lists everything awaiting approval, so a
// window that failed (or was lost behind something) never means restarting the app.
function focusRequest(requestId) {
  if (!pending.has(requestId)) return;
  if (promptWin) {
    // One prompt at a time: surface the open one, and make this request the next in line.
    if (queue[0] !== requestId) {
      const i = queue.indexOf(requestId);
      if (i > 0) { queue.splice(i, 1); queue.splice(1, 0, requestId); }
    }
    // Never force a not-yet-painted window on screen — that is the blank window again.
    // It appears by itself the moment it renders, or fails loudly (failPrompt).
    if (promptState && promptState.rendered) { promptWin.show(); promptWin.focus(); }
    return;
  }
  const i = queue.indexOf(requestId);
  if (i > 0) { queue.splice(i, 1); queue.unshift(requestId); }
  showNextPrompt();
}

function resolveRequest(requestId, payload) {
  if (!pending.has(requestId)) return;
  recordHistory(pending.get(requestId), payload.cancelled ? "cancelled" : "submitted");
  safeSend({ type: "fill_response", request_id: requestId, ...payload });
  pending.delete(requestId);
  if (queue[0] === requestId) queue.shift();
  if (promptWin) { const w = promptWin; promptWin = null; w.close(); }
  showNextPrompt();
}

// Drop a request that was resolved elsewhere (another keeper answered it, or it timed
// out). Unlike resolveRequest, we do NOT send a fill_response — the server is no longer
// waiting on us. Removing it from `pending` first stops the prompt's closed-handler from
// firing a spurious cancel.
function dismissRequest(requestId) {
  if (!pending.has(requestId) && queue.indexOf(requestId) === -1) return; // not ours / already gone
  const wasCurrent = queue[0] === requestId;
  pending.delete(requestId);
  const i = queue.indexOf(requestId);
  if (i !== -1) queue.splice(i, 1);
  if (wasCurrent && promptWin) { const w = promptWin; promptWin = null; w.close(); }
  showNextPrompt();
}

ipcMain.on("keeper:submit", (_e, { request_id, values }) => {
  resolveRequest(request_id, { values: Array.isArray(values) ? values : [] });
});
ipcMain.on("keeper:cancel", (_e, { request_id }) => {
  resolveRequest(request_id, { cancelled: true });
});
// Prompt asks for a saved card's values mapped onto the pending request's fields
// (when the user picks a card to pre-fill). Values stay local; the user reviews
// and sends. Returns [{selector,value}].
ipcMain.handle("keeper:card-values", (_e, { request_id, card_id } = {}) => {
  try {
    const req = pending.get(request_id);
    if (!req) return [];
    const card = (loadCards(cardBaseUrl()).cards || {})[card_id];
    if (!card) return [];
    return mapCardToFields(card, Array.isArray(req.fields) ? req.fields : []);
  } catch {
    return [];
  }
});
// "Auto-fill on this site next time": approve the request's domain for the chosen
// card and persist it. Future requests from that domain fill silently.
ipcMain.handle("keeper:remember-card-domain", (_e, { request_id, card_id } = {}) => {
  try {
    const req = pending.get(request_id);
    if (!req) return { ok: false };
    const host = hostFromUrl(req.url);
    if (!host) return { ok: false };
    const base = cardBaseUrl();
    const store = loadCards(base);
    if (approveDomain(store, card_id, host)) { saveCards(base, store); void syncVaultNow(); }
    return { ok: true, host };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// "Allow for all sites": approve the chosen card for every site (wildcard).
ipcMain.handle("keeper:remember-card-all-sites", (_e, { card_id } = {}) => {
  try {
    const base = cardBaseUrl();
    const store = loadCards(base);
    if (approveAllSites(store, card_id)) { saveCards(base, store); void syncVaultNow(); }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------- History window ----------
function openHistoryWindow() {
  if (historyWin) { historyWin.show(); historyWin.focus(); return; }
  historyWin = new BrowserWindow({
    width: 540,
    height: 660,
    resizable: true,
    fullscreenable: false,
    title: "Remote Browser Keeper — History",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "history-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  historyWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  historyWin.webContents.on("will-navigate", (e) => e.preventDefault());
  historyWin.webContents.on("will-redirect", (e) => e.preventDefault());
  loadWindow(historyWin, "history");
  historyWin.once("ready-to-show", () => {
    void sendHistory();
    historyWin.show();
    historyWin.focus();
  });
  historyWin.on("closed", () => { historyWin = null; });
}

function pushHistory(payload) {
  if (historyWin && !historyWin.isDestroyed()) historyWin.webContents.send("history:data", payload);
}

// Paint the local log at once, then repaint with the union as soon as the service's
// list lands (or fails). The window therefore never waits on the network: offline it
// just stays local-only, with the reason shown. A newer refresh cancels an older one's
// second paint so a slow response can't overwrite a fresher list.
let historySeq = 0;
async function sendHistory() {
  const seq = ++historySeq;
  pushHistory({ items: mergeHistory(readHistory(), []), server: { state: "loading" } });
  let r;
  try { r = await fetchServerHistory(loadConfig()); }
  catch (e) { r = { ok: false, requests: [], error: e.message }; } // loadConfig threw
  if (seq !== historySeq || !historyWin) return;
  pushHistory({
    items: mergeHistory(readHistory(), r.requests),
    server: r.ok ? { state: "ok", count: r.requests.length } : { state: "error", error: r.error },
  });
}

ipcMain.on("history:refresh", () => { void sendHistory(); });
// The proof image, from wherever it survives: this device's JPEG first (no network),
// else the service's copy — a request answered on another device, or one whose local
// file was evicted, still shows its screenshot. null = neither side has it.
ipcMain.handle("history:screenshot", async (_e, id) => {
  const sid = safeId(id);
  if (!sid) return null;
  try {
    return "data:image/jpeg;base64," + fs.readFileSync(screenshotFile(sid)).toString("base64");
  } catch { /* not on this device — the service may still hold the proof */ }
  try { return await fetchServerScreenshot(loadConfig(), sid); } catch { return null; }
});

// ---------- Cards window (manage saved cards for auto-fill) ----------
let cardsWin = null;
function openCardsWindow() {
  if (cardsWin) { cardsWin.show(); cardsWin.focus(); return; }
  cardsWin = new BrowserWindow({
    width: 560,
    height: 720,
    resizable: true,
    fullscreenable: false,
    title: "Remote Browser Keeper — Cards",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "cards-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  cardsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  cardsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  cardsWin.webContents.on("will-redirect", (e) => e.preventDefault());
  loadWindow(cardsWin, "cards");
  cardsWin.once("ready-to-show", () => { cardsWin.show(); cardsWin.focus(); });
  cardsWin.on("closed", () => { cardsWin = null; });
}

let savedFieldsWin = null;
function openSavedFieldsWindow() {
  if (savedFieldsWin) { savedFieldsWin.show(); savedFieldsWin.focus(); return; }
  savedFieldsWin = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: true,
    fullscreenable: false,
    title: "Remote Browser Keeper — Saved fields",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "savedfields-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  savedFieldsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  savedFieldsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  savedFieldsWin.webContents.on("will-redirect", (e) => e.preventDefault());
  loadWindow(savedFieldsWin, "savedfields");
  savedFieldsWin.once("ready-to-show", () => { savedFieldsWin.show(); savedFieldsWin.focus(); });
  savedFieldsWin.on("closed", () => { savedFieldsWin = null; });
}
ipcMain.handle("fields:list", () => {
  try { return listSaved(loadConfig().baseUrl); } catch { return []; }
});
// Reveal a single saved value on demand (e.g. to read a generated password you never
// saw). The value stays local — returned only to this window's renderer, never the AI.
ipcMain.handle("fields:reveal", (_e, { session, host, selector } = {}) => {
  try {
    const s = getSaved(loadConfig().baseUrl, session, host, selector);
    return { ok: true, value: s ? s.value : null };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("fields:forget", (_e, { session, host, selector } = {}) => {
  try {
    const { baseUrl } = loadConfig();
    const wasVault = getSaved(baseUrl, session, host, selector)?.scope === "vault";
    forgetField(baseUrl, session, host, selector);
    if (wasVault) void syncVaultNow(); // propagate the tombstone to other devices
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("fields:forget-all", () => {
  try { forgetAllFields(loadConfig().baseUrl); void syncVaultNow(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

let pairWin = null;
function openPairWindow() {
  if (pairWin) { pairWin.show(); pairWin.focus(); return; }
  pairWin = new BrowserWindow({
    width: 380,
    height: 520,
    resizable: false,
    fullscreenable: false,
    title: "Remote Browser Keeper — Pair phone",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "pair-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  pairWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pairWin.webContents.on("will-navigate", (e) => e.preventDefault());
  pairWin.webContents.on("will-redirect", (e) => e.preventDefault());
  loadWindow(pairWin, "pair");
  pairWin.once("ready-to-show", () => { pairWin.show(); pairWin.focus(); });
  pairWin.on("closed", () => { pairWin = null; });
}

let vaultPwWin = null;
function openVaultPwWindow() {
  if (vaultPwWin) { vaultPwWin.show(); vaultPwWin.focus(); return; }
  vaultPwWin = new BrowserWindow({
    width: 400,
    height: 360,
    resizable: false,
    fullscreenable: false,
    title: "Remote Browser Keeper — Vault password",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "vaultpw-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  vaultPwWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  vaultPwWin.webContents.on("will-navigate", (e) => e.preventDefault());
  vaultPwWin.webContents.on("will-redirect", (e) => e.preventDefault());
  loadWindow(vaultPwWin, "vaultpw");
  vaultPwWin.once("ready-to-show", () => { vaultPwWin.show(); vaultPwWin.focus(); });
  vaultPwWin.on("closed", () => { vaultPwWin = null; });
}

let settingsWin = null;
function openSettingsWindow() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 500, // fits the "This device" panel above the preferences without scrolling
    resizable: false,
    fullscreenable: false,
    title: "Remote Browser Keeper — Settings",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  settingsWin.webContents.on("will-redirect", (e) => e.preventDefault());
  loadWindow(settingsWin, "settings");
  settingsWin.once("ready-to-show", () => { settingsWin.show(); settingsWin.focus(); });
  settingsWin.on("closed", () => { settingsWin = null; });
}
// Per-device Keeper preferences (see settings.js). Non-secret; local-only.
ipcMain.handle("keeper:get-settings", () => {
  try { return { ok: true, settings: loadSettings(loadConfig().baseUrl) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("keeper:set-settings", (_e, patch = {}) => {
  try { return { ok: true, settings: saveSettings(loadConfig().baseUrl, patch) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Encode the connection config into a QR image. The token lives only inside the
// returned image — it is never sent to the renderer as text.
ipcMain.handle("pair:qr", async () => {
  try {
    const { baseUrl, apiKey } = loadConfig();
    if (!apiKey) return { error: "No API key configured for this Keeper." };
    // Hand the paired device the session `secret` (for zero-knowledge session unlock)
    // AND the dedicated vault password (so it can decrypt the synced vault, item 2).
    // Both live ONLY inside the QR image — never sent to the renderer as text or a URL.
    let secret = null;
    try { secret = createSecretStore({ baseUrl }).firstSecret(); } catch { /* none held */ }
    let vault = null;
    try { vault = vaultKeyForPairing(baseUrl); } catch { /* none */ }
    const payload = JSON.stringify({ app: "rbkeeper", v: 1, url: baseUrl, key: apiKey, ...(secret ? { secret } : {}), ...(vault ? { vault } : {}) });
    const dataUrl = await QRCode.toDataURL(payload, { margin: 1, scale: 8, errorCorrectionLevel: "M" });
    let host = baseUrl;
    try { host = new URL(baseUrl).host; } catch { /* keep raw */ }
    return { dataUrl, host };
  } catch (e) {
    return { error: e.message };
  }
});

// Vault key status for the UI: whether a key is held, whether it's a custom (user)
// password, and whether this device is out of sync (needs re-pair).
ipcMain.handle("keeper:vault-status", () => {
  try {
    const { baseUrl } = loadConfig();
    const k = loadVaultKey(baseUrl);
    return { ok: true, hasKey: !!k, custom: !!(k && k.format === "aesgcm-pbkdf2-v2"), needsRepair: vaultNeedsRepair };
  } catch (e) { return { ok: false, error: e.message }; }
});

// The same identity + vault state we report to the service, for the Settings window — so
// "what is this device on?" is answerable without asking the service. Inert metadata: no
// password, no key, and (per vaultKeyReport) no secret_id for a legacy v1 key.
ipcMain.handle("keeper:device-info", () => {
  try {
    const report = deviceReport();
    if (!report.device) return { ok: false, error: "device report unavailable" };
    return { ok: true, ...report };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Item 3: set a user-chosen vault password. Reads the current vault under the current
// key, re-encrypts it under the new password (pbkdf2), and re-uploads — so no data is
// lost. Other paired devices then see a secret_id mismatch and must re-pair to resync.
ipcMain.handle("keeper:set-vault-password", async (_e, { password } = {}) => {
  try {
    const cfg = loadConfig();
    if (!cfg.apiKey) return { ok: false, error: "No API key configured." };
    const pw = String(password || "");
    if (pw.length < 8) return { ok: false, error: "Use at least 8 characters." };
    if (vaultNeedsRepair) return { ok: false, error: "This device is out of sync — re-pair it first." };
    const conn = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey };
    const oldKey = loadVaultKey(cfg.baseUrl) || ensureVaultKey(cfg.baseUrl);
    let current;
    try { current = await pullVault(conn, oldKey); }
    catch (e) {
      if (e instanceof VaultKeyMismatch) return { ok: false, error: "This device is out of sync — re-pair it first." };
      return { ok: false, error: e.message };
    }
    const newKey = userVaultKey(pw);
    const put = await putVault(conn, newKey, current.data || emptyVault(), current.version);
    if (put.conflict) return { ok: false, error: "Vault changed during re-key — try again." };
    saveVaultKey(cfg.baseUrl, newKey);
    vaultLastVersion = Number(put.version) || vaultLastVersion;
    reportDeviceState(); // new key format + new vault id — tell the service which vault we're on now
    console.log("[keeper] vault re-keyed to a custom password (pbkdf2-v2); other devices must re-pair");
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("cards:load", () => loadCards(cardBaseUrl()));
ipcMain.handle("cards:storage-info", () => ({ encrypted: secureStorageAvailable(), platform: process.platform }));
ipcMain.handle("cards:save", (_e, store) => {
  try {
    if (!store || typeof store !== "object") throw new Error("invalid store");
    saveCards(cardBaseUrl(), store);
    void syncVaultNow(); // propagate the card add/edit/delete to other devices
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------- Image viewer (full / natural size) ----------
let imageWin = null;
function openImageWindow(dataUrl) {
  if (typeof dataUrl !== "string" || !/^data:image\//.test(dataUrl)) return;
  if (imageWin) {
    imageWin.webContents.send("image:data", dataUrl);
    imageWin.show();
    imageWin.focus();
    return;
  }
  imageWin = new BrowserWindow({
    width: 820,
    height: 640,
    resizable: true,
    title: "Remote Browser Keeper — Screenshot",
    backgroundColor: "#070A12",
    webPreferences: {
      preload: path.join(__dirname, "image-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  imageWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  imageWin.webContents.on("will-navigate", (e) => e.preventDefault());
  imageWin.webContents.on("will-redirect", (e) => e.preventDefault());
  loadWindow(imageWin, "image");
  imageWin.once("ready-to-show", () => {
    imageWin.webContents.send("image:data", dataUrl);
    imageWin.show();
    imageWin.focus();
  });
  imageWin.on("closed", () => { imageWin = null; });
}
// The prompt renderer reports its content height; fit the window to it (keep the
// width, cap to the screen) so there's no empty space or clipped content.
ipcMain.on("keeper:resize", (e, height) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win !== promptWin || !Number.isFinite(height) || height < 1) return;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const [w] = win.getContentSize();
  const ch = Math.max(160, Math.min(Math.round(height), area.height - 80));
  win.setContentSize(w, ch);
});
// Silent fill when EVERY field of the request has a saved value marked "don't ask
// again" (auto). Otherwise return false → the prompt shows (prefilling what's saved).
// Unattended password generation: when EVERY field of a request is a `generate` field,
// the Keeper creates each value itself (genpassword.js policy), fills them, and saves them
// — no prompt. The generated password is never shown to the user, so it's saved to the
// synced vault by default (falling back to on-device if no vault key) with auto-fill on,
// so it's backed up / available on other devices and refillable. To have the user enter a
// password manually instead, the agent sends a normal (non-generate) request_fill, which
// prompts as usual. Mixed requests (some generate, some not) also fall through to the
// prompt (with the generated fields prefilled).
function tryAutofillGenerate(req) {
  const fields = Array.isArray(req.fields) ? req.fields : [];
  if (!fields.length || !fields.every((f) => f && f.generate)) return false;
  let baseUrl;
  try { baseUrl = loadConfig().baseUrl; } catch { return false; }
  // Opt-out: when the user turned on "show the password window", generation isn't silent —
  // fall through to the prompt so they can review/edit the generated value before it fills.
  try { if (loadSettings(baseUrl).generateShowWindow) return false; } catch { /* default: unattended */ }
  const host = hostFromUrl(req.url || "");
  let vaultKey = null;
  try { vaultKey = loadVaultKey(baseUrl); } catch { /* ignore */ }
  const scope = vaultKey ? "vault" : "forever";
  // Shared per kind so "Password" + "Confirm password" in one request match.
  const shared = generateSharedValues(fields);
  const values = [];
  for (const f of fields) {
    const value = shared.get(f.selector);
    values.push({ selector: f.selector, value });
    if (host) saveValue(baseUrl, req.session_id, host, f.selector, value, scope, true); // auto-fill next time
  }
  safeSend({ type: "fill_response", request_id: req.request_id, values });
  if (scope === "vault" && host) void syncVaultNow();
  recordHistory(req, "autofilled");
  logGenerated(req, fields, shared, host, scope);
  return true;
}

// What was generated, for the Keeper's own log. Details (selector, length,
// charset, where it was saved) are always logged; the VALUE is not.
//
// Writing a freshly generated password into a log file would undo the point of a
// password manager — logs get tailed, copied into bug reports, and backed up. So
// the plaintext is opt-in per run: launch with KEEPER_LOG_PASSWORDS=1 when you
// deliberately want to read a generated password off the console. To see one
// WITHOUT that, use "Saved fields…" in the tray and click reveal.
const LOG_PASSWORDS = process.env.KEEPER_LOG_PASSWORDS === "1";
function logGenerated(req, fields, shared, host, scope) {
  const distinct = new Set(shared.values()).size;
  console.log(
    "[keeper] generated " + distinct + " value(s) for " + fields.length + " field(s)"
    + " (" + scope + ") host=" + (host || "?") + " session=" + (req.session_id || "?")
    + (distinct === 1 && fields.length > 1 ? " [shared — password + confirmation]" : ""),
  );
  for (const f of fields) {
    const value = shared.get(f.selector) || "";
    const shape = (isNumericField(f) ? "digits" : "a-zA-Z0-9"
      + (f.symbols === false ? "" : "+symbols")) + " len=" + value.length;
    console.log("[keeper]   " + (f.selector || "?") + " -> " + shape
      + (LOG_PASSWORDS ? " value=" + value : " (set KEEPER_LOG_PASSWORDS=1 to log the value)"));
  }
}

function tryAutofillFields(req) {
  const fields = Array.isArray(req.fields) ? req.fields : [];
  if (!fields.length) return false;
  let baseUrl;
  try { baseUrl = loadConfig().baseUrl; } catch { return false; }
  const host = hostFromUrl(req.url || "");
  const values = [];
  for (const f of fields) {
    const s = getSaved(baseUrl, req.session_id, host, f.selector);
    if (!s || !s.auto || s.value == null) return false; // not all auto-fillable → prompt
    values.push({ selector: f.selector, value: s.value });
  }
  safeSend({ type: "fill_response", request_id: req.request_id, values });
  recordHistory(req, "autofilled");
  console.log("[keeper] field autofill (" + host + ") ->", fields.length, "field(s) for session", req.session_id || "?");
  return true;
}

// Saved field values: return any previously-saved values for this request's
// fields (so the prompt prefills them), and save the submitted values per scope.
ipcMain.handle("keeper:saved-values", (_e, { request_id } = {}) => {
  try {
    const req = pending.get(request_id);
    if (!req) return [];
    const { baseUrl } = loadConfig();
    const host = hostFromUrl(req.url || "");
    const out = [];
    for (const f of (req.fields || [])) {
      const s = getSaved(baseUrl, req.session_id, host, f.selector);
      if (s) out.push({ selector: f.selector, value: s.value, scope: s.scope, auto: s.auto });
    }
    return out;
  } catch {
    return [];
  }
});
ipcMain.handle("keeper:save-fields", (_e, { request_id, values, scope, auto } = {}) => {
  try {
    if (!Array.isArray(values) || !["session", "forever", "vault", "forget"].includes(scope)) return { ok: false };
    const req = pending.get(request_id);
    if (!req) return { ok: false };
    const { baseUrl } = loadConfig();
    const host = hostFromUrl(req.url || "");
    let touchedVault = scope === "vault";
    for (const v of values) {
      if (!v || !v.selector) continue;
      if (scope === "forget") {
        // A forget may tombstone a vault entry, so it too needs a push.
        if (getSaved(baseUrl, req.session_id, host, v.selector)?.scope === "vault") touchedVault = true;
        forgetField(baseUrl, req.session_id, host, v.selector);
      } else if (v.value) {
        saveValue(baseUrl, req.session_id, host, v.selector, v.value, scope, auto);
      }
    }
    if (touchedVault) void syncVaultNow(); // push the new/removed vault entry to other devices
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.on("keeper:view-image", (_e, dataUrl) => openImageWindow(dataUrl));
// The viewer reports the image's natural size; fit the window to it (capped to
// the screen work area) so the user sees it at normal size.
ipcMain.on("image:sized", (e, w, h) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const cw = Math.max(320, Math.min(Math.round(w) + 32, area.width - 80));
  const ch = Math.max(240, Math.min(Math.round(h) + 32, area.height - 120));
  win.setContentSize(cw, ch);
  win.center();
});

// ---------- Tray ----------
function serviceHost() {
  try { return new URL(loadConfig().baseUrl).host; } catch { return loadConfig().baseUrl; }
}

// Requests awaiting the user, straight in the tray menu: a second way to reach a pending
// approval that doesn't depend on the prompt window being on screen (or having rendered).
function pendingMenuItems() {
  const items = [];
  for (const id of queue) {
    const req = pending.get(id);
    if (!req) continue;
    const where = hostFromUrl(req.url || "") || req.session_id || "request";
    items.push({ label: `Approve: ${where}`, click: () => focusRequest(id) });
  }
  if (!items.length) return [];
  return [{ label: `Waiting for you (${items.length})`, enabled: false }, ...items, { type: "separator" }];
}

function updateTray() {
  if (!tray) return;
  const host = serviceHost();
  const state = connected ? "connected" : "reconnecting…";
  tray.setToolTip(`Remote Browser Keeper — ${state} · ${host}`);
  // A render failure is announced in the menu bar itself, since the surface that would
  // normally tell the user (the prompt window) is the thing that just failed.
  if (process.platform === "darwin") tray.setTitle(lastPromptFailure ? "⚠︎" : trayFallbackTitle);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Service: ${host}`, enabled: false },
    // Use colored emoji dots: a plain "●" inherits the (gray) disabled-item text
    // color, so it always looks gray. 🟢/🟡 render in color regardless of state.
    { label: connected ? "🟢 Connected" : "🟡 Reconnecting…", enabled: false },
    { type: "separator" },
    ...(lastPromptFailure ? [{
      label: `⚠︎ Approval window failed to render (${lastPromptFailure.reason}) — click to dismiss`,
      click: () => { lastPromptFailure = null; updateTray(); },
    }, { type: "separator" }] : []),
    ...pendingMenuItems(),
    { label: "Cards…", click: openCardsWindow },
    { label: "Saved fields…", click: openSavedFieldsWindow },
    { label: "History…", click: openHistoryWindow },
    { type: "separator" },
    { label: "Pair phone…", click: openPairWindow },
    { label: "Set vault password…", click: openVaultPwWindow },
    { label: "Settings…", click: openSettingsWindow },
    ...(vaultNeedsRepair ? [{ label: "⚠︎ Vault: re-pair to update password", enabled: false }] : []),
    // A device left on the v1 key model is a real exposure (v1's stored id IS the key),
    // so name it in the menu bar. Setting a vault password re-encrypts onto v2.
    ...(vaultLegacyKey ? [{ label: "⚠︎ Vault: legacy v1 key — set a vault password to migrate", click: openVaultPwWindow }] : []),
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

let trayFallbackTitle = ""; // "🔑" only when the icon asset failed to load
function createTray() {
  // A monochrome template image (black + alpha) — macOS renders it white on the dark
  // menu bar and dark in light mode, matching the system icons. @2x is picked up
  // automatically for Retina. createFromPath loads the bundled asset under src/assets.
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  // Fall back to the text glyph only if the image failed to load.
  if (icon.isEmpty()) trayFallbackTitle = "🔑";
  updateTray();
}

// Exclude EVERY Keeper window from screen capture: screenshots, screen recording, screen
// sharing, and window-content/thumbnail readers (macOS AltTab, Mission Control previews)
// see the window as blank. Keeps secrets on screen — entered passwords, revealed values,
// card numbers, the pair QR (which carries the token + vault password) — from leaking to
// other apps. setContentProtection maps to NSWindowSharingNone (macOS) / SetWindowDisplay-
// Affinity (Windows); no-op on Linux. Registered once so it applies to current + future
// windows. (Trade-off: the user's own screenshots/screen-shares of the Keeper are blank too.)
//
// KEEPER_NO_CONTENT_PROTECTION=1 turns it OFF for one run. It exists ONLY to rule content
// protection in or out when a window won't paint (issue #3): the protection is on by
// default and dropping it is a security regression, so this is a diagnostic switch, not a
// supported mode — it is loud in the log while it is in effect.
const CONTENT_PROTECTION = process.env.KEEPER_NO_CONTENT_PROTECTION !== "1";
app.on("browser-window-created", (_e, win) => {
  if (!CONTENT_PROTECTION) {
    console.warn("[keeper] SECURITY: KEEPER_NO_CONTENT_PROTECTION=1 — this window IS capturable"
      + " by screenshots/screen sharing; diagnostic use only");
    return;
  }
  try { win.setContentProtection(true); } catch { /* ignore where unsupported */ }
});

// ---------- App lifecycle (tray-only; no window until a request) ----------
app.whenReady().then(() => {
  if (app.dock) app.dock.hide(); // no dock icon; live in the tray/menu bar
  createTray();
  connect();

  if (process.env.KEEPER_TEST === "1") {
    const id = "test-" + Date.now();
    pending.set(id, { request_id: id, session_id: "demo", label: "Password for example.com (TEST)", field: "password" });
    queue.push(id);
    showNextPrompt();
  }
});

app.on("window-all-closed", (e) => { e?.preventDefault?.(); /* stay alive in tray */ });
app.on("before-quit", () => { app.isQuitting = true; try { ws && ws.close(); } catch {} });
