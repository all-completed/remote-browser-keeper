// Bridge for the Cards window. Lets the renderer load and save the local card
// store (~/.remote-browser-keeper/cards.json) via main. No Node access in the
// renderer; card values stay on this machine.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperCards", {
  load: () => ipcRenderer.invoke("cards:load"),
  save: (store) => ipcRenderer.invoke("cards:save", store),
});
