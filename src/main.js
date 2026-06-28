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
import { loadCards, saveCards, autofillEnabled, isCardOnlyRequest, buildCardValues, cardOptions, mapCardToFields, hostFromUrl, findCardForDomain, approveDomain, approveAllSites } from "./cards.js";
import { available as secureStorageAvailable } from "./securestore.js";
import { getSaved, saveValue, forget as forgetField, listSaved, forgetAll as forgetAllFields } from "./fieldstore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Renderer is built by Vite to ../renderer-dist (one HTML per window). With
// KEEPER_DEV=1, load from the Vite dev server instead for hot-reload.
const KEEPER_DEV = process.env.KEEPER_DEV === "1";
function loadWindow(win, name) {
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
    safeSend({ type: "hello", app: "remote-browser-keeper", version: app.getVersion() });
    startHeartbeat();
    updateTray();
    console.log("[keeper] connected");
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
function showNextPrompt() {
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
  promptWin.setAlwaysOnTop(true, "screen-saver");
  // The prompt only ever shows local content. Deny any attempt to navigate away
  // or open a new window (defense-in-depth on top of the renderer CSP), so no
  // server/agent-supplied string can turn into a navigation or popup.
  promptWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  promptWin.webContents.on("will-navigate", (e) => e.preventDefault());
  promptWin.webContents.on("will-redirect", (e) => e.preventDefault());
  promptWin.webContents.on("will-attach-webview", (e) => e.preventDefault());
  loadWindow(promptWin, "prompt");
  promptWin.once("ready-to-show", () => {
    promptWin.webContents.send("keeper:request", {
      request_id: req.request_id,
      session_id: req.session_id,
      url: req.url || null,           // page URL being filled
      message: req.message || null,   // LLM's explanation of why
      screenshot: req.screenshot || null, // single proof image for the request
      fields,                         // [{selector,label,field,length,format}]
      cards: cardOpts,                // [{id,isDefault}] for the saved-card picker
      host: hostFromUrl(req.url || ""), // normalized site for the "remember" option
    });
    promptWin.show();
    promptWin.focus();
    try { shell.beep(); } catch { /* play the OS alert sound to announce the prompt */ }
  });
  promptWin.on("closed", () => {
    // If closed without an explicit submit/cancel, treat as cancel.
    if (pending.has(requestId)) {
      recordHistory(pending.get(requestId), "cancelled");
      safeSend({ type: "fill_response", request_id: requestId, cancelled: true });
      pending.delete(requestId);
    }
    if (queue[0] === requestId) queue.shift();
    promptWin = null;
    showNextPrompt();
  });
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
    if (approveDomain(store, card_id, host)) saveCards(base, store);
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
    if (approveAllSites(store, card_id)) saveCards(base, store);
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
    historyWin.webContents.send("history:data", readHistory());
    historyWin.show();
    historyWin.focus();
  });
  historyWin.on("closed", () => { historyWin = null; });
}

ipcMain.on("history:refresh", () => {
  if (historyWin) historyWin.webContents.send("history:data", readHistory());
});
ipcMain.handle("history:screenshot", (_e, id) => {
  const sid = safeId(id);
  if (!sid) return null;
  try {
    return "data:image/jpeg;base64," + fs.readFileSync(screenshotFile(sid)).toString("base64");
  } catch { return null; }
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
ipcMain.handle("fields:forget", (_e, { session, host, selector } = {}) => {
  try { forgetField(loadConfig().baseUrl, session, host, selector); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("fields:forget-all", () => {
  try { forgetAllFields(loadConfig().baseUrl); return { ok: true }; }
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
// Encode the connection config into a QR image. The token lives only inside the
// returned image — it is never sent to the renderer as text.
ipcMain.handle("pair:qr", async () => {
  try {
    const { baseUrl, apiKey } = loadConfig();
    if (!apiKey) return { error: "No API key configured for this Keeper." };
    const payload = JSON.stringify({ app: "rbkeeper", v: 1, url: baseUrl, key: apiKey });
    const dataUrl = await QRCode.toDataURL(payload, { margin: 1, scale: 8, errorCorrectionLevel: "M" });
    let host = baseUrl;
    try { host = new URL(baseUrl).host; } catch { /* keep raw */ }
    return { dataUrl, host };
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle("cards:load", () => loadCards(cardBaseUrl()));
ipcMain.handle("cards:storage-info", () => ({ encrypted: secureStorageAvailable(), platform: process.platform }));
ipcMain.handle("cards:save", (_e, store) => {
  try {
    if (!store || typeof store !== "object") throw new Error("invalid store");
    saveCards(cardBaseUrl(), store);
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
    if (!Array.isArray(values) || !["session", "forever", "forget"].includes(scope)) return { ok: false };
    const req = pending.get(request_id);
    if (!req) return { ok: false };
    const { baseUrl } = loadConfig();
    const host = hostFromUrl(req.url || "");
    for (const v of values) {
      if (!v || !v.selector) continue;
      if (scope === "forget") forgetField(baseUrl, req.session_id, host, v.selector);
      else if (v.value) saveValue(baseUrl, req.session_id, host, v.selector, v.value, scope, auto);
    }
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

function updateTray() {
  if (!tray) return;
  const host = serviceHost();
  const state = connected ? "connected" : "reconnecting…";
  tray.setToolTip(`Remote Browser Keeper — ${state} · ${host}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Service: ${host}`, enabled: false },
    // Use colored emoji dots: a plain "●" inherits the (gray) disabled-item text
    // color, so it always looks gray. 🟢/🟡 render in color regardless of state.
    { label: connected ? "🟢 Connected" : "🟡 Reconnecting…", enabled: false },
    { type: "separator" },
    { label: "Cards…", click: openCardsWindow },
    { label: "Saved fields…", click: openSavedFieldsWindow },
    { label: "History…", click: openHistoryWindow },
    { type: "separator" },
    { label: "Pair phone…", click: openPairWindow },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  // A monochrome template image (black + alpha) — macOS renders it white on the dark
  // menu bar and dark in light mode, matching the system icons. @2x is picked up
  // automatically for Retina. createFromPath loads the bundled asset under src/assets.
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  // Fall back to the text glyph only if the image failed to load.
  if (process.platform === "darwin" && icon.isEmpty()) tray.setTitle("🔑");
  updateTray();
}

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
