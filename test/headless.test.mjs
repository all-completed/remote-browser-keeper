// Tests for the desktop side of headless-Keeper unlock (src/headless.js, rbkeeper-unlock-v1):
//  - canonical JSON + strict base64 (the bytes both ends must agree on);
//  - hk1_ id and rbk1- base32 fingerprint (spec §2);
//  - the vault pin decides: valid / unknown id / bad signature / stale / malformed;
//  - replay guard, comparison code;
//  - HPKE: the RFC 9180 A.2.1 vector, a round trip, and a wrong aad/info/key fails;
//  - test/vectors/rbkeeper-unlock-v1-vectors.json — a byte-identical copy of the merged
//    contract vectors (vasyaod/remote-browser-service@4b86ef68, docs/rbkeeper-unlock-v1-vectors.json):
//    id, fingerprint, signing bytes, sig, relayed frame, comparison code, enc + ciphertext.
//    Every key in it is a public fixture, none is a credential.
//  - revoke before a secret_bound:false enroll, which fails closed otherwise;
//  - register sends {name, ed25519_pub} only and checks the returned headless_id;
//  - pins merge last-write-wins with tombstones; log lines carry no secret values.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson, b64, unb64, headlessId, fingerprint, comparisonCode, unlockInfo, parsePublicKey, signedBytes,
  verifyUnlockRequest, createReplayGuard, pinEntry, pinTombstone, mergeHeadlessPins, activePins, isValidName,
  buildUnlockPayload, sealUnlock, openUnlock, hpkeSuite, enrollHeadlessDevice, revokeOlderHeadless,
  registerHeadless, deleteHeadless, SecretBoundToken, unlockLogLine, MAX_SKEW_SEC,
} from "../src/headless.js";

const VECTORS = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors", "rbkeeper-unlock-v1-vectors.json"), "utf8"));
const hex = (s) => Buffer.from(s, "hex");
const seed = (label) => crypto.createHash("sha256").update(`rbkeeper-unlock-v1 fixture ${label}`).digest();
const PKCS8_ED25519 = hex("302e020100300506032b657004220420");

function ikFromSeed(s) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, s]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return { priv, pub, sign: (m) => crypto.sign(null, m, priv) };
}
const ik = (label = "IK") => ikFromSeed(seed(label));
async function ek(label = "EK") {
  const kp = await hpkeSuite.kem.deriveKeyPair(seed(label));
  return {
    pub: Buffer.from(await hpkeSuite.kem.serializePublicKey(kp.publicKey)),
    priv: Buffer.from(await hpkeSuite.kem.serializePrivateKey(kp.privateKey)),
  };
}
const BOOT_1 = "6f9619ff-8b86-4011-b42d-00c04fc96481";
const BOOT_2 = "0b6c3f0e-1d2a-4c5b-9e8f-7a6b5c4d3e2f";
const NONCE = b64(Buffer.alloc(16, 7));
function request(id, ephPub, { ts = 1_800_000_000, bootId = BOOT_1, nonce = NONCE, requestId = "req-1" } = {}) {
  const msg = { type: "unlock_request", headless_id: headlessId(id.pub), boot_id: bootId, eph_pub: b64(ephPub), ts, nonce };
  msg.sig = b64(id.sign(signedBytes(msg)));
  return { ...msg, request_id: requestId, name: "service-label" };
}
const pinsFor = (id, name = "nas") => { const p = pinEntry({ name, pub: id.pub, now: new Date("2026-10-01T00:00:00Z") }); return { [p.id]: p.entry }; };
const NOW = 1_800_000_000 * 1000;

test("canonical JSON: sorted keys, no whitespace, integers only", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x\"y"], c: { z: 0, y: "é" } }), '{"a":[true,null,"x\\"y"],"b":1,"c":{"y":"é","z":0}}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: 2 ** 60 }));
});

test("strict base64: one spelling per value", () => {
  assert.deepEqual(unb64("AAE="), Buffer.from([0, 1]));
  for (const bad of ["AAE", "AA E=", "AAE=\n", "-_8=", "", null]) assert.equal(unb64(bad), null, String(bad));
  assert.equal(unb64("AAE=", 3), null);
});

