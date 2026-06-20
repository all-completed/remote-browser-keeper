// Bridge between the prompt renderer and the main process. The secret value is
// passed from the renderer to main (which forwards it to the service) and never
// leaves the local machine except over the authenticated keeper WS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeper", {
  onRequest: (cb) => ipcRenderer.on("keeper:request", (_e, req) => cb(req)),
  submit: (request_id, values) => ipcRenderer.send("keeper:submit", { request_id, values }),
  cancel: (request_id) => ipcRenderer.send("keeper:cancel", { request_id }),
  cardValues: (request_id, card_id) => ipcRenderer.invoke("keeper:card-values", { request_id, card_id }),
  rememberCardDomain: (request_id, card_id) => ipcRenderer.invoke("keeper:remember-card-domain", { request_id, card_id }),
  viewImage: (dataUrl) => ipcRenderer.send("keeper:view-image", dataUrl),
});
