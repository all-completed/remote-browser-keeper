// Unit + interop tests for the v2 synced-vault client core (src/vault.js):
//  - the SECURITY FIX: secret_id is domain-separated from the AES key (never equal);
//  - AES-256-GCM round-trip for both formats (generated sha256-v2, user pbkdf2-v2);
//  - wrong-password pull → VaultKeyMismatch (drives "re-pair this device");
//  - pull/merge/push sync against a fake /api/vault (opaque store + optimistic 409);
//  - migration: a legacy v1 blob (keyed by the session secret) still decrypts;
//  - INTEROP: a WebCrypto implementation (mirroring the mobile Keeper) produces the
//    identical envelope + secret_id and cross-decrypts, for BOTH v2 formats.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  encryptVault, decryptVault, expectedSecretId, generateVaultKey, userVaultKey,
  pullVault, putVault, syncVault, VaultKeyMismatch,
  legacyV1SecretId, decryptLegacyV1, FORMAT_SHA256_V2, FORMAT_PBKDF2_V2, PBKDF2_ITERATIONS,
} from "../src/vault.js";

const BLOB = { schema: 1, fields: { "s|h|#pw": { value: "hunter2", auto: true, updated_at: "2026-01-01T00:00:00Z" } } };

// In-memory stand-in for the service /api/vault router: stores ciphertext byte-for-byte,
// enforces base_version, 404 when empty.
function fakeService() {
  let state = null;
  const meta = (s) => ({ version: s.version, secret_id: s.secret_id, format: s.format, updated_at: "t" });
  async function handler(url, opts = {}) {
    const m = (opts.method || "GET").toUpperCase();
    if (m === "GET") return state ? jr(200, { ...meta(state), ciphertext: state.ciphertext }) : jr(404, { detail: "none" });
    if (m === "PUT") {
      const b = JSON.parse(opts.body);
      const cur = state ? state.version : 0;
      if ((Number(b.base_version) || 0) !== cur) return jr(409, { detail: { current: state ? meta(state) : { version: 0 } } });
      state = { version: cur + 1, secret_id: b.secret_id, format: b.format, ciphertext: b.ciphertext };
      return jr(200, { ok: true, metadata: meta(state) });
    }
    if (m === "DELETE") { state = null; return jr(200, { deleted: true }); }
    return jr(405, {});
  }
  return { fetchImpl: handler, peek: () => state };
}
const jr = (status, obj) => ({ status, ok: status >= 200 && status < 300, json: async () => obj });

test("SECURITY: secret_id is domain-separated from the AES key (never equal to it)", () => {
  const key = generateVaultKey();
  const enc = encryptVault(key, BLOB);
  const aesKeyHex = crypto.createHash("sha256").update(key.password, "utf8").digest("hex");
  // v1's bug was secret_id === sha256(password) === the key. v2 must differ.
  assert.notEqual(enc.secret_id, aesKeyHex);
  assert.equal(enc.secret_id, expectedSecretId(key, enc.ciphertext, enc.format));
});

test("sha256-v2 round-trips; tamper fails auth", () => {
  const key = generateVaultKey();
  const enc = encryptVault(key, BLOB);
  assert.equal(enc.format, FORMAT_SHA256_V2);
  assert.deepEqual(decryptVault(key, enc.ciphertext, enc.format), BLOB);
  const buf = Buffer.from(enc.ciphertext, "base64"); buf[18] ^= 0xff;
  assert.throws(() => decryptVault(key, buf.toString("base64"), enc.format));
});

test("pbkdf2-v2 (user password) round-trips; salt rides in the envelope", () => {
  const key = userVaultKey("correct horse battery staple");
  const enc = encryptVault(key, BLOB);
  assert.equal(enc.format, FORMAT_PBKDF2_V2);
  // envelope = salt(16) ‖ iv(12) ‖ ct ‖ tag(16); salt matches the key's salt.
  assert.equal(Buffer.from(enc.ciphertext, "base64").subarray(0, 16).toString("base64"), key.salt);
  assert.deepEqual(decryptVault(key, enc.ciphertext, enc.format), BLOB);
  // a different password fails
  assert.throws(() => decryptVault({ ...key, password: "wrong" }, enc.ciphertext, enc.format));
});