test("id, fingerprint, code and info have the spec shapes", async () => {
  const id = ik(); const e = await ek();
  assert.match(headlessId(id.pub), /^hk1_[0-9a-f]{32}$/);
  assert.equal(headlessId(id.pub), "hk1_" + crypto.createHash("sha256").update(id.pub).digest("hex").slice(0, 32));
  assert.match(fingerprint(id.pub), /^rbk1-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.notEqual(headlessId(id.pub), headlessId(ik("other IK").pub));
  assert.match(comparisonCode(e.pub, BOOT_1), /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.notEqual(comparisonCode(e.pub, BOOT_1), comparisonCode(e.pub, BOOT_2));
  assert.equal(unlockInfo("hk1_" + "0".repeat(32), "b").toString(), `rbkeeper-unlock-v1|hk1_${"0".repeat(32)}|b`);
});

test("parsePublicKey accepts exactly a base64 32-byte Ed25519 key", () => {
  const id = ik();
  assert.deepEqual(parsePublicKey("  " + b64(id.pub) + "\n"), { pub: id.pub, id: headlessId(id.pub), fingerprint: fingerprint(id.pub) });
  for (const bad of ["", "nope", b64(id.pub.subarray(0, 31)), b64(Buffer.concat([id.pub, Buffer.from([0])])), b64(id.pub).replace(/=$/, "")]) {
    assert.equal(parsePublicKey(bad), null, bad);
  }
});

test("a request signed by the pinned key verifies; name comes from the pin", async () => {
  const id = ik(); const e = await ek();
  const v = verifyUnlockRequest(request(id, e.pub), pinsFor(id), { now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.headlessId, headlessId(id.pub));
  assert.equal(v.name, "nas");
  assert.equal(v.code, comparisonCode(e.pub, BOOT_1));
  assert.equal(v.requestId, "req-1");
});

test("unknown id, other key, tampered field, stale ts, malformed → not approvable", async () => {
  const id = ik(); const other = ik("other IK"); const e = await ek(); const e2 = await ek("EK2");
  const pins = pinsFor(id);
  assert.deepEqual(verifyUnlockRequest(request(other, e.pub), pins, { now: NOW }), { ok: false, reason: "unknown" });
  // the other key claims the pinned id
  const forged = request(other, e.pub); forged.headless_id = headlessId(id.pub);
  assert.equal(verifyUnlockRequest(forged, pins, { now: NOW }).reason, "bad-signature");
  // a relay swaps the ephemeral key / boot id / nonce / ts
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), eph_pub: b64(e2.pub) }, pins, { now: NOW }).reason, "bad-signature");
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), boot_id: BOOT_2 }, pins, { now: NOW }).reason, "bad-signature");
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), nonce: b64(Buffer.alloc(16, 8)) }, pins, { now: NOW }).reason, "bad-signature");
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), ts: 1_800_000_001 }, pins, { now: NOW }).reason, "bad-signature");
  // unsigned service fields do not matter
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), name: "evil" }, pins, { now: NOW }).name, "nas");
  // skew: 720 s either way is accepted, 721 s is stale (spec §5 step 4)
  assert.equal(MAX_SKEW_SEC, 720);
  for (const d of [720, -720]) assert.equal(verifyUnlockRequest(request(id, e.pub), pins, { now: NOW + d * 1000 }).ok, true, String(d));
  for (const d of [721, -721]) assert.equal(verifyUnlockRequest(request(id, e.pub), pins, { now: NOW + d * 1000 }).reason, "stale", String(d));
  for (const patch of [
    { type: "x" }, { sig: "AAAA" }, { eph_pub: "x" }, { ts: "1" }, { ts: 1.5 }, { ts: -1 }, { ts: null },
    { boot_id: "boot-1" }, { boot_id: BOOT_1.toUpperCase() }, { request_id: "" }, { request_id: "r".repeat(129) },
    { nonce: "" }, { nonce: b64(Buffer.alloc(15)) }, { headless_id: "nas" },
    { headless_id: "rbk1-AAAA-BBBB-CCCC" }, { headless_id: headlessId(id.pub).toUpperCase().replace("HK1_", "hk1_") },
    { request_id: "req-é" }, { name: "näs" }, { extra: "x" }, { secret_request: "x" },
  ]) {
    assert.equal(verifyUnlockRequest({ ...request(id, e.pub), ...patch }, pins, { now: NOW }).reason, "malformed", JSON.stringify(patch));
  }
  for (const missing of ["type", "headless_id", "boot_id", "eph_pub", "ts", "nonce", "sig", "request_id"]) {
    const m = request(id, e.pub); delete m[missing];
    assert.equal(verifyUnlockRequest(m, pins, { now: NOW }).reason, "malformed", missing);
  }
  // the relay's name is optional
  const noName = request(id, e.pub); delete noName.name;
  assert.equal(verifyUnlockRequest(noName, pins, { now: NOW }).ok, true);
  assert.equal(verifyUnlockRequest(null, pins).reason, "malformed");
  assert.equal(verifyUnlockRequest([], pins).reason, "malformed");
  // a tombstoned pin is gone
  const dead = { [headlessId(id.pub)]: pinTombstone(new Date("2026-10-02T00:00:00Z")) };
  assert.equal(verifyUnlockRequest(request(id, e.pub), mergeHeadlessPins(pins, dead), { now: NOW }).reason, "unknown");
});

