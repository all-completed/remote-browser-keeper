// Bridge for the Saved fields window. Lists saved-field metadata (NEVER the value)
// and lets the user forget entries. No Node access in the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("savedFields", {
  list: () => ipcRenderer.invoke("fields:list"),
  forget: (entry) => ipcRenderer.invoke("fields:forget", entry),
  forgetAll: () => ipcRenderer.invoke("fields:forget-all"),
});
