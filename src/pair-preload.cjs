// Bridge for the "Pair phone" window. The renderer asks main for a QR image of the
// current connection config (base URL + API token). The token is encoded into the
// QR by the MAIN process — it is never handed to the renderer as text.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("keeperPair", {
  qr: () => ipcRenderer.invoke("pair:qr"),
});
