// Bridge for the "Headless Keepers" window: list, pin (name + the public key the daemon
// printed) and remove headless Keepers. Public keys only — no secret crosses this bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperHeadless", {
  list: () => ipcRenderer.invoke("headless:list"),
  add: (name, publicKey) => ipcRenderer.invoke("headless:add", { name, publicKey }),
  remove: (id) => ipcRenderer.invoke("headless:remove", { id }),
});
