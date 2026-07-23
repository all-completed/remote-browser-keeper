// Zero-knowledge synced vault (secrets / fields / cards) — Keeper client half.
//
// The vault lets a saved field value live in a THIRD place, beside the two existing
// scopes (in-memory "session" and on-device "forever"): an end-to-end encrypted blob
// synced across every paired Keeper through the service's /api/vault endpoint. The
// service stores only opaque ciphertext and holds no key — see the service repo's
// docs/vault-sync.md. Encryption reuses the same session `secret` the Keeper already
// holds for zero-knowledge session decryption (secrets.js), keyed by sha256(secret).
//
// Envelope: base64( iv(12) ‖ ciphertext ‖ authTag(16) ), AES-256-GCM, key =
// sha256(secret). format = "aesgcm-sha256-v1". The layout is deliberately plain
// WebCrypto-compatible so the mobile Keeper shares the exact same blob.
import crypto from "node:crypto";

export const VAULT_FORMAT = "aesgcm-sha256-v1";
export const VAULT_SCHEMA = 1;

export function secretIdOf(secret) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}
function keyOf(secret) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest(); // 32 bytes
}

export function encryptVault(secret, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj || {}), "utf8")), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
}
export function decryptVault(secret, b64) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (buf.length < 28) throw new Error("vault ciphertext too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", keyOf(secret), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

export function emptyVault() {
  return { schema: VAULT_SCHEMA, fields: {} };
}

// Per-entry last-write-wins merge. Each value is an entry carrying an `updated_at`
// ISO timestamp — a live { value, auto, updated_at } or a tombstone
// { deleted: true, updated_at }. Higher updated_at wins; a tie resolves to remote so
// two devices always converge to the same choice.
export function mergeFieldMaps(remote, local) {
  const out = {};
  const at = (e) => (e && typeof e.updated_at === "string" ? e.updated_at : "");
  for (const k of new Set([...Object.keys(remote || {}), ...Object.keys(local || {})])) {
    const r = remote && remote[k];
    const l = local && local[k];
    out[k] = r && l ? (at(l) > at(r) ? l : r) : r || l;
  }
  return out;
}

const apiUrl = (b) => String(b || "").replace(/\/+$/, "") + "/api/vault";
const authHeaders = (k) => (k ? { Authorization: `Bearer ${k}` } : {});

// Pull the current vault. Returns { version, data } — version 0 + empty vault when
// the server has none yet (404). Throws if the stored blob was encrypted under a
// different secret than the one we hold (secret_id mismatch).
export async function pullVault({ baseUrl, apiKey }, secret, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(apiUrl(baseUrl), { headers: authHeaders(apiKey) });
  if (res.status === 404) return { version: 0, data: emptyVault() };
  if (!res.ok) throw new Error(`vault GET failed: ${res.status}`);
  const body = await res.json();
  if (body.secret_id && body.secret_id !== secretIdOf(secret)) throw new Error("vault secret mismatch");
  return { version: Number(body.version) || 0, data: decryptVault(secret, body.ciphertext) };
}

// Push `data` at `baseVersion`. On the service's optimistic-concurrency 409 returns
// { conflict: true, current } so the caller can re-pull, re-merge and retry.
export async function putVault({ baseUrl, apiKey }, secret, data, baseVersion, { fetchImpl = fetch } = {}) {
  const body = {
    ciphertext: encryptVault(secret, data),
    secret_id: secretIdOf(secret),
    format: VAULT_FORMAT,
    base_version: Number(baseVersion) || 0,
  };
  const res = await fetchImpl(apiUrl(baseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    let current = null;
    try { current = (await res.json())?.detail?.current || null; } catch { /* ignore */ }
    return { conflict: true, current };
  }
  if (!res.ok) throw new Error(`vault PUT failed: ${res.status}`);
  const out = await res.json().catch(() => ({}));
  return { ok: true, version: out?.metadata?.version };
}

// Pull → mutate(remoteFields) → push at the pulled version, retrying on 409 by
// re-pulling and re-applying. `mutate` receives the decrypted remote field map and
// returns the field map to store (an idempotent merge, so re-applying is safe).
// Returns the final field map that was pushed.
export async function syncVault(cfg, secret, mutate, { fetchImpl = fetch, retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { version, data } = await pullVault(cfg, secret, { fetchImpl });
    const remoteFields = (data && data.fields) || {};
    const nextFields = mutate({ ...remoteFields }) || {};
    // Nothing changed relative to what the server already holds — skip the write so
    // routine syncs (e.g. on every reconnect) don't churn the version between devices.
    if (version > 0 && stableStringify(nextFields) === stableStringify(remoteFields)) return nextFields;
    const res = await putVault(cfg, secret, { schema: VAULT_SCHEMA, fields: nextFields }, version, { fetchImpl });
    if (res.conflict) continue;
    return nextFields;
  }
  throw new Error("vault sync failed after repeated version conflicts");
}

// Order-independent JSON for the no-op comparison above (object key order in the
// decrypted blob isn't significant).
function stableStringify(obj) {
  if (!obj || typeof obj !== "object") return JSON.stringify(obj);
  return JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}
