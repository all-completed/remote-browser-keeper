// Bridge for the "Headless Keeper restarted" window. The renderer only sees the request's
// identifiers and comparison code and answers by request_id; the vault key and the
// device token are sealed in the main process and never reach this window.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperUnlock", {
  get: () => ipcRenderer.invoke("unlock:get"),
  approve: (requestId) => ipcRenderer.invoke("unlock:approve", { requestId }),
  deny: (requestId) => ipcRenderer.invoke("unlock:deny", { requestId }),
  onChanged: (fn) => { ipcRenderer.on("unlock:changed", () => fn()); },
});
