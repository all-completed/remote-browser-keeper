// The ONE window (issue #28), driven end to end through the real src/main.js.
//
// `electron` and `ws` are faked (test/fake-electron/), so the main process runs in plain
// node: the test plays the service on the keeper socket and the renderer on IPC, and reads
// back what main did with its windows. What it pins:
//   - the Keeper starts as a tray app with no window, and every tray page opens the SAME
//     window (never a second one);
//   - a fill request brings that window up only once the request is on screen (issue #3),
//     and an answer goes back on the socket exactly as before;
//   - closing the window hides it, and declines the request on screen (the old prompt
//     window's close);
//   - a request that never reaches the screen is still a named UI failure;
//   - IPC from anything but the window's own top-level document is refused.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-main-"));
fs.mkdirSync(path.join(HOME, "userData"));
process.env.HOME = HOME;                       // ~/.ac-api-key and ~/.remote-browser-keeper live here
process.env.RBS_URL = "http://keeper.test";
process.env.AC_API_KEY = "dummy-key-for-tests"; // not a credential: nothing is ever dialled
delete process.env.RBS_API_KEY;
delete process.env.AC_API_KEY_FILE;
delete process.env.KEEPER_TEST;
delete process.env.KEEPER_DEV;
delete process.env.KEEPER_NO_CONTENT_PROTECTION;
process.env.KEEPER_RENDER_TIMEOUT_MS = "300";
// No network: enrollment and vault sync fail fast, as they would offline.
globalThis.fetch = async () => { throw new Error("offline (test)"); };
// main.js arms heartbeats and reconnect timers; they must not keep this process alive.
const realSetTimeout = globalThis.setTimeout;
for (const name of ["setTimeout", "setInterval"]) {
  const real = globalThis[name];
  globalThis[name] = (...args) => { const t = real(...args); t?.unref?.(); return t; };
}
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

register("./fake-electron/hooks.mjs", import.meta.url);
const { fake, ipcEvent, BrowserWindow } = await import("./fake-electron/electron.mjs");
fake.home = HOME;
fake.userData = path.join(HOME, "userData");
const { sockets } = await import("./fake-electron/ws.mjs");
await import("../src/main.js");
await wait(10); // app.whenReady().then(...)

const sock = () => sockets.at(-1);
const send = (ch, win, ...args) => fake.listeners[ch](ipcEvent(win), ...args);
const invoke = (ch, win, ...args) => fake.handlers[ch](ipcEvent(win), ...args);
const sentTo = (win, ch) => win.webContents.sent.filter(([c]) => c === ch).map(([, arg]) => arg);
const fills = () => sock().sent.filter((f) => f.type === "fill_response");
const menu = () => fake.trays[0].menu;
const trayItem = (label) => menu().find((i) => typeof i.label === "string" && i.label.startsWith(label));
const liveWindows = () => fake.windows.filter((w) => !w.isDestroyed());
const fillRequest = (id) => ({
  type: "fill_request", request_id: id, session_id: "s1", url: "https://example.com/login",
  fields: [{ selector: "#pw", field: "password", label: "Password" }],
});

test("launch: a tray app with no window yet, and a tray entry for every page", () => {
  assert.equal(fake.windows.length, 0, "no window until one is asked for");
  assert.equal(fake.trays.length, 1);
  assert.equal(fake.dock[0], "hide", "no dock icon while there is no window");
  for (const label of ["Open Remote Browser Keeper", "Cards…", "Saved fields…", "History…", "Pair phone…",
    "Set vault password…", "Headless Keepers…", "Settings…", "Quit"]) {
    assert.ok(trayItem(label), `tray has "${label}"`);
  }
  sock().open();
  assert.equal(sock().sent[0].type, "hello");
});

test("a fill request brings up ONE window — hidden until the request is on screen — and the answer goes out", async () => {
  sock().deliver(fillRequest("r1"));
  assert.equal(fake.windows.length, 1);
  const win = fake.windows[0];
  assert.match(win.loadedUrl, /\/renderer-dist\/app\.html$/, "the one document");
  assert.equal(win.opts.show, false);
  assert.equal(win.contentProtection, true, "excluded from screen capture");
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.opts.webPreferences.contextIsolation, true);
  assert.equal(win.opts.webPreferences.nodeIntegration, false);
  assert.match(win.opts.webPreferences.preload, /src[/\\]preload\.cjs$/);
  await wait(5); // did-finish-load
  assert.equal(sentTo(win, "keeper:request")[0].request_id, "r1", "pushed on load");
  assert.equal((await invoke("keeper:pending-request", win)).request_id, "r1", "and pullable");
  assert.equal(win.isVisible(), false, "still hidden: nothing on screen yet");

  send("keeper:prompt-rendered", win, { request_id: "r1" });
  assert.equal(win.isVisible(), true, "shown once the request is painted");
  assert.equal(win.alwaysOnTop, "screen-saver", "over everything, like the prompt window was");
  assert.equal(fake.beeps, 1);
  assert.equal(fake.dock.at(-1), "show");
  assert.equal((await invoke("app:state", win)).page, "approvals");

  send("keeper:submit", win, { request_id: "r1", values: [{ selector: "#pw", value: "not-a-real-password" }] });
  assert.deepEqual(fills().at(-1), { type: "fill_response", request_id: "r1", values: [{ selector: "#pw", value: "not-a-real-password" }] });
  assert.equal(win.isVisible(), false, "a window the request brought up goes away again once it is answered");
  assert.equal(win.alwaysOnTop, false);
  assert.equal(fake.windows.length, 1);
});

