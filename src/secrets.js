// Secret store for the Keeper — holds the session-encryption secrets the service
// asks for (by `secret_id`) so encrypted sessions can be decrypted without the
// service ever persisting the key (zero-knowledge session encryption).
//
// At rest the secrets live OS-ENCRYPTED, in the same `securestore` envelope as the
// vault key and saved fields (safeStorage → Keychain / DPAPI / libsecret):
//   ~/.remote-browser-keeper/<base-url>/secrets.enc.json   (chmod 600)
// shape: { base_url, secrets: { <secret_id>: { secret, label, user_id, source } } }
//
// Provisioning still arrives in the clear: the service repo's external
// `scripts/export_session_secret.py` cannot call Electron `safeStorage`, so it keeps
// writing plaintext `secrets.json`. That file is therefore an INBOX, not the store —
// the first read that sees it MERGES its entries into the encrypted store and removes
// it, so no plaintext copy stands. Merge, never replace: the external writer starts a
// fresh file each time and must not be able to drop secrets already held.
// Where no OS backend exists at all (headless Linux, outside Electron) nothing is
// silently written in the clear — the inbox is left alone, chmod 600, and the reason
// is logged once.
//
// Security: secret VALUES are returned only to the WS `secret_request` handler and
// never logged. Only `secret_id` (a sha256 hash) and non-secret metadata are logged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  readJsonState, writeJson, readFailed, available,
  ENCRYPTED, PLAINTEXT,
} from "./securestore.js";

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

// The plaintext provisioning INBOX the external export script writes.
export function vaultPath(baseUrl) {
  return path.join(os.homedir(), ".remote-browser-keeper", sanitizeForPath(baseUrl), "secrets.json");
}