test("replay guard refuses a nonce or request_id seen before, bounded", () => {
  const g = createReplayGuard(4);
  assert.equal(g.first("n:a", "r:1"), true);
  assert.equal(g.first("n:a", "r:2"), false);
  assert.equal(g.first("n:b", "r:1"), false);
  for (let i = 0; i < 10; i++) g.first(`n:${i}`);
  assert.equal(g.first("n:a", "r:1"), true); // evicted, bounded memory
});

test("pins: last write wins by updated_at, tombstones, key/id mismatch ignored, names validated", () => {
  const id = ik();
  const a = pinEntry({ name: "nas", pub: id.pub, now: new Date("2026-10-01T00:00:00Z") });
  const b = pinEntry({ name: "nas2", pub: id.pub, now: new Date("2026-10-03T00:00:00Z") });
  assert.equal(mergeHeadlessPins({ [a.id]: a.entry }, { [b.id]: b.entry })[a.id].name, "nas2");
  assert.equal(mergeHeadlessPins({ [b.id]: b.entry }, { [a.id]: a.entry })[a.id].name, "nas2");
  assert.deepEqual(Object.keys(activePins({ [a.id]: a.entry, ["hk1_" + "0".repeat(32)]: a.entry })), [a.id]);
  assert.match(a.id, /^hk1_[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(a.entry).sort(), ["added_at", "ed25519_pub", "name", "updated_at"]);
  for (const n of ["nas", "a.b_c-1", "x".repeat(32)]) assert.ok(isValidName(n), n);
  for (const n of ["", "a:b", "a b", "x".repeat(33), null]) assert.ok(!isValidName(n), String(n));
});

test("HPKE: reproduces RFC 9180 A.2.1 (X25519, HKDF-SHA256, ChaCha20-Poly1305)", async () => {
  const pkR = await hpkeSuite.kem.deserializePublicKey(hex("4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a"));
  const s = await hpkeSuite.createSenderContext({
    recipientPublicKey: pkR, info: hex("4f6465206f6e2061204772656369616e2055726e"),
    ekm: hex("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b"),
  });
  assert.equal(Buffer.from(s.enc).toString("hex"), "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
  const pt = hex("4265617574792069732074727574682c20747275746820626561757479");
  assert.equal(Buffer.from(await s.seal(pt, hex("436f756e742d30"))).toString("hex"),
    "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28");
  assert.equal(Buffer.from(await s.seal(pt, hex("436f756e742d31"))).toString("hex"),
    "6b53c051e4199c518de79594e1c4ab18b96f081549d45ce015be002090bb119e85285337cc95ba5f59992dc98c");
});

const FIXTURE_VAULT = { password: "fixture-vault-password-not-a-secret", format: "aesgcm-pbkdf2-v2", salt: "Zml4dHVyZS1zYWx0" };
const FIXTURE_TOKEN = "fixture-device-token-not-a-secret";

test("seal → open round trip; wrong aad, info or key fails", async () => {
  const e = await ek(); const wrong = await ek("other EK");
  const payload = buildUnlockPayload({ vaultKey: FIXTURE_VAULT, deviceToken: FIXTURE_TOKEN, now: NOW });
  const ctx = { headlessId: "hk1_" + "a".repeat(32), bootId: BOOT_1, requestId: "req-1" };
  const sealed = await sealUnlock({ ...ctx, ephPub: e.pub, payload });
  assert.deepEqual(await openUnlock({ ...ctx, ephPriv: e.priv, ...sealed }), payload);
  await assert.rejects(openUnlock({ ...ctx, requestId: "req-2", ephPriv: e.priv, ...sealed }));
  await assert.rejects(openUnlock({ ...ctx, bootId: BOOT_2, ephPriv: e.priv, ...sealed }));
  await assert.rejects(openUnlock({ ...ctx, ephPriv: wrong.priv, ...sealed }));
  assert.ok(!JSON.stringify(sealed).includes("fixture"));
});

test("payload shape: v, vault {password, format, salt?}, device_token, integer issued_at", () => {
  assert.deepEqual(buildUnlockPayload({ vaultKey: { password: "p", format: "sha256-v2" }, deviceToken: "t", now: 1500 }),
    { v: 1, vault: { password: "p", format: "sha256-v2" }, device_token: "t", issued_at: 1 });
  assert.throws(() => buildUnlockPayload({ vaultKey: null, deviceToken: "t" }));
  assert.throws(() => buildUnlockPayload({ vaultKey: { password: "p", format: "f" }, deviceToken: "" }));
});

// ---------- the merged contract vectors (spec §8) ----------

test("vectors: identity → hk1_ id and rbk1- fingerprint", () => {
  const { identity } = VECTORS;
  const id = ikFromSeed(hex(identity.ed25519_seed_hex));
  assert.equal(b64(id.pub), identity.ed25519_pub);
  assert.equal(headlessId(id.pub), identity.headless_id);
  assert.equal(identity.headless_id, "hk1_3f08e62cbf0d8f02acbed3554329d1f2");
  assert.equal(fingerprint(id.pub), identity.fingerprint);
  assert.equal(identity.fingerprint, "rbk1-H4EO-MLF7-BWHQ");
  assert.deepEqual(parsePublicKey(identity.ed25519_pub), { pub: id.pub, id: identity.headless_id, fingerprint: identity.fingerprint });
});

test("vectors: signing bytes, sig, comparison code", () => {
  const { identity, unlock_request: u } = VECTORS;
  assert.deepEqual(u.signed_fields, ["type", "headless_id", "boot_id", "eph_pub", "ts", "nonce"]);
  assert.equal(signedBytes(u.frame).toString("utf8"), u.signing_bytes_utf8);
  assert.equal(signedBytes(u.frame).toString("hex"), u.signing_bytes_hex);
  assert.equal(signedBytes(u.relayed_frame).toString("hex"), u.signing_bytes_hex); // relay fields are not signed
  assert.equal(u.frame.sig, u.sig);
  const id = ikFromSeed(hex(identity.ed25519_seed_hex));
  assert.equal(b64(id.sign(hex(u.signing_bytes_hex))), u.sig); // Ed25519 is deterministic
  assert.ok(crypto.verify(null, hex(u.signing_bytes_hex), crypto.createPublicKey({
    key: Buffer.concat([hex("302a300506032b6570032100"), unb64(identity.ed25519_pub)]), format: "der", type: "spki" }), unb64(u.sig)));
  assert.equal(comparisonCode(unb64(u.frame.eph_pub, 32), u.frame.boot_id), u.comparison_code);
});

test("vectors: the relayed frame is accepted with the pin, rejected without or tampered", () => {
  const { identity, unlock_request: u } = VECTORS;
  const pins = { [identity.headless_id]: { name: "garage-2", ed25519_pub: identity.ed25519_pub, added_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" } };
  const now = u.frame.ts * 1000;
  const v = verifyUnlockRequest(u.relayed_frame, pins, { now });
  assert.equal(v.ok, true);
  assert.equal(v.headlessId, identity.headless_id);
  assert.equal(v.bootId, u.frame.boot_id);
  assert.equal(v.requestId, u.relayed_frame.request_id);
  assert.equal(v.name, "garage-2");
  assert.equal(v.code, u.comparison_code);
  // the name shown is the pin's, whatever the relay says
  const renamed = { ...pins, [identity.headless_id]: { ...pins[identity.headless_id], name: "nas" } };
  assert.equal(verifyUnlockRequest(u.relayed_frame, renamed, { now }).name, "nas");
  assert.equal(verifyUnlockRequest(u.relayed_frame, {}, { now }).reason, "unknown");
  assert.equal(verifyUnlockRequest({ ...u.relayed_frame, ts: u.frame.ts + 1 }, pins, { now }).reason, "bad-signature");
  assert.equal(verifyUnlockRequest(u.relayed_frame, pins, { now: now + 721_000 }).reason, "stale");
  assert.equal(verifyUnlockRequest({ ...u.relayed_frame, extra: 1 }, pins, { now }).reason, "malformed");
});

test("vectors: HPKE enc + ciphertext reproduced from sender_ephemeral_ikm_hex, and opened", async () => {
  const { identity, unlock_request: u, hpke: h } = VECTORS;
  assert.deepEqual([h.suite.mode, h.suite.kem_id, h.suite.kdf_id, h.suite.aead_id], ["base", 0x0020, 0x0001, 0x0003]);
  const r = await hpkeSuite.kem.deriveKeyPair(hex(h.recipient_ikm_hex));
  assert.equal(Buffer.from(await hpkeSuite.kem.serializePrivateKey(r.privateKey)).toString("hex"), h.recipient_sk_hex);
  assert.equal(b64(Buffer.from(await hpkeSuite.kem.serializePublicKey(r.publicKey))), h.recipient_pk);
  assert.equal(h.recipient_pk, u.frame.eph_pub);
  const ctx = { headlessId: identity.headless_id, bootId: u.frame.boot_id, requestId: u.relayed_frame.request_id };
  assert.equal(unlockInfo(ctx.headlessId, ctx.bootId).toString("utf8"), h.info_utf8);
  assert.equal(ctx.requestId, h.aad_utf8);
  const payload = JSON.parse(h.plaintext_utf8);
  assert.equal(canonicalJson(payload), h.plaintext_utf8); // our payload encoding is the spec's
  assert.deepEqual(Object.keys(payload).sort(), ["device_token", "issued_at", "v", "vault"]);
  const sealed = await sealUnlock({ ...ctx, ephPub: unb64(h.recipient_pk, 32), payload, ekm: hex(h.sender_ephemeral_ikm_hex) });
  assert.equal(sealed.enc, h.enc);
  assert.equal(sealed.ciphertext, h.ciphertext);
  assert.deepEqual({ type: "unlock_response", request_id: ctx.requestId, ...sealed }, h.unlock_response);
  const ephPriv = hex(h.recipient_sk_hex);
  assert.deepEqual(await openUnlock({ ...ctx, ephPriv, enc: h.enc, ciphertext: h.ciphertext }), payload);
  await assert.rejects(openUnlock({ ...ctx, requestId: "req_test_vector_0002", ephPriv, enc: h.enc, ciphertext: h.ciphertext }));
  await assert.rejects(openUnlock({ ...ctx, bootId: BOOT_2, ephPriv, enc: h.enc, ciphertext: h.ciphertext }));
});

// ---------- service calls (mock fetch) ----------

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const p = new URL(url).pathname;
    calls.push({ method, path: p, body: opts.body ? JSON.parse(opts.body) : undefined, auth: opts.headers && opts.headers.Authorization });
    const h = routes[`${method} ${p}`] || routes[`${method} *`];
    const [status, body] = h ? h(calls.at(-1)) : [404, { detail: "nf" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}
const CFG = { baseUrl: "https://svc.example/", apiKey: "fixture-api-key" };

test("enroll asks for a secret_bound:false headless:<name>:<boot> device and returns its token", async () => {
  const f = fakeFetch({ "POST /api/keeper/devices/enroll": () => [200, { status: "ok", token: "t-1", secret_bound: false, device: { device_id: "d-1" } }] });
  assert.deepEqual(await enrollHeadlessDevice(CFG, { name: "nas", bootId: "b1" }, { fetchImpl: f }), { token: "t-1", deviceId: "d-1" });
  assert.deepEqual(f.calls[0].body, { device_name: "headless:nas:b1", platform: "headless", secret_bound: false });
  await enrollHeadlessDevice(CFG, { name: "nas", bootId: "b1", appVersion: "1.2.3" }, { fetchImpl: f });
  assert.deepEqual(f.calls[1].body, { device_name: "headless:nas:b1", platform: "headless", app_version: "1.2.3", secret_bound: false });
  assert.equal(f.calls[0].auth, "Bearer fixture-api-key");
});

test("enroll fails closed on a secret-bound (or unspecified) token and revokes it", async () => {
  for (const bound of [true, undefined]) {
    const f = fakeFetch({
      "POST /api/keeper/devices/enroll": () => [200, { status: "ok", token: "t-1", ...(bound === undefined ? {} : { secret_bound: bound }), device: { device_id: "d-1" } }],
      "DELETE /api/keeper/devices/d-1": () => [200, {}],
    });
    await assert.rejects(enrollHeadlessDevice(CFG, { name: "nas", bootId: "b1" }, { fetchImpl: f }), SecretBoundToken);
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ["POST /api/keeper/devices/enroll", "DELETE /api/keeper/devices/d-1"]);
  }
  const f = fakeFetch({ "POST /api/keeper/devices/enroll": () => [500, {}] });
  await assert.rejects(enrollHeadlessDevice(CFG, { name: "nas", bootId: "b1" }, { fetchImpl: f }), /HTTP 500/);
});

test("revokeOlderHeadless revokes only this name's other headless devices", async () => {
  const f = fakeFetch({
    "GET /api/keeper/devices": () => [200, { devices: [
      { device_id: "new", device_name: "headless:nas:b2" },
      { device_id: "old", device_name: "headless:nas:b1" },
      { device_id: "gone", device_name: "headless:nas:b0" },
      { device_id: "other", device_name: "headless:nas2:b1" },
      { device_id: "desk", device_name: "MacBook" },
    ] }],
    "DELETE /api/keeper/devices/old": () => [200, {}],
    "DELETE /api/keeper/devices/gone": () => [404, {}],
  });
  assert.equal(await revokeOlderHeadless(CFG, "nas", "new", { fetchImpl: f }), 2);
  assert.deepEqual(f.calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/api/keeper/devices/old", "/api/keeper/devices/gone"]);
  const bad = fakeFetch({ "GET /api/keeper/devices": () => [200, { devices: [{ device_id: "old", device_name: "headless:nas:b1" }] }], "DELETE *": () => [500, {}] });
  await assert.rejects(revokeOlderHeadless(CFG, "nas", "new", { fetchImpl: bad }), /HTTP 500/);
});

test("before enrolling, revokeOlderHeadless(name) with no keepId clears every headless:<name>:* record", async () => {
  const f = fakeFetch({
    "GET /api/keeper/devices": () => [200, { devices: [
      { device_id: "a", device_name: "headless:nas:b1" },
      { device_id: "b", device_name: "headless:nas:b2" },
      { device_id: "other", device_name: "headless:nas2:b1" },
      { device_id: "phone", device_name: "iPhone" },
    ] }],
    "DELETE *": () => [200, {}],
  });
  assert.equal(await revokeOlderHeadless(CFG, "nas", null, { fetchImpl: f }), 2);
  assert.deepEqual(f.calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/api/keeper/devices/a", "/api/keeper/devices/b"]);
});

test("register posts {name, ed25519_pub} only and checks the returned headless_id", async () => {
  const id = ik(); const hid = headlessId(id.pub);
  const f = fakeFetch({ "POST /api/keeper/headless": () => [200, { headless_id: hid, name: "nas" }], "DELETE *": () => [404, {}] });
  assert.equal(await registerHeadless(CFG, { name: "nas", pub: id.pub }, { fetchImpl: f }), hid);
  assert.deepEqual(f.calls[0].body, { name: "nas", ed25519_pub: b64(id.pub) });
  await deleteHeadless(CFG, hid, { fetchImpl: f }); // 404 = already gone
  assert.equal(f.calls[1].path, `/api/keeper/headless/${hid}`);
  const lying = fakeFetch({ "POST /api/keeper/headless": () => [200, { headless_id: headlessId(ik("other IK").pub), name: "nas" }] });
  await assert.rejects(registerHeadless(CFG, { name: "nas", pub: id.pub }, { fetchImpl: lying }), /different headless_id/);
  const empty = fakeFetch({ "POST /api/keeper/headless": () => [200, {}] });
  await assert.rejects(registerHeadless(CFG, { name: "nas", pub: id.pub }, { fetchImpl: empty }), /different headless_id/);
  const taken = fakeFetch({ "POST /api/keeper/headless": () => [409, { detail: "taken" }] });
  await assert.rejects(registerHeadless(CFG, { name: "nas", pub: id.pub }, { fetchImpl: taken }), /another account/);
  await assert.rejects(registerHeadless(CFG, { name: "nas", pub: id.pub }, { fetchImpl: fakeFetch({}) }), /HTTP 404/);
});

test("log lines carry identifiers only, never secrets", () => {
  const line = unlockLogLine("approved", { request_id: "r", headless_id: "hk1_3f08e62cbf0d8f02acbed3554329d1f2", name: "nas",
    password: FIXTURE_VAULT.password, device_token: FIXTURE_TOKEN, ciphertext: "c", sig: "s", eph_pub: "e" });
  assert.equal(line, "[keeper] unlock approved request_id=r headless_id=hk1_3f08e62cbf0d8f02acbed3554329d1f2 name=nas");
});
