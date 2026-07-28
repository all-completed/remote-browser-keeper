// Per-device Keeper preferences (NOT secrets) — stored as plain JSON at
// ~/.remote-browser-keeper/<base-url>/settings.json. These only tune local UX; they are
// never synced to the service or other devices.
//
//   generateShowWindow: when true, a password-generation request opens the prompt window
//     (so the user reviews/edits the generated value before it's filled) instead of the
//     default fully-unattended path (create + fill + save, no prompt). Default false.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

function sanitizeForPath(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}
function settingsPath(baseUrl) {
  return path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl), "settings.json");
}

const DEFAULTS = { generateShowWindow: false };

export function loadSettings(baseUrl) {
  try {
    const raw = fs.readFileSync(settingsPath(baseUrl), "utf8");
    const obj = JSON.parse(raw);
    return { ...DEFAULTS, ...(obj && typeof obj === "object" ? obj : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(baseUrl, patch) {
  const next = { ...loadSettings(baseUrl), ...(patch && typeof patch === "object" ? patch : {}) };
  // Keep only known keys with coerced types, so a bad write can't corrupt behavior.
  const clean = { generateShowWindow: !!next.generateShowWindow };
  const p = settingsPath(baseUrl);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(clean, null, 2));
  return clean;
}
