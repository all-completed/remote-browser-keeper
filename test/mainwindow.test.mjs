// The main window (issue #28) and the small approval window (issue #34), driven end to end
// through the real src/main.js.
//
// `electron` and `ws` are faked (test/fake-electron/), so the main process runs in plain
// node: the test plays the service on the keeper socket and the renderers on IPC, and reads
// back what main did with its windows. What it pins:
//   - the Keeper starts as a tray app with no window, and every tray page opens the SAME
//     main window (never a second one); a first launch opens it maximized, applied only
//     when it is shown (issue #31);
//   - a fill request comes up in its own small approval window — only once the request is
//     on screen (issue #3) — and the answer goes back on the socket exactly as before; the
//     window closes afterwards (issue #34);
//   - a request never shows, raises or focuses the main window, whether it is closed,
//     minimized, behind other apps or full screen (issue #34);
//   - several requests at once are answered one after another in the same approval
//     window, none dropped; closing it declines the one on screen (the old prompt window's
//     close), closing the main window answers nothing;
//   - a request that never reaches the screen is still a named UI failure;
//   - IPC from anything but a window's own top-level document is refused, and each window
//     reaches only its own channels.
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
// A window's document "loads" on a setImmediate (fake-electron loadURL). Queue behind it
// rather than racing it with a timer: under a loaded test run a 5 ms timer can fire first.
const settle = async () => { await new Promise((r) => setImmediate(r)); await wait(1); };

import { resolveTarget } from "../ui/lib/nav.js";

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
// Which window is which: by the document main loaded into it.
const isMain = (w) => /\/renderer-dist\/app\.html$/.test(w.loadedUrl || "");
const isApproval = (w) => /\/renderer-dist\/approval\.html$/.test(w.loadedUrl || "");
const mainWindow = () => fake.windows.filter((w) => isMain(w) && !w.isDestroyed()).at(-1);
const approvalWindows = () => fake.windows.filter(isApproval);
const approvalWindow = () => approvalWindows().filter((w) => !w.isDestroyed()).at(-1);
const fillRequest = (id) => ({
  type: "fill_request", request_id: id, session_id: "s1", url: "https://example.com/login",
  fields: [{ selector: "#pw", field: "password", label: "Password" }],
});

test("launch: a tray app with no window yet, and a tray entry for every page", () => {
  assert.equal(fake.windows.length, 0, "no window until one is asked for");
  assert.equal(fake.trays.length, 1);
  assert.equal(fake.dock[0], "hide", "no dock icon while there is no window");
  for (const label of ["Open Remote Browser Keeper", "Cards…", "Saved fields…", "History…", "Pair phone…",
    "Set vault password…", "Headless Keepers…", "Settings…", "Quit"]) { // "Set vault password…" opens Settings (issue #36)
    assert.ok(trayItem(label), `tray has "${label}"`);
  }
  sock().open();
  assert.equal(sock().sent[0].type, "hello");
});

