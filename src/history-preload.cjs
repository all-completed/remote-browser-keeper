// Bridge for the history window. Receives parsed history records from main
// (read from the local log; values are never recorded) and lets the renderer
// ask main to refresh or reveal the file. No Node access in the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperHistory", {
  onData: (cb) => ipcRenderer.on("history:data", (_e, items) => cb(items)),
  refresh: () => ipcRenderer.send("history:refresh"),
  screenshot: (id) => ipcRenderer.invoke("history:screenshot", id),
  viewImage: (dataUrl) => ipcRenderer.send("keeper:view-image", dataUrl),
});
