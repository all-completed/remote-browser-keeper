// Who is allowed to send a given IPC message — Electron's "validate the sender of all
// IPC messages", for this app.
//
// Every window is sandboxed, context-isolated and reaches main only through its own
// preload bridge, so a renderer cannot NORMALLY speak on a channel its preload never
// exposed. That is one layer, and it is exactly the layer anything that gets code running
// inside a renderer is trying to get under — a context-isolation escape, a preload bug, an
// embedded frame. `ipcMain` itself has no notion of which window a channel belongs to: a
// handler that answers whoever asked hands over the thing that sender was never meant to
// hold. The image viewer, whose whole content is a picture the service supplied, could ask
// for the pair QR (`pair:qr` — API key + session secret + vault password, all in one
// image), a saved password (`fields:reveal`), a card number (`keeper:card-values`), or
// could answer a pending request itself (`keeper:submit`).
//
// So every handler names the window(s) it serves, and main checks three things about the
// sender before it runs:
//
//   1. it IS one of those windows (not another window, not a destroyed one);
//   2. the message came from that window's TOP frame, not an embedded one;
//   3. that frame is still showing OUR OWN document — the page main loaded into it, not
//      somewhere it was navigated to.
//
// (2) and (3) are not redundant with the navigation handlers in `main.js`: those deny
// navigations we see coming, this refuses to act on a frame that is not the one we put
// there, whatever got it into that state.
//
// Pure (no electron): `main.js` does the electron-object → plain-data part, so the
// decision itself is testable without a browser — see `test/ipcsender.test.mjs`.
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The URL of one of our own renderer documents. This is BOTH the URL main loads into a
 * window and the URL a message from that window is checked against — one definition, so
 * the two can never drift apart.
 *
 * @param {string} page      window name (`prompt`, `pair`, …) — one HTML file per window
 * @param {{dev?: boolean, rendererDir: string, devOrigin?: string}} where
 *        `dev` → the Vite dev server (KEEPER_DEV=1); otherwise the built file.
 */
export function rendererUrl(page, { dev = false, rendererDir, devOrigin = "http://localhost:5173" } = {}) {
  if (dev) return `${devOrigin}/${page}.html`;
  return pathToFileURL(path.resolve(rendererDir, `${page}.html`)).href;
}

/**
 * May this IPC message be answered?
 *
 * @param {{senderId: number, frameUrl: string|null, isMainFrame: boolean}} sender
 *        the message's origin: which webContents it came from, the sending frame's current
 *        URL, and whether that frame is the webContents' top frame. `frameUrl` is null
 *        when the frame is already gone.
 * @param {Array<{id: number, url: string, page: string}>} allowed
 *        the live windows this channel serves — webContents id, expected document URL,
 *        and window name (for the log).
 * @returns {string|null} `null` when the message may be answered, else the reason it was
 *        refused — short enough to log verbatim, specific enough to debug with.
 */
export function refuseSender(sender, allowed) {
  const wins = Array.isArray(allowed) ? allowed.filter(Boolean) : [];
  const win = wins.find((w) => w.id === (sender && sender.senderId));
  if (!win) {
    if (!wins.length) return "no window serves this channel right now";
    return `sender is not the ${wins.map((w) => w.page).join(" / ")} window`;
  }
  if (!sender.isMainFrame) return `not the ${win.page} window's top frame`;
  if (sender.frameUrl !== win.url) {
    return `the ${win.page} window is not showing ${win.page}.html (${sender.frameUrl || "no url"})`;
  }
  return null;
}
