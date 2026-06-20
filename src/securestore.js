// Encrypted-at-rest JSON storage for sensitive keeper data (cards).
//
// On macOS (and any OS where Electron `safeStorage` is available) the JSON is
// encrypted with an OS-managed key kept in the **Keychain** — "Once forever":
// a signed/stable app is on the key's ACL, so reads decrypt without re-prompting,
// every launch. On other platforms (or outside Electron) it falls back to a
// plaintext file. Reads transparently handle both, so existing plaintext files
// auto-migrate to encrypted on the next write.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MARK = "__securestore_v1__";

let _safe; // undefined = not probed yet; null/false = unavailable; object = safeStorage
let _override; // test hook
function safeStorage() {
  if (_override !== undefined) return _override;
  if (_safe === undefined) {
    try {
      const e = require("electron");
      _safe = e && e.safeStorage && typeof e.safeStorage.isEncryptionAvailable === "function" ? e.safeStorage : null;
    } catch {
      _safe = null;
    }
  }
  return _safe || null;
}

// True when OS-encrypted storage (Keychain) is usable right now.
export function available() {
  const s = safeStorage();
  try { return !!(s && s.isEncryptionAvailable()); } catch { return false; }
}

// Read a JSON object from `filePath`. Decrypts if the file is an encrypted
// envelope; otherwise parses plaintext. Returns {} on any failure/missing file.
export function readJson(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); } catch { return {}; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (parsed && parsed[MARK] && typeof parsed.cipher === "string") {
    const s = safeStorage();
    if (!s) return {}; // encrypted, but no key here (e.g. file moved to another machine)
    try {
      return JSON.parse(s.decryptString(Buffer.from(parsed.cipher, "base64"))) || {};
    } catch {
      return {};
    }
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

// Write a JSON object to `filePath`: encrypted envelope when available, else
// plaintext. chmod 600 either way.
export function writeJson(filePath, obj) {
  const json = JSON.stringify(obj || {}, null, 2);
  let out = json;
  if (available()) {
    const cipher = safeStorage().encryptString(json).toString("base64");
    out = JSON.stringify({ [MARK]: 1, cipher }, null, 2);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, out);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

// Test hook: inject a fake safeStorage (or null) — not used in production.
export function _setSafeForTest(s) { _override = s; }
