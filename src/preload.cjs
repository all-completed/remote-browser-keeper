// The ONE preload, for the ONE window (issue #28). Every page of ui/App.jsx talks to the
// main process through the bridges below — the same names the separate windows used to
// get from their own preloads, so each page's calls are unchanged. Main still checks the
// sender of every message (src/ipcsender.js): the main window's top frame, showing our own
// app.html. No Node access in the renderer.
//
// Secrets stay in main wherever they can: the pair QR's token and vault password live only
// inside the image main draws, the headless unlock key is sealed in main, and a saved value
// crosses only when the user presses Reveal.
const { contextBridge, ipcRenderer } = require("electron");

// The window itself: which page to show, and the connection/queue state for the sidebar.
contextBridge.exposeInMainWorld("keeperApp", {
  state: () => ipcRenderer.invoke("app:state"),
  onNavigate: (cb) => ipcRenderer.on("app:navigate", (_e, page) => cb(page)),
  onStatus: (cb) => ipcRenderer.on("app:status", (_e, status) => cb(status)),
  // The user moved to another page in the sidebar.
  page: (page) => ipcRenderer.send("app:page", page),
  // Dismiss an in-app warning ("promptFailure" | "undelivered").
  dismiss: (what) => ipcRenderer.send("app:dismiss", what),
});

// Approvals — fill requests. The secret value is passed from the renderer to main (which
// forwards it to the service) and never leaves the local machine except over the
// authenticated keeper WS.
contextBridge.exposeInMainWorld("keeper", {
  onRequest: (cb) => ipcRenderer.on("keeper:request", (_e, req) => cb(req)),
  // Main dropped the request on screen (answered elsewhere, expired, failed to render).
  onRequestGone: (cb) => ipcRenderer.on("keeper:request-gone", (_e, m) => cb(m)),
  // Pull the request to draw instead of only waiting to be handed one, and report back
  // once it is painted. Main keeps a window the request brought up hidden until that
  // report arrives, so it can never be on screen with nothing in it (issue #3).
  pendingRequest: () => ipcRenderer.invoke("keeper:pending-request"),
  rendered: (request_id) => ipcRenderer.send("keeper:prompt-rendered", { request_id }),
  // The request's deadline passed (issue #12) — reported both ways, for the same reason
  // the payload is pushed AND pulled: main's timer can be late on a machine that slept
  // through it, the renderer's countdown can be up to a tick behind main, and whichever
  // notices first must retire the prompt.
  onExpired: (cb) => ipcRenderer.on("keeper:expired", (_e, m) => cb(m)),
  reportExpired: (request_id) => ipcRenderer.send("keeper:prompt-expired", { request_id }),
  submit: (request_id, values) => ipcRenderer.send("keeper:submit", { request_id, values }),
  // `reason` is the user's optional plain-text note on a decline ("wrong account", "I did
  // it myself") — it IS shown to the agent, so it is never a value. Omitted on a plain tap.
  cancel: (request_id, reason) => ipcRenderer.send("keeper:cancel", { request_id, reason }),
  cardValues: (request_id, card_id) => ipcRenderer.invoke("keeper:card-values", { request_id, card_id }),
  rememberCardDomain: (request_id, card_id) => ipcRenderer.invoke("keeper:remember-card-domain", { request_id, card_id }),
  rememberCardAllSites: (request_id, card_id) => ipcRenderer.invoke("keeper:remember-card-all-sites", { request_id, card_id }),
  // Saved field values (passwords etc.) kept on this machine, never sent to the AI.
  savedValues: (request_id) => ipcRenderer.invoke("keeper:saved-values", { request_id }),
  saveFields: (request_id, values, scope, auto) => ipcRenderer.invoke("keeper:save-fields", { request_id, values, scope, auto }),
  // Whether a synced vault key is held (so the prompt can default a generated password
  // to "Save to vault" rather than on-device-only).
  vaultStatus: () => ipcRenderer.invoke("keeper:vault-status"),
});

// Approvals — "a headless Keeper restarted". The page only sees the request's identifiers
// and comparison code and answers by request_id; the vault key and the device token are
// sealed in the main process and never reach the renderer.
contextBridge.exposeInMainWorld("keeperUnlock", {
  get: () => ipcRenderer.invoke("unlock:get"),
  approve: (requestId) => ipcRenderer.invoke("unlock:approve", { requestId }),
  deny: (requestId) => ipcRenderer.invoke("unlock:deny", { requestId }),
  onChanged: (fn) => { ipcRenderer.on("unlock:changed", () => fn()); },
});

// History — parsed records from main (values are never recorded).
contextBridge.exposeInMainWorld("keeperHistory", {
  onData: (cb) => ipcRenderer.on("history:data", (_e, items) => cb(items)),
  refresh: () => ipcRenderer.send("history:refresh"),
  screenshot: (id) => ipcRenderer.invoke("history:screenshot", id),
});

// Cards — the local card store; card values stay on this machine.
contextBridge.exposeInMainWorld("keeperCards", {
  load: () => ipcRenderer.invoke("cards:load"),
  save: (store) => ipcRenderer.invoke("cards:save", store),
  storageInfo: () => ipcRenderer.invoke("cards:storage-info"),
});

// Saved fields — metadata (NEVER the value) plus forget; one value on demand via reveal.
contextBridge.exposeInMainWorld("savedFields", {
  list: () => ipcRenderer.invoke("fields:list"),
  forget: (entry) => ipcRenderer.invoke("fields:forget", entry),
  forgetAll: () => ipcRenderer.invoke("fields:forget-all"),
  reveal: (entry) => ipcRenderer.invoke("fields:reveal", entry),
});

// Pair phone — a QR image of the connection config. The token is encoded into the QR by
// the MAIN process; it is never handed to the renderer as text.
contextBridge.exposeInMainWorld("keeperPair", {
  qr: () => ipcRenderer.invoke("pair:qr"),
});

// Vault password — the user's chosen password goes to main, which re-encrypts the vault
// under it and re-uploads the ciphertext.
contextBridge.exposeInMainWorld("keeperVault", {
  status: () => ipcRenderer.invoke("keeper:vault-status"),
  setPassword: (password) => ipcRenderer.invoke("keeper:set-vault-password", { password }),
});

// Headless Keepers — public keys only; no secret crosses this bridge.
contextBridge.exposeInMainWorld("keeperHeadless", {
  list: () => ipcRenderer.invoke("headless:list"),
  preview: (publicKey) => ipcRenderer.invoke("headless:preview", { publicKey }),
  add: (name, publicKey) => ipcRenderer.invoke("headless:add", { name, publicKey }),
  remove: (id) => ipcRenderer.invoke("headless:remove", { id }),
});

// Settings — per-device preferences (non-secret, local-only) and this device's identity.
contextBridge.exposeInMainWorld("keeperSettings", {
  get: () => ipcRenderer.invoke("keeper:get-settings"),
  set: (patch) => ipcRenderer.invoke("keeper:set-settings", patch),
  deviceInfo: () => ipcRenderer.invoke("keeper:device-info"),
});
