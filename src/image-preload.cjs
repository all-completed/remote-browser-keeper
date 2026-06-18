// Bridge for the full-size screenshot viewer. Receives the image data URL from
// main and reports the image's natural size back so main can fit the window.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("imageView", {
  onData: (cb) => ipcRenderer.on("image:data", (_e, dataUrl) => cb(dataUrl)),
  sized: (w, h) => ipcRenderer.send("image:sized", w, h),
});
