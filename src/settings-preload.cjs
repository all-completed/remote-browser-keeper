// Bridge for the Settings window. Reads/writes per-device Keeper preferences (non-secret,
// local-only) through the main process. No values or secrets flow through here.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperSettings", {
  get: () => ipcRenderer.invoke("keeper:get-settings"),
  set: (patch) => ipcRenderer.invoke("keeper:set-settings", patch),
  // This device's identity + vault state — the same inert report sent to the service.
  deviceInfo: () => ipcRenderer.invoke("keeper:device-info"),
});
