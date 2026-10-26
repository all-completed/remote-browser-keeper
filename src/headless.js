// Headless Keeper unlock, desktop side (rbkeeper-unlock-v1, umbrella
// vasyaod/remote-browser-service#81, Part 2).
//
// A headless Keeper daemon starts locked: it has no vault password and no device token.
// On every boot it makes a fresh X25519 key pair (EK), signs an `unlock_request` with its
// long-lived Ed25519 identity key (IK), and the service relays that request to this
// desktop Keeper. The owner compares a short code and clicks Approve. The desktop then
// mints a fresh device token for that boot and HPKE-seals the vault key and that token to
// the EK. The service only relays opaque bytes: it never sees the vault password or the
// token in clear.
//
// What makes a request approvable is the vault PIN, not the service. The owner pins the
// daemon's Ed25519 public key once, by hand ("Add headless Keeper…"). The pin is stored in
// the encrypted vault (`headless_keepers`), so every paired desktop shares it and the
// service cannot forge or swap it. A request from an id with no pin, or one whose
// signature fails against the pinned key, is never shown as approvable.
//
// This module is pure (no electron) so all of it can be tested offline. The byte-level
// rules shared with the daemon (Part 3) are in docs/rbkeeper-unlock-v1.md and pinned by
// test/vectors/rbkeeper-unlock-v1.json.
import crypto from "node:crypto";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { mergeFieldMaps } from "./vault.js";

export const PROTOCOL = "rbkeeper-unlock-v1";
// How far a request's `ts` may sit from this clock. The service enforces ±120 s on
// arrival. This side only has to refuse a request that was clearly held back and replayed
// later, so it allows for desktop clock skew and a request that waited in the relay.
export const MAX_SKEW_SEC = 15 * 60;
// How long an unlock window stays up (the service resolves the request at 10 min too).
export const UNLOCK_TIMEOUT_MS = 10 * 60 * 1000;
// The fields the daemon signs, and nothing else. The service ADDS request_id and name
// after signing. Naming the signed set explicitly means no unsigned field can ride along
// as if it had been signed.
export const SIGNED_FIELDS = ["type", "headless_id", "boot_id", "eph_pub", "ts", "nonce"];

const NAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const BOOT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ID_RE = /^rbk1-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
const NONCE_RE = /^[A-Za-z0-9+/=_-]{8,128}$/;

// ---------- encodings ----------

// Canonical JSON: object keys sorted (by UTF-16 code unit, which for the ASCII keys the
// protocol uses is byte order), no whitespace, strings escaped exactly as JSON.stringify
// escapes them, and numbers limited to safe integers so no float formatting is involved.
export function canonicalJson(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("canonical JSON allows integers only");
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => {
      if (v[k] === undefined) throw new Error("canonical JSON has no undefined");
      return JSON.stringify(k) + ":" + canonicalJson(v[k]);
    }).join(",") + "}";
  }
  throw new Error("canonical JSON: unsupported " + typeof v);
}

// Standard base64 with padding. Decoding is strict: input that does not re-encode to
// itself (whitespace, url-safe alphabet, missing padding) is rejected, so one value never
// has two spellings.
export const b64 = (bytes) => Buffer.from(bytes).toString("base64");
export function unb64(s, len) {
  if (typeof s !== "string" || !s) return null;
  const buf = Buffer.from(s, "base64");
  if (buf.toString("base64") !== s) return null;
  if (len != null && buf.length !== len) return null;
  return buf;
}

