// Secret store for the Keeper — holds the session-encryption secrets the service
// asks for (by `secret_id`) so encrypted sessions can be decrypted without the
// service ever persisting the key (zero-knowledge session encryption).
//
// Phase 1 backend: a plaintext JSON file under the Keeper's own per-env home,
//   ~/.remote-browser-keeper/<base-url>/secrets.json   (chmod 600)
// shape: { base_url, secrets: { <secret_id>: { secret, label, user_id, source } } }
// Future (see service docs/TODO.md): a macOS Keychain backend. The store interface
// is intentionally backend-agnostic so the swap is transparent to callers.
//
// Security: secret VALUES are returned only to the WS `secret_request` handler and
// never logged. Only `secret_id` (a sha256 hash) and non-secret metadata are logged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Same sanitisation main.js uses for the per-env data dir, so the secrets file
// sits beside history.jsonl/screenshots for the same service URL.
function sanitizeForPath(s) {
  return (
    String(s || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .replace(/[^A-Za-z0-9._-]/g, "_") || "default"
  );
}

export function vaultPath(baseUrl) {
  return path.join(os.homedir(), ".remote-browser-keeper", sanitizeForPath(baseUrl), "secrets.json");
}

export function secretIdOf(secret) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}

// True iff `secret` is the one identified by `secretId` (sha256). Used to verify a
// secret before handing it back, and to guard against a tampered vault.
export function verifySecretId(secret, secretId) {
  if (typeof secret !== "string" || typeof secretId !== "string") return false;
  const a = Buffer.from(secretIdOf(secret));
  const b = Buffer.from(secretId.trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Filesystem backend ----------
class FileSystemSecretStore {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.file = vaultPath(baseUrl);
  }

  _read() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  // Return the secret string for a secret_id, or null. Verified against the id so a
  // corrupted/edited vault can't yield a wrong key.
  getSecret(secretId) {
    if (typeof secretId !== "string" || !secretId.trim()) return null;
    const entry = (this._read().secrets || {})[secretId.trim().toLowerCase()];
    const secret = entry && typeof entry.secret === "string" ? entry.secret : null;
    if (!secret) return null;
    return verifySecretId(secret, secretId) ? secret : null;
  }

  has(secretId) {
    return this.getSecret(secretId) !== null;
  }

  // Non-secret metadata only (safe to log) — { label, user_id, source } or null.
  meta(secretId) {
    const entry = (this._read().secrets || {})[String(secretId || "").trim().toLowerCase()];
    if (!entry) return null;
    const { secret, ...rest } = entry; // drop the secret
    return rest;
  }

  listSecretIds() {
    return Object.keys(this._read().secrets || {});
  }
}

// Factory — returns the Phase 1 filesystem backend. A future Keychain backend is
// selected here (e.g. by env or platform) without touching callers.
export function createSecretStore({ baseUrl }) {
  return new FileSystemSecretStore(baseUrl);
}
