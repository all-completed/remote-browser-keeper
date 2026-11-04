// Module hooks for test/mainwindow.test.mjs: `electron` and `ws` resolve to the fakes in
// this folder, so src/main.js runs in plain node — no Chromium, no network — and its
// window wiring can be asserted. (Pattern from Getway Chat desktop's test/fake-electron.)
const FAKES = {
  electron: new URL("./electron.mjs", import.meta.url).href,
  ws: new URL("./ws.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  if (FAKES[specifier]) return { url: FAKES[specifier], shortCircuit: true };
  return next(specifier, context);
}