const sha256 = (...parts) => {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const groups = (hex) => hex.match(/.{4}/g).join("-");

// rbk1-XXXX-XXXX-XXXX: the first 6 bytes of SHA-256(raw Ed25519 public key). It is the
// daemon's `headless_id` and what the owner compares when adding the daemon.
export function fingerprint(pub) {
  return "rbk1-" + groups(sha256(pub).subarray(0, 6).toString("hex").toUpperCase());
}

// XXXX-XXXX: the first 4 bytes of SHA-256(eph_pub raw ‖ utf8(boot_id)). Both ends show
// it. A relay that swapped the EK would change it.
export function comparisonCode(ephPub, bootId) {
  return groups(sha256(ephPub, Buffer.from(String(bootId), "utf8")).subarray(0, 4).toString("hex").toUpperCase());
}

// HPKE info: utf8("rbkeeper-unlock-v1|" + headless_id + "|" + boot_id). This binds the
// sealed payload to one daemon and one boot.
export const unlockInfo = (headlessId, bootId) => Buffer.from(`${PROTOCOL}|${headlessId}|${bootId}`, "utf8");

// ---------- Ed25519 ----------

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

// Parse what the owner pasted: the daemon's base64 Ed25519 public key (32 raw bytes).
// Returns { pub, id } or null.
export function parsePublicKey(text) {
  const pub = unb64(String(text || "").trim(), 32);
  if (!pub) return null;
  try { crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub]), format: "der", type: "spki" }); } catch { return null; }
  return { pub, id: fingerprint(pub) };
}

export function ed25519Verify(pub, msg, sig) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub]), format: "der", type: "spki" });
    return crypto.verify(null, msg, key, sig);
  } catch { return false; }
}

// The exact bytes the daemon signs.
export function signedBytes(msg) {
  const o = {};
  for (const k of SIGNED_FIELDS) o[k] = msg[k];
  return Buffer.from(canonicalJson(o), "utf8");
}

// ---------- pins (vault collection `headless_keepers`) ----------

export const isValidName = (name) => typeof name === "string" && NAME_RE.test(name);

// A new pin, keyed by the key's fingerprint. Entries merge last-write-wins by
// updated_at like every other vault collection, and a removal is a tombstone.
export function pinEntry({ name, pub, now = new Date() }) {
  const at = now.toISOString();
  return { id: fingerprint(pub), entry: { name, ed25519_pub: b64(pub), added_at: at, updated_at: at } };
}
export const pinTombstone = (now = new Date()) => ({ deleted: true, updated_at: now.toISOString() });
export const mergeHeadlessPins = (remote, local) => mergeFieldMaps(remote || {}, local || {});
// The live pins only (tombstones and malformed entries dropped).
export function activePins(pins) {
  const out = {};
  for (const [id, e] of Object.entries(pins || {})) {
    if (!e || e.deleted || !isValidName(e.name)) continue;
    const pub = unb64(e.ed25519_pub, 32);
    if (!pub || fingerprint(pub) !== id) continue; // a pin whose key and id disagree is ignored
    out[id] = e;
  }
  return out;
}

// ---------- the request ----------

// Check a relayed unlock_request against the pins. Returns
//   { ok: true, headlessId, bootId, requestId, ephPub, ts, name, code }
// or { ok: false, reason } with reason one of malformed | unknown | bad-signature | stale.
// `name` always comes from the PIN. The service's `name` is only a label and is never
// trusted.
export function verifyUnlockRequest(msg, pins, { now = Date.now() } = {}) {
  if (!msg || msg.type !== "unlock_request") return { ok: false, reason: "malformed" };
  const { headless_id: headlessId, boot_id: bootId, request_id: requestId, ts, nonce } = msg;
  const ephPub = unb64(msg.eph_pub, 32);
  const sig = unb64(msg.sig, 64);
  if (typeof headlessId !== "string" || !ID_RE.test(headlessId) || typeof bootId !== "string" || !BOOT_ID_RE.test(bootId)
    || typeof requestId !== "string" || !requestId || requestId.length > 128 || !Number.isSafeInteger(ts)
    || typeof nonce !== "string" || !NONCE_RE.test(nonce) || !ephPub || !sig) {
    return { ok: false, reason: "malformed" };
  }
  const pin = activePins(pins)[headlessId];
  if (!pin) return { ok: false, reason: "unknown" };
  if (!ed25519Verify(unb64(pin.ed25519_pub, 32), signedBytes(msg), sig)) return { ok: false, reason: "bad-signature" };
  if (Math.abs(Math.floor(now / 1000) - ts) > MAX_SKEW_SEC) return { ok: false, reason: "stale" };
  return { ok: true, headlessId, bootId, requestId, ephPub, ts, nonce, name: pin.name, code: comparisonCode(ephPub, bootId) };
}