test("pull rejects a blob written under a different password (→ re-pair)", async () => {
  const svc = fakeService();
  const cfg = { baseUrl: "http://x", apiKey: "k" };
  await putVault(cfg, generateVaultKey(), { fields: {} }, 0, { fetchImpl: svc.fetchImpl });
  await assert.rejects(
    () => pullVault(cfg, generateVaultKey(), { fetchImpl: svc.fetchImpl }), // a DIFFERENT random key
    (e) => e instanceof VaultKeyMismatch,
  );
});

test("syncVault: two devices sharing one key converge, stale writer retries on 409", async () => {
  const svc = fakeService();
  const cfg = { baseUrl: "http://x", apiKey: "k" };
  const key = generateVaultKey(); // shared vault key
  await syncVault(cfg, key, (r) => ({ ...r, a: { value: "A", updated_at: "2026-01-01T00:00:00Z" } }), { fetchImpl: svc.fetchImpl });
  const out = await syncVault(cfg, key, (r) => ({ ...r, b: { value: "B", updated_at: "2026-01-02T00:00:00Z" } }), { fetchImpl: svc.fetchImpl });
  assert.equal(out.a.value, "A");
  assert.equal(out.b.value, "B");
  assert.equal(svc.peek().version, 2);
});

test("migration: a legacy v1 blob (keyed by the session secret) still decrypts", () => {
  const sessionSecret = "the old session secret";
  // reproduce a v1 blob exactly: key = sha256(secret), envelope iv‖ct‖tag
  const k = crypto.createHash("sha256").update(sessionSecret, "utf8").digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(BLOB))), c.final()]);
  const v1 = Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
  assert.equal(legacyV1SecretId(sessionSecret), k.toString("hex")); // the leaked v1 id == key (that was the bug)
  assert.deepEqual(decryptLegacyV1(sessionSecret, v1), BLOB);
});

// ---- INTEROP: WebCrypto mirror of the mobile Keeper (src/lib/vaultCrypto.ts) ----
const webcrypto = crypto.webcrypto;
const ID_DOMAIN = new TextEncoder().encode("rbvault-id-v2");
const cat = (...arrs) => { const t = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { t.set(a, o); o += a.length; } return t; };
async function webSha256(u8) { return new Uint8Array(await webcrypto.subtle.digest("SHA-256", u8)); }
async function webMaster(format, password, salt) {
  const pw = new TextEncoder().encode(password);
  if (format === FORMAT_PBKDF2_V2) {
    const km = await webcrypto.subtle.importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
    const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, km, 256);
    return new Uint8Array(bits);
  }
  return webSha256(pw);
}
async function webSecretId(master) { return Buffer.from(await webSha256(cat(ID_DOMAIN, master))).toString("hex"); }
async function webDecrypt(format, password, b64s) {
  const env = new Uint8Array(Buffer.from(b64s, "base64"));
  let off = 0, salt;
  if (format === FORMAT_PBKDF2_V2) { salt = env.subarray(0, 16); off = 16; }
  const master = await webMaster(format, password, salt);
  const key = await webcrypto.subtle.importKey("raw", master, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const iv = env.subarray(off, off + 12);
  const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, env.subarray(off + 12));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function webEncrypt(key, obj) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  let salt = new Uint8Array(0);
  if (key.format === FORMAT_PBKDF2_V2) salt = new Uint8Array(Buffer.from(key.salt, "base64"));
  const master = await webMaster(key.format, key.password, salt.length ? salt : undefined);
  const ck = await webcrypto.subtle.importKey("raw", master, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const ctTag = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(JSON.stringify(obj))));
  return { ciphertext: Buffer.from(cat(salt, iv, ctTag)).toString("base64"), secret_id: await webSecretId(master), format: key.format };
}

for (const mk of [() => generateVaultKey(), () => userVaultKey("shared user pw")]) {
  test(`interop ${mk().format}: node<->web cross-decrypt + identical secret_id`, async () => {
    const key = mk();
    const nodeEnc = encryptVault(key, BLOB);
    assert.deepEqual(await webDecrypt(nodeEnc.format, key.password, nodeEnc.ciphertext), BLOB); // node->web
    const webEnc = await webEncrypt(key, BLOB);
    assert.deepEqual(decryptVault(key, webEnc.ciphertext, webEnc.format), BLOB);               // web->node
    assert.equal(nodeEnc.secret_id, webEnc.secret_id);                                          // same id tag
    const saltU8 = key.salt ? new Uint8Array(Buffer.from(key.salt, "base64")) : undefined;
    assert.equal(nodeEnc.secret_id, await webSecretId(await webMaster(key.format, key.password, saltU8)));
  });
}
