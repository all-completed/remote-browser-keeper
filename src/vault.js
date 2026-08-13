// Zero-knowledge synced vault (secrets / fields / cards) — Keeper client half.
//
// The vault lets a saved field value live in a THIRD place, beside the two existing
// scopes (in-memory "session" and on-device "forever"): an end-to-end encrypted blob
// synced across every paired Keeper through the service's /api/vault endpoint. The
// service stores only opaque ciphertext and holds no key — see the service repo's
// docs/vault-sync.md.
//
// KEY MODEL (v2). The vault is encrypted with a DEDICATED vault password (vaultkey.js),
// independent of the session secret. Two independent values are derived with domain
// separation so the identifier can NEVER equal the key (the v1 bug: secret_id was
// sha256(secret) === the AES key, which the server stored in plaintext):
//   master   = sha256(password)                    [aesgcm-sha256-v2, high-entropy]
//            = pbkdf2_sha256(password, salt, ITER)  [aesgcm-pbkdf2-v2, user password]
//   encKey   = master                               (AES-256-GCM key)
//   secret_id= sha256("rbvault-id-v2" ‖ master)     (opaque tag; reveals nothing of encKey)
//
// Envelope (base64), chosen so node:crypto and WebCrypto produce identical bytes:
//   aesgcm-sha256-v2 :        iv(12) ‖ ciphertext ‖ tag(16)
//   aesgcm-pbkdf2-v2 : salt(16) ‖ iv(12) ‖ ciphertext ‖ tag(16)   (salt is not secret)
// Legacy aesgcm-sha256-v1 (key = sha256(session secret), secret_id = hex(key)) is
// decrypt-only, used once to migrate an existing vault onto v2.
import crypto from "node:crypto";

export const VAULT_SCHEMA = 1;
export const FORMAT_V1 = "aesgcm-sha256-v1"; // legacy (decrypt-only, for migration)
export const FORMAT_SHA256_V2 = "aesgcm-sha256-v2"; // high-entropy generated password
export const FORMAT_PBKDF2_V2 = "aesgcm-pbkdf2-v2"; // user-chosen password
export const PBKDF2_ITERATIONS = 210000;
const SALT_BYTES = 16;
const ID_DOMAIN = Buffer.from("rbvault-id-v2", "utf8");

const _sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();

// --- key derivation -------------------------------------------------------------
// A vault key config is { password, format, salt? } (salt base64, pbkdf2 only).
function _masterSha256(password) {
  return _sha256(Buffer.from(String(password), "utf8")); // 32 bytes
}
function _masterPbkdf2(password, saltBuf) {
  return crypto.pbkdf2Sync(Buffer.from(String(password), "utf8"), saltBuf, PBKDF2_ITERATIONS, 32, "sha256");
}
function _secretIdFromMaster(master) {
  return _sha256(Buffer.concat([ID_DOMAIN, master])).toString("hex");
}

// The master for a stored key config, plus the envelope prefix that format carries
// (the pbkdf2 salt; empty for sha256). One place so encrypt and the status report can
// never disagree about how a held key derives.
function _masterFromKey(key) {
  const format = key.format || FORMAT_SHA256_V2;
  if (format === FORMAT_PBKDF2_V2) {
    const salt = Buffer.from(String(key.salt || ""), "base64");
    if (salt.length !== SALT_BYTES) throw new Error("pbkdf2 vault key missing salt");
    return { format, master: _masterPbkdf2(key.password, salt), prefix: salt };
  }
  return { format, master: _masterSha256(key.password), prefix: Buffer.alloc(0) };
}

// Generate a fresh high-entropy vault password (item 1). base64url of 32 random bytes.
export function generateVaultKey() {
  return { password: crypto.randomBytes(32).toString("base64url"), format: FORMAT_SHA256_V2 };
}
// Build a user-password key (item 3) with a fresh random salt.
export function userVaultKey(password) {
  return { password: String(password), format: FORMAT_PBKDF2_V2, salt: crypto.randomBytes(SALT_BYTES).toString("base64") };
}