test("a fill request comes up in a small approval window of its own — never the main window — and closes after the answer", async () => {
  sock().deliver(fillRequest("r1"));
  assert.equal(fake.windows.length, 1, "one window: the approval window");
  const win = fake.windows[0];
  assert.ok(isApproval(win), "its own document, approval.html");
  assert.equal(mainWindow(), undefined, "the main window is not even built for a request");
  assert.equal(win.opts.show, false);
  assert.ok(win.opts.width <= 600 && win.opts.height <= 720, "compact");
  assert.equal(win.opts.alwaysOnTop, true);
  assert.equal(win.opts.type, process.platform === "darwin" ? "panel" : undefined,
    "a non-activating panel on macOS, so focusing it does not bring the app's main window forward");
  assert.equal(win.contentProtection, true, "excluded from screen capture");
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.opts.webPreferences.contextIsolation, true);
  assert.equal(win.opts.webPreferences.nodeIntegration, false);
  assert.match(win.opts.webPreferences.preload, /src[/\\]approval-preload\.cjs$/, "its own, narrower preload");
  await settle(); // did-finish-load
  assert.equal(sentTo(win, "keeper:request")[0].request_id, "r1", "pushed on load");
  assert.equal((await invoke("keeper:pending-request", win)).request_id, "r1", "and pullable");
  assert.equal(win.isVisible(), false, "still hidden: nothing on screen yet");

  send("keeper:prompt-rendered", win, { request_id: "r1" });
  assert.equal(win.isVisible(), true, "shown once the request is painted");
  assert.deepEqual(win.calls.slice(-2), ["show", "focus"], "with the keyboard");
  assert.equal(win.alwaysOnTop, "screen-saver", "over everything, like the prompt window was");
  assert.equal(fake.beeps, 1);
  assert.equal(fake.dock.includes("show"), false, "no dock icon for a prompt");
  assert.equal(mainWindow(), undefined);

  send("keeper:submit", win, { request_id: "r1", values: [{ selector: "#pw", value: "not-a-real-password" }] });
  assert.deepEqual(fills().at(-1), { type: "fill_response", request_id: "r1", values: [{ selector: "#pw", value: "not-a-real-password" }] });
  assert.equal(win.isDestroyed(), true, "the approval window closes once nothing waits");
  assert.equal(mainWindow(), undefined, "and the main window never came into it");
});

test("a request never shows, raises or focuses the main window — closed, minimized, in the background or full screen", async () => {
  // The user opens the main window (a first launch: maximized, issue #31).
  trayItem("Open Remote Browser Keeper").click();
  await settle();
  const main = mainWindow();
  assert.ok(main, "the tray opens the main window");
  assert.equal(main.isVisible(), true);
  assert.equal(main.isMaximized(), true, "a first launch (no window.json) opens maximized (issue #31)");
  assert.equal(fake.dock.at(-1), "show");

  const states = {
    "in the background": () => { main.show(); main.minimized = false; main.fullScreen = false; },
    minimized: () => { main.show(); main.minimize(); },
    "full screen": () => { main.show(); main.minimized = false; main.setFullScreen(true); },
    "closed (hidden)": () => { main.setFullScreen(false); main.close(); },
  };
  let n = 0;
  for (const [state, enter] of Object.entries(states)) {
    enter();
    const before = { visible: main.isVisible(), minimized: main.isMinimized(), fullScreen: main.isFullScreen(), onTop: main.alwaysOnTop };
    const calls = main.calls.length;
    const navigations = sentTo(main, "app:navigate").length;
    const id = `bg${++n}`;
    sock().deliver(fillRequest(id));
    await settle();
    const ap = approvalWindow();
    send("keeper:prompt-rendered", ap, { request_id: id });
    assert.equal(ap.isVisible(), true, `${state}: the approval window comes up`);
    assert.deepEqual(main.calls.slice(calls), [], `${state}: the main window is not shown, restored or focused`);
    assert.deepEqual(
      { visible: main.isVisible(), minimized: main.isMinimized(), fullScreen: main.isFullScreen(), onTop: main.alwaysOnTop },
      before, `${state}: the main window stays exactly as it was`);
    assert.equal(sentTo(main, "app:navigate").length, navigations, `${state}: not even switched to a page`);
    assert.equal(sentTo(main, "keeper:request").length, 0, `${state}: the request never reaches the main window`);
    send("keeper:cancel", ap, { request_id: id });
    assert.equal(ap.isDestroyed(), true);
    assert.deepEqual(main.calls.slice(calls), [], `${state}: nor once it is answered`);
  }
  assert.equal(liveWindows().length, 1, "only the (hidden) main window is left");
});

