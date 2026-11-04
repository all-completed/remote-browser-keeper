// The preload of the APPROVAL window (issue #34): the small window a request waiting for
// the user — a fill request, or a headless Keeper asking to be unlocked — is answered in,
// apart from the main window. It gets the request bridges and nothing else: no history,
// cards, saved fields, pair QR or settings. Main checks the sender of every message
// (src/ipcsender.js): this window's top frame, showing our own approval.html. No Node
// access in the renderer.
const { contextBridge, ipcRenderer } = require("electron");

// How many requests wait (the "N more waiting" under the one on screen) — read-only.
contextBridge.exposeInMainWorld("keeperApp", {
  state: () => ipcRenderer.invoke("app:state"),
  onStatus: (cb) => ipcRenderer.on("app:status", (_e, status) => cb(status)),
});

// Fill requests. The secret value is passed from the renderer to main (which
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

// "A headless Keeper restarted". The window only sees the request's identifiers
// and comparison code and answers by request_id; the vault key and the device token are
// sealed in the main process and never reach the renderer.
contextBridge.exposeInMainWorld("keeperUnlock", {
  get: () => ipcRenderer.invoke("unlock:get"),
  approve: (requestId) => ipcRenderer.invoke("unlock:approve", { requestId }),
  deny: (requestId) => ipcRenderer.invoke("unlock:deny", { requestId }),
  onChanged: (fn) => { ipcRenderer.on("unlock:changed", () => fn()); },
});