// Requests already seen in this run, by nonce and by request_id. The service rejects
// nonce replays too. This is the desktop's own check, so a relay that replays an old
// request cannot get a second token minted.
export function createReplayGuard(limit = 512) {
  const seen = new Set();
  return {
    // true the first time a key is offered, false after that
    first(...keys) {
      if (keys.some((k) => seen.has(k))) return false;
      for (const k of keys) {
        seen.add(k);
        if (seen.size > limit) seen.delete(seen.values().next().value);
      }
      return true;
    },
  };
}

// ---------- HPKE seal (RFC 9180 base mode, X25519 / HKDF-SHA256 / ChaCha20-Poly1305) ----------

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
export const hpkeSuite = suite;

// The sealed plaintext: canonical JSON of
//   { v: 1, vault: { password, format, salt? }, device_token, issued_at }
export function buildUnlockPayload({ vaultKey, deviceToken, now = Date.now() }) {
  if (!vaultKey || typeof vaultKey.password !== "string" || typeof vaultKey.format !== "string") throw new Error("no vault key");
  if (typeof deviceToken !== "string" || !deviceToken) throw new Error("no device token");
  const vault = { password: vaultKey.password, format: vaultKey.format };
  if (vaultKey.salt) vault.salt = vaultKey.salt;
  return { v: 1, vault, device_token: deviceToken, issued_at: Math.floor(now / 1000) };
}

// Seal `payload` to the boot's EK. aad = utf8(request_id). `ekm` (the sender's
// ephemeral key material) exists only so test vectors are deterministic. Production
// leaves it unset, so a fresh random sender key is used.
export async function sealUnlock({ ephPub, headlessId, bootId, requestId, payload, ekm }) {
  const recipientPublicKey = await suite.kem.deserializePublicKey(new Uint8Array(ephPub));
  const sender = await suite.createSenderContext({ recipientPublicKey, info: unlockInfo(headlessId, bootId), ...(ekm ? { ekm } : {}) });
  const pt = Buffer.from(canonicalJson(payload), "utf8");
  try {
    const ct = await sender.seal(pt, Buffer.from(String(requestId), "utf8"));
    return { enc: b64(Buffer.from(sender.enc)), ciphertext: b64(Buffer.from(ct)) };
  } finally {
    pt.fill(0); // best effort: do not leave the clear payload in this buffer
  }
}

// The daemon's half, used here by the tests and the shared vector.
export async function openUnlock({ ephPriv, headlessId, bootId, requestId, enc, ciphertext }) {
  const recipientKey = await suite.kem.deserializePrivateKey(new Uint8Array(ephPriv));
  const r = await suite.createRecipientContext({ recipientKey, enc: unb64(enc), info: unlockInfo(headlessId, bootId) });
  const pt = await r.open(unb64(ciphertext), Buffer.from(String(requestId), "utf8"));
  return JSON.parse(Buffer.from(pt).toString("utf8"));
}

// ---------- service API ----------