test("every tray page opens in the same main window", async () => {
  const win = mainWindow();
  trayItem("History…").click();
  assert.equal(win.isVisible(), true);
  assert.equal(sentTo(win, "app:navigate").at(-1), "history");
  trayItem("Cards…").click();
  assert.equal(sentTo(win, "app:navigate").at(-1), "cards");
  trayItem("Settings…").click();
  trayItem("Pair phone…").click();
  assert.equal(sentTo(win, "app:navigate").at(-1), "pair");
  assert.equal(fake.windows.filter(isMain).length, 1, "never a second main window");
  assert.equal((await invoke("app:state", win)).page, "pair");
  // The renderer's own sidebar moves are remembered (so a reload lands on them)…
  send("app:page", win, "savedfields");
  assert.equal((await invoke("app:state", win)).page, "savedfields");
  // …and only real pages are.
  send("app:page", win, "../../etc/passwd");
  assert.equal((await invoke("app:state", win)).page, "savedfields");
});

test("the Vault password page is a section of Settings: the tray, an old `vaultpw` caller and the renderer all land there (issue #36)", async () => {
  const win = mainWindow();
  // Every target main sends is one the renderer can show (ui/lib/nav.js).
  const lands = (target) => resolveTarget(target);
  trayItem("Set vault password…").click();
  assert.equal(win.isVisible(), true);
  assert.equal(sentTo(win, "app:navigate").at(-1), "settings#vault-password");
  assert.deepEqual(lands(sentTo(win, "app:navigate").at(-1)), { page: "settings", section: "vault-password" });
  assert.equal((await invoke("app:state", win)).page, "settings#vault-password", "a reload lands on the section too");
  trayItem("Settings…").click();
  assert.deepEqual(lands(sentTo(win, "app:navigate").at(-1)), { page: "settings", section: null });
  // An old caller still asking for the retired page key gets the section, not nothing.
  send("app:page", win, "vaultpw");
  assert.equal((await invoke("app:state", win)).page, "settings#vault-password");
  // A section Settings doesn't have, or one on another page, is not a page.
  send("app:page", win, "history");
  for (const bad of ["settings#nope", "pair#vault-password", "vaultpw#vault-password", "settings#", "#vault-password"]) {
    send("app:page", win, bad);
    assert.equal((await invoke("app:state", win)).page, "history", bad);
    assert.equal(lands(bad), null, `the renderer refuses ${bad} too`);
  }
  assert.equal(fake.windows.filter(isMain).length, 1, "still one main window");
});

test("several requests at once: one at a time in the same approval window, none dropped", async () => {
  const main = mainWindow();
  const before = fills().length;
  for (const id of ["m1", "m2", "m3"]) sock().deliver(fillRequest(id));
  await settle();
  const win = approvalWindow();
  assert.equal(liveWindows().filter(isApproval).length, 1, "one approval window, not three");
  assert.deepEqual(sentTo(win, "keeper:request").map((r) => r.request_id), ["m1"], "the head of the queue only");
  assert.equal(sentTo(win, "app:status").at(-1).waiting, 3, "the window can say how many more wait");
  assert.deepEqual(menu().filter((i) => /^Approve: /.test(i.label || "")).length, 3, "the tray lists every one");

  send("keeper:prompt-rendered", win, { request_id: "m1" });
  send("keeper:submit", win, { request_id: "m1", values: [{ selector: "#pw", value: "x" }] });
  assert.equal(win.isDestroyed(), false, "still needed: two more wait");
  assert.equal(sentTo(win, "keeper:request").at(-1).request_id, "m2", "the next one, in the same window");
  send("keeper:prompt-rendered", win, { request_id: "m2" });
  send("keeper:cancel", win, { request_id: "m2", reason: "wrong account" });
  assert.equal(sentTo(win, "keeper:request").at(-1).request_id, "m3");
  send("keeper:prompt-rendered", win, { request_id: "m3" });
  // ✕ on the approval window declines the request on screen, as the prompt window's did.
  win.close();
  assert.equal(win.isDestroyed(), true);
  assert.deepEqual(fills().slice(before).map((f) => [f.request_id, f.cancelled ? "cancelled" : "sent", f.reason || null]), [
    ["m1", "sent", null], ["m2", "cancelled", "wrong account"], ["m3", "cancelled", null],
  ], "every request answered, in order");
  assert.equal(approvalWindow(), undefined, "and with the queue empty, no approval window is left");
  assert.equal(main.isVisible(), true, "the main window the user had open is untouched");
});