// The OS-encrypted store the Keeper actually keeps the secrets in.
export function securePath(baseUrl) {
  return path.join(os.homedir(), ".remote-browser-keeper", sanitizeForPath(baseUrl), "secrets.enc.json");
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

// `_read()` runs on every lookup, so anything it cannot fix must be said once, not
// once per `secret_request`. Keyed by file + reason.
const warned = new Set();
function warnOnce(key, ...msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(...msg);
}

// Union of two store objects, by secret_id. `incoming` (the freshly provisioned
// inbox) wins a tie on the metadata, but NEVER removes an id the encrypted store
// already holds — losing one means an encrypted session can no longer be unlocked.
function mergeStores(held, incoming) {
  return {
    ...(held || {}),
    ...(incoming || {}),
    secrets: { ...((held || {}).secrets || {}), ...((incoming || {}).secrets || {}) },
  };
}

function countSecrets(store) {
  return Object.keys((store || {}).secrets || {}).length;
}

// Remove a plaintext file, overwriting its bytes first. Best effort: on a journalling
// or copy-on-write filesystem the old blocks can survive an in-place overwrite. What
// this does guarantee is that no plaintext copy is reachable through the filesystem
// afterwards.
function shred(file) {
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r+");
      try {
        fs.writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch { /* overwrite is a bonus; the unlink below is the point */ }
  fs.rmSync(file, { force: true });
}

// ---------- Filesystem backend ----------
class FileSystemSecretStore {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.file = vaultPath(baseUrl);       // plaintext provisioning inbox
    this.secureFile = securePath(baseUrl); // OS-encrypted store
  }

  _read() {
    const held = readJsonState(this.secureFile);
    if (readFailed(held.state)) {
      // The store exists and we cannot read it. Without this the Keeper would answer
      // every secret_request with "not in vault" and look like it simply holds none.
      warnOnce(`${this.secureFile}:${held.state}`,
        `[keeper] secrets: cannot read ${this.secureFile} (${held.state})${held.error ? ": " + held.error : ""} —`,
        "secrets held there are unavailable until this is resolved");
    } else if (held.state === PLAINTEXT) {
      warnOnce(`${this.secureFile}:plain`, `[keeper] secrets: ${this.secureFile} is not encrypted at rest`);
    }

    const inbox = readJsonState(this.file);
    if (readFailed(inbox.state)) {
      warnOnce(`${this.file}:${inbox.state}`,
        `[keeper] secrets: cannot read ${this.file} (${inbox.state})${inbox.error ? ": " + inbox.error : ""}`);
    }

    const merged = mergeStores(held.data, inbox.data);
    // Only ever migrate an inbox we actually READ: a corrupt or unreadable one is
    // warned about above and left exactly as it is — shredding it would destroy the
    // only copy of something we merely failed to parse.
    const readable = inbox.state === PLAINTEXT || inbox.state === ENCRYPTED;
    if (readable && countSecrets(inbox.data) > 0) {
      this._absorbInbox(merged, countSecrets(inbox.data), held.state);
    }
    return merged;
  }

  // Move an existing store we could not READ out of the absorb's way, to the first
  // free `.unreadable[-N]` name — never onto one, since an earlier reset may have
  // parked a different envelope there and overwriting it is the very loss this
  // avoids. Returns where the bytes now live; throws if it could not be moved (the
  // caller then leaves everything where it is).
  _preserveUnreadable() {
    for (let n = 1; n <= 50; n++) {
      const aside = `${this.secureFile}.unreadable${n > 1 ? `-${n}` : ""}`;
      if (fs.existsSync(aside)) continue;
      fs.renameSync(this.secureFile, aside);
      return aside;
    }
    throw new Error(`${path.basename(this.secureFile)}.unreadable-N: no free name to move the unreadable store to`);
  }

  // Fold the plaintext inbox into the encrypted store and remove it. The inbox is only
  // shredded once the encrypted copy reads back holding every id, so a failed write
  // can never be the step that loses a secret.
  //
  // `heldState` matters when it means "there IS a store here and we could not read
  // it" (a reset login keyring or DPAPI profile leaves old envelopes UNDECRYPTABLE
  // while encryption itself stays available; a store copied from another machine is
  // the same). `merged` then holds the inbox alone, so replacing the file would
  // rename a fresh envelope over bytes that are still RECOVERABLE — restore the key
  // and they decrypt — and the read-back check, which only knows the ids it just
  // wrote, would pass and shred the inbox. So those bytes are moved aside first,
  // never written over.
  _absorbInbox(merged, incomingCount, heldState) {
    if (!available()) {
      // No OS backend: writing the "encrypted" store would just be a second plaintext
      // file. Leave the inbox as the single copy and hold it to the 600 the docs claim.
      try { fs.chmodSync(this.file, 0o600); } catch { /* not ours / not there */ }
      warnOnce(`${this.file}:noenc`,
        `[keeper] secrets: no OS encryption backend — ${this.file} stays plaintext (chmod 600); secrets are NOT encrypted at rest`);
      return;
    }
    try {
      let aside = null;
      if (readFailed(heldState)) aside = this._preserveUnreadable();
      writeJson(this.secureFile, merged, { requireEncryption: true });
      const back = readJsonState(this.secureFile);
      const ids = Object.keys(merged.secrets || {});
      if (back.state !== ENCRYPTED || ids.some((id) => !(back.data.secrets || {})[id])) {
        throw new Error(`read-back check failed (${back.state}, ${countSecrets(back.data)}/${ids.length} secrets)`);
      }
      shred(this.file);
      console.log(`[keeper] secrets: moved ${incomingCount} plaintext secret(s) into the OS-encrypted store`);
      if (aside) {
        console.warn(`[keeper] secrets: the previous ${this.secureFile} was ${heldState}; its bytes are kept at ${aside} —`,
          "recover the OS key it was encrypted with to read them, and MERGE them back (do not just rename it over the new store)");
      }
    } catch (e) {
      try { fs.chmodSync(this.file, 0o600); } catch { /* not ours / not there */ }
      warnOnce(`${this.file}:migrate`,
        `[keeper] secrets: could not encrypt ${this.file} (${e.message}) — it stays plaintext, chmod 600`);
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

  // The session secret to key the synced vault with (vault.js). The vault is
  // per-user and there is normally exactly one held secret; if several exist we
  // take the first that still verifies against its id. Returns null when none.
  firstSecret() {
    for (const id of this.listSecretIds()) {
      const s = this.getSecret(id);
      if (s) return s;
    }
    return null;
  }
}

// Factory — returns the Phase 1 filesystem backend. A future Keychain backend is
// selected here (e.g. by env or platform) without touching callers.
export function createSecretStore({ baseUrl }) {
  return new FileSystemSecretStore(baseUrl);
}
