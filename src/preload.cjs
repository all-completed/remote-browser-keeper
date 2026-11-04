// The preload of the main window (issue #28). Every page of ui/App.jsx talks to the
// main process through the bridges below — the same names the separate windows used to
// get from their own preloads, so each page's calls are unchanged. Main still checks the
// sender of every message (src/ipcsender.js): the main window's top frame, showing our own
// app.html. No Node access in the renderer.
//
// No request is answered from this window (issue #34): the fill and unlock bridges
// (`keeper`, `keeperUnlock`) are the approval window's alone — src/approval-preload.cjs.
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
  // Bring the approval window (issue #34) back up for what is waiting.
  showApproval: () => ipcRenderer.send("app:show-approval"),
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
