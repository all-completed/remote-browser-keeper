// Encrypted-at-rest JSON storage for sensitive keeper data (saved fields, the vault
// key, session secrets).
//
// Uses Electron `safeStorage`, which encrypts with the OS secret store wherever a
// backend exists:
//   - macOS   → Keychain (prompts once, "Always Allow" → silent thereafter)
//   - Windows → DPAPI (per-user, transparent — no prompt)
//   - Linux   → libsecret (gnome-keyring / kwallet) when present
// Only where no backend is available (e.g. headless Linux, or outside Electron)
// does it fall back to a plaintext file. Reads transparently handle both, so an
// existing plaintext file auto-migrates to encrypted on the next write.
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

// How a read ended. A missing file is a legitimately empty store; a corrupt one, or
// an envelope we hold no key for, is data we HAVE and cannot see. Collapsing those
// into the same `{}` makes an unreadable store look like an empty one — for a store
// holding something irreplaceable that is a silent failure, so `readJsonState` keeps
// them apart and the caller decides which ones are fatal.
export const MISSING = "missing";             // no such file — an empty store
export const PLAINTEXT = "plaintext";         // read, but it is not encrypted at rest
export const ENCRYPTED = "encrypted";         // read out of an OS-encrypted envelope
export const UNREADABLE = "unreadable";       // the file exists but could not be read (EACCES…)
export const CORRUPT = "corrupt";             // not JSON, or not a JSON object
export const NO_KEY = "no-key";               // an envelope, but no OS backend here
export const UNDECRYPTABLE = "undecryptable"; // an envelope the OS backend refused to decrypt

// True when `state` means "there is data here we could not read" — as opposed to
// MISSING (nothing stored) or a successful PLAINTEXT/ENCRYPTED read.
export function readFailed(state) {
  return state === UNREADABLE || state === CORRUPT || state === NO_KEY || state === UNDECRYPTABLE;
}

// Thrown by `writeJson({ requireEncryption: true })` rather than writing a sensitive
// store to disk in the clear.
export class EncryptionUnavailable extends Error {
  constructor(filePath) {
    super(`no OS-encrypted storage backend is available; refusing to write ${path.basename(filePath)} in plaintext`);
    this.name = "EncryptionUnavailable";
  }
}

// Read a JSON object from `filePath`, reporting HOW it went — `{ state, data }`,
// with `data` always an object (`{}` unless the state is PLAINTEXT or ENCRYPTED).
export function readJsonState(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return { state: e && e.code === "ENOENT" ? MISSING : UNREADABLE, data: {}, error: e && e.message };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { state: CORRUPT, data: {}, error: e.message }; }
  if (parsed && parsed[MARK] && typeof parsed.cipher === "string") {
    const s = safeStorage();
    if (!s) return { state: NO_KEY, data: {} }; // encrypted, but no key here (e.g. file moved to another machine)
    let decoded;
    try { decoded = JSON.parse(s.decryptString(Buffer.from(parsed.cipher, "base64"))); }
    catch (e) { return { state: UNDECRYPTABLE, data: {}, error: e.message }; }
    return decoded && typeof decoded === "object"
      ? { state: ENCRYPTED, data: decoded }
      : { state: CORRUPT, data: {} };
  }
  return parsed && typeof parsed === "object" ? { state: PLAINTEXT, data: parsed } : { state: CORRUPT, data: {} };
}

// Read a JSON object from `filePath`. Decrypts if the file is an encrypted
// envelope; otherwise parses plaintext. Returns {} on any failure/missing file —
// use `readJsonState` when "empty" and "could not read it" must not be confused.
export function readJson(filePath) {
  return readJsonState(filePath).data;
}

// Write a JSON object to `filePath`: encrypted envelope when available, else
// plaintext. chmod 600 either way. With `requireEncryption`, a store that must never
// sit in the clear throws `EncryptionUnavailable` instead of taking that fallback.
export function writeJson(filePath, obj, { requireEncryption = false } = {}) {
  const encrypt = available();
  if (!encrypt && requireEncryption) throw new EncryptionUnavailable(filePath);
  const json = JSON.stringify(obj || {}, null, 2);
  let out = json;
  if (encrypt) {
    const cipher = safeStorage().encryptString(json).toString("base64");
    out = JSON.stringify({ [MARK]: 1, cipher }, null, 2);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Write-then-rename: a crash (or a full disk) mid-write must not be able to leave a
  // half-written store behind. For secrets.js, where the previous contents are the only
  // copy of something irreplaceable, replacing the file has to be all-or-nothing.
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, out);
  try { fs.chmodSync(tmp, 0o600); } catch {}
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// Test hook: inject a fake safeStorage (or null) — not used in production.
export function _setSafeForTest(s) { _override = s; }