test("closing the approval window on a request brings up the next one; closing the main window answers nothing", async () => {
  const main = mainWindow();
  const mainCalls = main.calls.length;
  const before = fills().length;
  sock().deliver(fillRequest("c1"));
  sock().deliver(fillRequest("c2"));
  await settle();
  const first = approvalWindow();
  send("keeper:prompt-rendered", first, { request_id: "c1" });
  main.close(); // the user puts the main window away — not an answer to anything
  assert.equal(main.isDestroyed(), false, "closing hides; the Keeper lives on in the tray");
  assert.equal(main.isVisible(), false);
  assert.equal(fills().length, before, "nothing declined by closing the main window");
  assert.equal(first.isVisible(), true, "the approval window stays up");
  first.close();
  assert.deepEqual(fills().at(-1), { type: "fill_response", request_id: "c1", cancelled: true });
  await settle();
  const next = approvalWindow();
  assert.ok(next && next !== first, "a fresh approval window for the next request");
  assert.equal(sentTo(next, "keeper:request").at(-1).request_id, "c2");
  send("keeper:prompt-rendered", next, { request_id: "c2" });
  send("keeper:submit", next, { request_id: "c2", values: [] });
  assert.equal(next.isDestroyed(), true);
  assert.deepEqual(main.calls.slice(mainCalls), [], "the main window was never brought back by either request");
});

test("the Approvals page and the tray bring a lost approval window back — never the main window", async () => {
  const main = mainWindow();
  trayItem("Open Remote Browser Keeper").click();
  sock().deliver(fillRequest("s1"));
  await settle();
  const win = approvalWindow();
  send("keeper:prompt-rendered", win, { request_id: "s1" });
  const calls = win.calls.length;
  send("app:show-approval", main);
  assert.deepEqual(win.calls.slice(calls), ["show", "focus"], "the Approvals page's Show");
  trayItem("Approve: example.com").click();
  assert.deepEqual(win.calls.slice(calls + 2), ["show", "focus"], "the tray's entry for it");
  send("keeper:submit", win, { request_id: "s1", values: [] });
  // Nothing waiting: Show has nothing to show, and builds no window.
  send("app:show-approval", main);
  assert.equal(approvalWindow(), undefined);
});

test("a request resolved elsewhere is dropped, and the approval window it brought up goes away", async () => {
  const before = fills().length;
  sock().deliver(fillRequest("r3"));
  await settle();
  const win = approvalWindow();
  send("keeper:prompt-rendered", win, { request_id: "r3" });
  assert.equal(win.isVisible(), true);
  sock().deliver({ type: "request_resolved", request_id: "r3" });
  assert.equal(sentTo(win, "keeper:request-gone").at(-1).request_id, "r3");
  assert.equal(win.isDestroyed(), true);
  assert.equal(fills().length, before, "nothing is sent for a request someone else answered");
});

