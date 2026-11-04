// Just enough of Electron's main-process API for src/main.js, recording what it is asked
// to do. `fake` is the state a test reads and steers.
import { EventEmitter } from "node:events";

export const fake = {
  home: null,
  userData: null,
  windows: [],     // every BrowserWindow ever created
  trays: [],
  handlers: {},    // ipcMain.handle
  listeners: {},   // ipcMain.on
  appEvents: new EventEmitter(),
  dock: [],        // "show" | "hide", in order
  beeps: 0,
  autoLoad: true,  // loadURL() → did-finish-load + ready-to-show on the next tick
};

let nextId = 1;

class WebContents extends EventEmitter {
  constructor(win) {
    super();
    this.id = nextId++;
    this.win = win;
    this.sent = []; // [channel, ...args]
    this.mainFrame = { url: null };
    this.windowOpenHandler = null;
  }
  send(channel, ...args) { this.sent.push([channel, ...args]); }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
}

export class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.visible = !!opts.show;
    this.destroyed = false;
    this.alwaysOnTop = false;
    this.minimized = false;
    this.contentProtection = false;
    this.webContents = new WebContents(this);
    fake.windows.push(this);
    fake.appEvents.emit("browser-window-created", {}, this);
  }
  loadURL(url) {
    this.loadedUrl = url;
    this.webContents.mainFrame.url = url;
    if (fake.autoLoad) setImmediate(() => this.finishLoad());
    return Promise.resolve();
  }
  // The renderer came up: the document loaded, then painted.
  finishLoad() {
    if (this.destroyed) return;
    this.webContents.emit("did-finish-load");
    this.emit("ready-to-show");
  }
  show() { this.visible = true; this.minimized = false; }
  hide() { this.visible = false; }
  focus() {}
  restore() { this.minimized = false; }
  // As Electron's: "This will also show (but not focus) the window if it isn't being
  // displayed already" — so a window maximized at creation would be on screen before it
  // painted (issue #31).
  maximize() { this.maximized = true; this.visible = true; this.minimized = false; }
  center() {}
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isMaximized() { return !!this.maximized; }
  isDestroyed() { return this.destroyed; }
  setAlwaysOnTop(flag, level) { this.alwaysOnTop = flag ? (level || true) : false; }
  setContentProtection(v) { this.contentProtection = v; }
  getNormalBounds() { return { x: 10, y: 20, width: 1040, height: 740 }; }
  // The user pressed the window's ✕. Electron emits a preventable "close" first.
  close() {
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  }
}

export const app = {
  isQuitting: false,
  on: (ev, fn) => fake.appEvents.on(ev, fn),
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  getVersion: () => "0.2.0",
  getPath: (name) => {
    if (name === "home") return fake.home;
    if (name === "userData") return fake.userData;
    throw new Error("getPath " + name);
  },
  quit: () => { fake.appEvents.emit("before-quit"); },
  dock: {
    show: () => { fake.dock.push("show"); return Promise.resolve(); },
    hide: () => { fake.dock.push("hide"); },
  },
};

export class Tray {
  constructor(icon) { this.icon = icon; this.menu = null; this.tooltip = ""; fake.trays.push(this); }
  setToolTip(t) { this.tooltip = t; }
  setTitle(t) { this.title = t; }
  setContextMenu(m) { this.menu = m; }
}

export const Menu = { buildFromTemplate: (template) => template };

export const nativeImage = {
  createFromPath: (p) => ({ path: p, isEmpty: () => false, setTemplateImage() {} }),
  createEmpty: () => ({ isEmpty: () => true }),
};

export const ipcMain = {
  on: (ch, fn) => { fake.listeners[ch] = fn; },
  handle: (ch, fn) => { fake.handlers[ch] = fn; },
};

export const screen = {
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
};

export const shell = { beep: () => { fake.beeps += 1; } };

export const safeStorage = { isEncryptionAvailable: () => false };

// What a renderer sends: an IPC event from `win`'s top frame, or from a frame embedded in it.
export function ipcEvent(win, { subframe = false } = {}) {
  const wc = win.webContents;
  return { sender: wc, senderFrame: subframe ? { url: wc.mainFrame.url } : wc.mainFrame };
}