// --- encrypt / decrypt ----------------------------------------------------------
export function encryptVault(key, obj) {
  const { format, master, prefix } = _masterFromKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", master, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj || {}), "utf8")), cipher.final()]);
  return {
    ciphertext: Buffer.concat([prefix, iv, ct, cipher.getAuthTag()]).toString("base64"),
    secret_id: _secretIdFromMaster(master),
    format,
  };
}

// Derive the master for a stored blob using OUR password but the blob's own salt/format
// (the envelope is the source of truth). Returns { master, body } where body is the
// iv‖ct‖tag portion.
function _openEnvelope(format, password, b64) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  let off = 0;
  let master;
  if (format === FORMAT_PBKDF2_V2) {
    if (buf.length < SALT_BYTES + 28) throw new Error("vault ciphertext too short");
    const salt = buf.subarray(0, SALT_BYTES);
    off = SALT_BYTES;
    master = _masterPbkdf2(password, salt);
  } else {
    if (buf.length < 28) throw new Error("vault ciphertext too short");
    master = _masterSha256(password); // v1 and sha256-v2 both key = sha256(password)
  }
  return { master, body: buf.subarray(off) };
}
function _decryptBody(master, body) {
  const iv = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ct = body.subarray(12, body.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", master, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}
export function decryptVault(key, b64, format) {
  const fmt = format || key.format || FORMAT_SHA256_V2;
  const { master, body } = _openEnvelope(fmt, key.password, b64);
  return _decryptBody(master, body);
}
// The secret_id a stored blob of `format` would carry if it were ours (for the
// pull-time wrong-password check). v1 blobs used the legacy hex(master) id.
export function expectedSecretId(key, b64, format) {
  const fmt = format || key.format || FORMAT_SHA256_V2;
  const { master } = _openEnvelope(fmt, key.password, b64);
  return fmt === FORMAT_V1 ? master.toString("hex") : _secretIdFromMaster(master);
}

// Non-secret description of the vault key this device holds, for reporting to the
// service and showing in the UI: which blob schema we write, which key format we are on,
// and the opaque id of the vault we can open. `key` is a stored config (vaultkey.js) or
// null when this device holds none.
//
// SECURITY — the secret_id asymmetry. Under v2 the id is domain-separated from the AES
// key (sha256("rbvault-id-v2" ‖ master)) and reveals nothing, so it is safe to publish.
// Under legacy aesgcm-sha256-v1 the id IS the key (hex(sha256(password)), see the header),
// so a v1 device reports its FORMAT and NO id — publishing it would publish a live key.
// Any other reporting path must go through here rather than compute an id itself.
export function vaultKeyReport(key) {
  const base = { schema: VAULT_SCHEMA, has_key: false, key_format: null, legacy: false, secret_id: null };
  if (!key || typeof key.password !== "string" || !key.password) return base;
  const format = key.format || FORMAT_SHA256_V2;
  if (format === FORMAT_V1) return { ...base, has_key: true, key_format: FORMAT_V1, legacy: true };
  let secret_id = null;
  try { secret_id = _secretIdFromMaster(_masterFromKey(key).master); } catch { secret_id = null; } // e.g. pbkdf2 key with a lost salt
  return { ...base, has_key: true, key_format: format, secret_id };
}

// The vault blob is a set of independent collections, each a map of entries merged by
// per-entry last-write-wins (see mergeEntries). `fields` = saved field values;
// `cards` = saved payment cards (desktop-only feature; mobile preserves them untouched);
// `cardsMeta` = small card settings ({ autofill, default, updated_at }). Unknown keys are
// preserved so a newer client can add collections without older clients dropping them.
export function normalizeBlob(b) {
  const o = b && typeof b === "object" ? b : {};
  return { ...o, schema: VAULT_SCHEMA, fields: o.fields || {}, cards: o.cards || {}, cardsMeta: o.cardsMeta || {} };
}
export function emptyVault() {
  return normalizeBlob({});
}

// Per-entry last-write-wins merge (higher updated_at wins; tie → remote). Alias of the
// field merge, reused for the cards collection.
export const mergeEntries = mergeFieldMaps;

// Per-entry last-write-wins merge. Each value is a live { value, auto, updated_at } or a
// tombstone { deleted: true, updated_at }. Higher updated_at wins; a tie resolves to
// remote so two devices always converge to the same choice.
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

// Sentinel error so callers can distinguish "wrong password, re-pair" from transient
// network failures.
export class VaultKeyMismatch extends Error {
  constructor(msg) { super(msg || "vault secret mismatch"); this.name = "VaultKeyMismatch"; this.mismatch = true; }
}

// Pull the current vault. Returns { version, data, format }. version 0 + empty vault when
// the server has none yet (404). Throws VaultKeyMismatch if the stored blob was written
// under a different password (this device needs to re-pair to pick up the new one).
export async function pullVault({ baseUrl, apiKey }, key, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(apiUrl(baseUrl), { headers: authHeaders(apiKey) });
  if (res.status === 404) return { version: 0, data: emptyVault(), format: key.format };
  if (!res.ok) throw new Error(`vault GET failed: ${res.status}`);
  const body = await res.json();
  const fmt = body.format || key.format;
  if (body.secret_id) {
    let expect;
    try { expect = expectedSecretId(key, body.ciphertext, fmt); } catch { expect = null; }
    if (expect !== body.secret_id) throw new VaultKeyMismatch("vault password changed — re-pair this device");
  }
  return { version: Number(body.version) || 0, data: decryptVault(key, body.ciphertext, fmt), format: fmt };
}

// Push `data` at `baseVersion`. On the service's optimistic-concurrency 409 returns
// { conflict: true, current } so the caller can re-pull, re-merge and retry.
export async function putVault({ baseUrl, apiKey }, key, data, baseVersion, { fetchImpl = fetch } = {}) {
  const enc = encryptVault(key, normalizeBlob(data));
  const body = { ciphertext: enc.ciphertext, secret_id: enc.secret_id, format: enc.format, base_version: Number(baseVersion) || 0 };
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

// Pull → mergeBlob(remoteBlob) → push at the pulled version, retrying on 409 by
// re-pulling and re-applying. `mergeBlob` receives the decrypted remote blob (all
// collections) and returns the blob to store (an idempotent merge, so re-applying after
// a conflict is safe). Returns the final blob that was pushed. `onVersion` (optional) is
// called with the vault version this device is now on — the counter the caller reports as
// "last synced version"; it fires for a no-op skip too, since that version is current.
export async function syncVault(cfg, key, mergeBlob, { fetchImpl = fetch, retries = 5, onVersion = null } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { version, data, format } = await pullVault(cfg, key, { fetchImpl });
    const remoteBlob = normalizeBlob(data);
    const nextBlob = normalizeBlob(await mergeBlob(remoteBlob));
    // Skip a no-op write ONLY when the stored format already matches our key's format —
    // otherwise a re-key (password change) with unchanged data would never be pushed.
    if (version > 0 && format === key.format && stableStringify(nextBlob) === stableStringify(remoteBlob)) {
      if (onVersion) onVersion(version);
      return nextBlob;
    }
    const res = await putVault(cfg, key, nextBlob, version, { fetchImpl });
    if (res.conflict) continue;
    if (onVersion) onVersion(Number(res.version) || version + 1);
    return nextBlob;
  }
  throw new Error("vault sync failed after repeated version conflicts");
}

// --- legacy v1 (migration only) -------------------------------------------------
// Decrypt a v1 blob that was keyed by the SESSION secret (sha256(secret)), and the id it
// carried (hex(sha256(secret))). Used once to lift an existing vault onto v2.
export function legacyV1SecretId(sessionSecret) {
  return _masterSha256(sessionSecret).toString("hex");
}
export function decryptLegacyV1(sessionSecret, b64) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (buf.length < 28) throw new Error("v1 ciphertext too short");
  return _decryptBody(_masterSha256(sessionSecret), buf);
}

// Deep, order-independent JSON for the no-op comparison above (the blob nests per-entry
// maps whose key order isn't significant).
function stableStringify(obj) {
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  if (obj && typeof obj === "object") {
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
}