test("IPC from anything but a window's own top-level document is refused, and each window reaches only its own channels", async () => {
  const main = mainWindow();
  assert.equal((await invoke("keeper:get-settings", main)).ok, true, "the top frame is answered");
  // An embedded frame of the same window.
  const sub = fake.handlers["pair:qr"](ipcEvent(main, { subframe: true }));
  assert.deepEqual(await sub, { error: "Not available." });
  // The window navigated somewhere that is not our document.
  const own = main.webContents.mainFrame.url;
  main.webContents.mainFrame.url = "https://attacker.example/";
  assert.equal(await invoke("app:state", main), null);
  main.webContents.mainFrame.url = own;
  // Another window, even one showing a copy of our document.
  const other = new BrowserWindow({ show: false });
  other.loadURL(own);
  assert.deepEqual(await fake.handlers["pair:qr"](ipcEvent(other)), { error: "Not available." });
  assert.deepEqual(await fake.handlers["fields:reveal"](ipcEvent(other), { session: "s", host: "h", selector: "#x" }), { ok: false, value: null });
  other.destroy();

  // The two windows, each other's channels: a request is answered from the approval window
  // only, and the approval window reaches nothing of the main window's.
  const before = fills().length;
  sock().deliver(fillRequest("x1"));
  await settle();
  const ap = approvalWindow();
  assert.equal(await invoke("keeper:pending-request", main), null, "the main window cannot read the request");
  send("keeper:submit", main, { request_id: "x1", values: [{ selector: "#pw", value: "from-the-wrong-window" }] });
  assert.equal(fills().length, before, "nor answer it");
  assert.deepEqual(await invoke("keeper:saved-values", main, { request_id: "x1" }), []);
  assert.deepEqual(await fake.handlers["pair:qr"](ipcEvent(ap)), { error: "Not available." }, "no pair QR for the approval window");
  assert.deepEqual(await invoke("fields:reveal", ap, { session: "s", host: "h", selector: "#x" }), { ok: false, value: null });
  assert.deepEqual(await invoke("cards:load", ap), {});
  assert.equal((await invoke("app:state", ap)).status.waiting, 1, "the queue size is shared with it");
  assert.equal((await invoke("keeper:vault-status", ap)).ok, true, "so is the vault state (a generated password's default)");
  // The approval window's document navigated away: refused too.
  const apUrl = ap.webContents.mainFrame.url;
  ap.webContents.mainFrame.url = "https://attacker.example/";
  send("keeper:submit", ap, { request_id: "x1", values: [] });
  assert.equal(fills().length, before);
  ap.webContents.mainFrame.url = apUrl;
  send("keeper:prompt-rendered", ap, { request_id: "x1" });
  send("keeper:cancel", ap, { request_id: "x1" });
  assert.equal(fills().at(-1).request_id, "x1");
});

test("a request that never reaches the screen is a named UI failure, not a silent wait", async () => {
  const main = mainWindow();
  sock().deliver(fillRequest("r4"));
  await settle();
  const win = approvalWindow();
  await wait(450); // KEEPER_RENDER_TIMEOUT_MS = 300; the renderer never says "rendered"
  const f = fills().at(-1);
  assert.equal(f.request_id, "r4");
  assert.equal(f.cancelled, true);
  assert.equal(f.error, "keeper_ui_failed");
  assert.equal(win.isVisible(), false, "an empty approval window is never shown");
  assert.equal(win.isDestroyed(), true, "and is gone with nothing else waiting");
  assert.ok(trayItem("⚠︎ Approval window failed to render"), "named in the tray");
  assert.ok(sentTo(main, "app:status").at(-1).promptFailure, "and on the main window's Approvals page");
  send("app:dismiss", main, "promptFailure");
  assert.equal(trayItem("⚠︎ Approval window failed to render"), undefined);
});

test("a renderer that dies takes its approval window with it; the next request gets a fresh one", async () => {
  sock().deliver(fillRequest("d1"));
  await settle();
  const win = approvalWindow();
  send("keeper:prompt-rendered", win, { request_id: "d1" });
  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(win.isDestroyed(), true);
  assert.deepEqual(fills().at(-1), { type: "fill_response", request_id: "d1", cancelled: true },
    "a request that was on screen is declined, as closing its window would");
  fake.autoLoad = false; // …and this time the new document never comes up at all
  sock().deliver(fillRequest("r5"));
  const fresh = approvalWindow();
  assert.notEqual(fresh, win);
  assert.equal(liveWindows().filter(isApproval).length, 1);
  await wait(450);
  assert.equal(fills().at(-1).request_id, "r5");
  assert.equal(fills().at(-1).error, "keeper_ui_failed");
  assert.equal(fresh.isDestroyed(), true, "a hidden window whose document never loaded is thrown away");
  fake.autoLoad = true;
  sock().deliver(fillRequest("r6"));
  await settle();
  assert.equal(liveWindows().filter(isApproval).length, 1, "and the next request builds one approval window again");
  send("keeper:prompt-rendered", approvalWindow(), { request_id: "r6" });
  assert.equal(approvalWindow().isVisible(), true);
});
