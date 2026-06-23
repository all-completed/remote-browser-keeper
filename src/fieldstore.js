// Saved field values (passwords and other entered values) the user chose to keep,
// so future fill_requests for the same field prefill automatically. Two scopes:
//   - "session" : in-memory only, cleared when the Keeper restarts.
//   - "forever" : persisted to ~/.remote-browser-keeper/<base-url>/fields.json,
//                 OS-encrypted via securestore (safeStorage/Keychain) when available.
// Keyed by host + selector. Values stay on this machine and are never sent to the AI.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./securestore.js";

const memory = new Map(); // "host|selector" -> value (cleared on restart)

function sanitizeForPath(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}
function fieldsPath(baseUrl) {
  return path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl), "fields.json");
}
function keyOf(host, selector) { return `${host}|${selector}`; }
function loadPersisted(baseUrl) {
  const obj = readJson(fieldsPath(baseUrl));
  return obj && typeof obj === "object" ? obj : {};
}

export function getSavedValue(baseUrl, host, selector) {
  const k = keyOf(host, selector);
  if (memory.has(k)) return memory.get(k);
  const persisted = loadPersisted(baseUrl);
  return Object.prototype.hasOwnProperty.call(persisted, k) ? persisted[k] : null;
}

export function saveValue(baseUrl, host, selector, value, scope) {
  if (!host || !selector) return;
  const k = keyOf(host, selector);
  if (scope === "session") {
    memory.set(k, value);
    return;
  }
  if (scope === "forever") {
    const persisted = loadPersisted(baseUrl);
    persisted[k] = value;
    try { fs.mkdirSync(path.dirname(fieldsPath(baseUrl)), { recursive: true }); } catch { /* ignore */ }
    writeJson(fieldsPath(baseUrl), persisted);
  }
}