test("every tray page opens in the same window", async () => {
  const win = fake.windows[0];
  trayItem("History…").click();
  assert.equal(win.isVisible(), true);
  assert.equal(sentTo(win, "app:navigate").at(-1), "history");
  trayItem("Cards…").click();
  assert.equal(sentTo(win, "app:navigate").at(-1), "cards");
  trayItem("Settings…").click();
  trayItem("Pair phone…").click();
  assert.equal(sentTo(win, "app:navigate").at(-1), "pair");
  assert.equal(fake.windows.length, 1, "never a second window");
  assert.equal((await invoke("app:state", win)).page, "pair");
  // The renderer's own sidebar moves are remembered (so a reload lands on them)…
  send("app:page", win, "savedfields");
  assert.equal((await invoke("app:state", win)).page, "savedfields");
  // …and only real pages are.
  send("app:page", win, "../../etc/passwd");
  assert.equal((await invoke("app:state", win)).page, "savedfields");
});

test("closing the window hides it, and declines the request on screen", () => {
  const win = fake.windows[0];
  sock().deliver(fillRequest("r2"));
  assert.equal(sentTo(win, "keeper:request").at(-1).request_id, "r2", "the loaded window gets it at once");
  send("keeper:prompt-rendered", win, { request_id: "r2" });
  win.close();
  assert.equal(win.isDestroyed(), false, "closing hides; the Keeper lives on in the tray");
  assert.equal(win.isVisible(), false);
  assert.equal(fake.dock.at(-1), "hide");
  assert.deepEqual(fills().at(-1), { type: "fill_response", request_id: "r2", cancelled: true });
  assert.equal(fake.windows.length, 1);
});

test("a request resolved elsewhere is dropped from the page, and the window it brought up goes away", () => {
  const win = fake.windows[0];
  const before = fills().length;
  sock().deliver(fillRequest("r3"));
  send("keeper:prompt-rendered", win, { request_id: "r3" });
  assert.equal(win.isVisible(), true);
  sock().deliver({ type: "request_resolved", request_id: "r3" });
  assert.equal(sentTo(win, "keeper:request-gone").at(-1).request_id, "r3");
  assert.equal(win.isVisible(), false);
  assert.equal(fills().length, before, "nothing is sent for a request someone else answered");
});

test("IPC from anything but the window's own top-level document is refused", async () => {
  const win = fake.windows[0];
  assert.equal((await invoke("keeper:get-settings", win)).ok, true, "the top frame is answered");
  // An embedded frame of the same window.
  const sub = fake.handlers["pair:qr"](ipcEvent(win, { subframe: true }));
  assert.deepEqual(await sub, { error: "Not available." });
  // The window navigated somewhere that is not our document.
  const own = win.webContents.mainFrame.url;
  win.webContents.mainFrame.url = "https://attacker.example/";
  assert.equal(await invoke("app:state", win), null);
  win.webContents.mainFrame.url = own;
  // Another window, even one showing a copy of our document.
  const other = new BrowserWindow({ show: false });
  other.loadURL(own);
  assert.deepEqual(await fake.handlers["pair:qr"](ipcEvent(other)), { error: "Not available." });
  assert.deepEqual(await fake.handlers["fields:reveal"](ipcEvent(other), { session: "s", host: "h", selector: "#x" }), { ok: false, value: null });
  other.destroy();
});

test("a request that never reaches the screen is a named UI failure, not a silent wait", async () => {
  const win = fake.windows[0];
  sock().deliver(fillRequest("r4"));
  await wait(450); // KEEPER_RENDER_TIMEOUT_MS = 300; the renderer never says "rendered"
  const f = fills().at(-1);
  assert.equal(f.request_id, "r4");
  assert.equal(f.cancelled, true);
  assert.equal(f.error, "keeper_ui_failed");
  assert.equal(win.isVisible(), false, "an empty approval page is never shown");
  assert.ok(trayItem("⚠︎ Approval window failed to render"), "named in the tray");
  assert.ok(sentTo(win, "app:status").at(-1).promptFailure, "and in the window");
  send("app:dismiss", win, "promptFailure");
  assert.equal(trayItem("⚠︎ Approval window failed to render"), undefined);
});

test("a renderer that dies takes its window with it; the next request gets a fresh one", async () => {
  const win = fake.windows[0];
  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(win.isDestroyed(), true);
  fake.autoLoad = false; // …and this time the new document never comes up at all
  sock().deliver(fillRequest("r5"));
  const fresh = fake.windows.at(-1);
  assert.notEqual(fresh, win);
  assert.equal(liveWindows().length, 1);
  await wait(450);
  assert.equal(fills().at(-1).request_id, "r5");
  assert.equal(fills().at(-1).error, "keeper_ui_failed");
  assert.equal(fresh.isDestroyed(), true, "a hidden window whose document never loaded is thrown away");
  fake.autoLoad = true;
  trayItem("Open Remote Browser Keeper").click();
  await wait(5);
  assert.equal(liveWindows().length, 1, "and the next open builds one window again");
  assert.equal(liveWindows()[0].isVisible(), true);
});
