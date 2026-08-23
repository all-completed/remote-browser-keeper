// Who may send an IPC message (src/ipcsender.js).
//
// Issue #18: `ipcMain` has no notion of which window a channel belongs to, so every
// handler answered every renderer. These tests pin the rule main.js now applies before
// each handler runs — the sender must BE the window that owns the channel, must be that
// window's TOP frame, and that frame must still be showing our own document.
//
// No electron needed: main.js reduces the event to `{senderId, frameUrl, isMainFrame}`
// and the decision itself is plain data in, reason-string out.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rendererUrl, refuseSender } from "../src/ipcsender.js";

const DIR = "/opt/Keeper/resources/app/renderer-dist";
const PAIR = { id: 7, url: rendererUrl("pair", { rendererDir: DIR }), page: "pair" };
const PROMPT = { id: 9, url: rendererUrl("prompt", { rendererDir: DIR }), page: "prompt" };

// The sender the app itself produces: the right window, its top frame, our own page.
function realSender(win) {
  return { senderId: win.id, frameUrl: win.url, isMainFrame: true };
}

test("rendererUrl: the built file, as an absolute file:// URL", () => {
  assert.equal(
    rendererUrl("prompt", { rendererDir: DIR }),
    pathToFileURL(path.join(DIR, "prompt.html")).href,
  );
  // main.js builds the dir as `<src>/../renderer-dist`, so the `..` must be resolved
  // away — otherwise the expected URL could never equal the one the frame reports.
  assert.equal(
    rendererUrl("pair", { rendererDir: "/opt/Keeper/src/../renderer-dist" }),
    "file:///opt/Keeper/renderer-dist/pair.html",
  );
});

test("rendererUrl: the Vite dev server under KEEPER_DEV=1", () => {
  assert.equal(
    rendererUrl("cards", { dev: true, rendererDir: DIR }),
    "http://localhost:5173/cards.html",
  );
});

test("the window that owns the channel is served", () => {
  assert.equal(refuseSender(realSender(PAIR), [PAIR]), null);
});

test("a channel served for two windows accepts either", () => {
  // keeper:vault-status (prompt + vaultpw) and keeper:view-image (prompt + history).
  assert.equal(refuseSender(realSender(PAIR), [PROMPT, PAIR]), null);
  assert.equal(refuseSender(realSender(PROMPT), [PROMPT, PAIR]), null);
});

test("another window is refused — the image viewer cannot ask for the pair QR", () => {
  const image = { senderId: 42, frameUrl: rendererUrl("image", { rendererDir: DIR }), isMainFrame: true };
  const why = refuseSender(image, [PAIR]);
  assert.match(why, /not the pair window/);
});

test("a subframe of the right window is refused", () => {
  const sub = { senderId: PROMPT.id, frameUrl: PROMPT.url, isMainFrame: false };
  assert.match(refuseSender(sub, [PROMPT]), /top frame/);
});

test("the right window showing someone else's page is refused", () => {
  const navigated = { senderId: PROMPT.id, frameUrl: "https://attacker.example/x", isMainFrame: true };
  const why = refuseSender(navigated, [PROMPT]);
  assert.match(why, /not showing prompt\.html/);
  assert.match(why, /attacker\.example/, "the reason names the page, so a refusal is debuggable");
});

test("a sender whose frame is already gone (no url) is refused", () => {
  const gone = { senderId: PROMPT.id, frameUrl: null, isMainFrame: false };
  assert.equal(typeof refuseSender(gone, [PROMPT]), "string");
});

test("no window is open for the channel — nothing is served", () => {
  // main.js drops destroyed/never-opened windows before calling, so `allowed` is empty:
  // e.g. fields:reveal while the Saved fields window is closed.
  const why = refuseSender(realSender(PAIR), []);
  assert.match(why, /^no window serves this channel/);
});

test("a page name is never enough on its own — the id decides", () => {
  // Same document URL, different webContents: a second window on the same page must not
  // inherit the first one's channels.
  const impostor = { senderId: 999, frameUrl: PAIR.url, isMainFrame: true };
  assert.match(refuseSender(impostor, [PAIR]), /not the pair window/);
});
