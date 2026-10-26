// Bridge for the "Headless Keepers" window: list, preview a pasted key's fingerprint,
// pin (name + the public key the daemon printed) and remove headless Keepers. Public keys only — no secret crosses this bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperHeadless", {
  list: () => ipcRenderer.invoke("headless:list"),
  preview: (publicKey) => ipcRenderer.invoke("headless:preview", { publicKey }),
  add: (name, publicKey) => ipcRenderer.invoke("headless:add", { name, publicKey }),
  remove: (id) => ipcRenderer.invoke("headless:remove", { id }),
});