const apiUrl = (baseUrl, p) => String(baseUrl || "").replace(/\/+$/, "") + p;
const jsonHeaders = (apiKey) => ({ "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) });

async function call(cfg, method, p, body, fetchImpl) {
  const res = await fetchImpl(apiUrl(cfg.baseUrl, p), {
    method,
    headers: jsonHeaders(cfg.apiKey),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Register a pinned daemon with the service, so its WS is accepted and its requests are
// relayed. Idempotent: the same id + key again is a retry.
export async function registerHeadless(cfg, { id, name, pub }, { fetchImpl = fetch } = {}) {
  const r = await call(cfg, "POST", "/api/keeper/headless", { id, name, ed25519_pub: b64(pub) }, fetchImpl);
  if (!r.ok) throw new Error(`registering with the service failed (HTTP ${r.status})`);
}

export async function deleteHeadless(cfg, id, { fetchImpl = fetch } = {}) {
  const r = await call(cfg, "DELETE", `/api/keeper/headless/${encodeURIComponent(id)}`, undefined, fetchImpl);
  if (!r.ok && r.status !== 404) throw new Error(`removing from the service failed (HTTP ${r.status})`);
}

export class SecretBoundToken extends Error {
  constructor() {
    super("the service issued a session-secret-bound token; a headless Keeper must get a secret-less one");
    this.name = "SecretBoundToken";
  }
}

export const headlessDeviceName = (name, bootId) => `headless:${name}:${bootId}`;

// Mint the boot's device token. It has to be SECRET-LESS: the daemon gets the vault key
// through the sealed payload and must not hold the account's session secret too. A
// response that does not say `secret_bound: false` is treated as bound. The just-minted
// device is then revoked and SecretBoundToken is thrown, so nothing gets sealed.
export async function enrollHeadlessDevice(cfg, { name, bootId, appVersion }, { fetchImpl = fetch } = {}) {
  const r = await call(cfg, "POST", "/api/keeper/devices/enroll", {
    device_name: headlessDeviceName(name, bootId), platform: "headless", ...(appVersion ? { app_version: appVersion } : {}), secret_less: true,
  }, fetchImpl);
  const deviceId = r.data && r.data.device && r.data.device.device_id;
  if (!r.ok || !r.data || typeof r.data.token !== "string" || !r.data.token || typeof deviceId !== "string") {
    throw new Error(`device enrollment failed (HTTP ${r.status})`);
  }
  if (r.data.secret_bound !== false) {
    try { await revokeDevice(cfg, deviceId, { fetchImpl }); } catch { /* reported below either way */ }
    throw new SecretBoundToken();
  }
  return { token: r.data.token, deviceId };
}

export async function revokeDevice(cfg, deviceId, { fetchImpl = fetch } = {}) {
  const r = await call(cfg, "DELETE", `/api/keeper/devices/${encodeURIComponent(deviceId)}`, undefined, fetchImpl);
  if (!r.ok && r.status !== 404) throw new Error(`revoking a device failed (HTTP ${r.status})`);
}

// Revoke every earlier `headless:<name>:*` device except `keepId` (the one just minted),
// so one daemon holds at most one live token. Returns how many were revoked.
export async function revokeOlderHeadless(cfg, name, keepId, { fetchImpl = fetch } = {}) {
  const r = await call(cfg, "GET", "/api/keeper/devices", undefined, fetchImpl);
  if (!r.ok || !r.data || !Array.isArray(r.data.devices)) throw new Error(`listing devices failed (HTTP ${r.status})`);
  const prefix = `headless:${name}:`;
  let n = 0;
  for (const d of r.data.devices) {
    if (!d || d.device_id === keepId || typeof d.device_name !== "string" || !d.device_name.startsWith(prefix)) continue;
    await revokeDevice(cfg, d.device_id, { fetchImpl });
    n += 1;
  }
  return n;
}

// ---------- logging ----------

// The only fields an unlock log line may carry: identifiers and outcomes. Never a key,
// token, password, ciphertext or signature.
const LOGGABLE = ["request_id", "headless_id", "boot_id", "name", "reason", "status", "revoked"];
export function unlockLogLine(event, fields = {}) {
  const parts = [];
  for (const k of LOGGABLE) if (fields[k] != null) parts.push(`${k}=${String(fields[k]).slice(0, 80)}`);
  return `[keeper] unlock ${event}` + (parts.length ? " " + parts.join(" ") : "");
}
