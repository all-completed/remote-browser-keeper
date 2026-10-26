// Tests for the desktop side of headless-Keeper unlock (src/headless.js, rbkeeper-unlock-v1):
//  - canonical JSON + strict base64 (the bytes both ends must agree on);
//  - the vault pin decides: valid / unknown id / bad signature / stale / malformed;
//  - replay guard, comparison code, fingerprint;
//  - HPKE: the RFC 9180 A.2.1 vector, a round trip, and a wrong aad/info/key fails;
//  - test/vectors/rbkeeper-unlock-v1.json — the shared vector for the daemon (Part 3),
//    recomputed from FIXTURE seeds (sha256 of a label) and compared; UPDATE_VECTORS=1
//    rewrites it. No real key, password or token anywhere.
//  - enroll is secret-less or fails closed; older headless tokens are revoked;
//  - pins merge last-write-wins with tombstones; log lines carry no secret values.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson, b64, unb64, fingerprint, comparisonCode, unlockInfo, parsePublicKey, signedBytes,
  verifyUnlockRequest, createReplayGuard, pinEntry, pinTombstone, mergeHeadlessPins, activePins, isValidName,
  buildUnlockPayload, sealUnlock, openUnlock, hpkeSuite, enrollHeadlessDevice, revokeOlderHeadless,
  registerHeadless, deleteHeadless, SecretBoundToken, unlockLogLine, MAX_SKEW_SEC,
} from "../src/headless.js";

const VECTOR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors", "rbkeeper-unlock-v1.json");
const hex = (s) => Buffer.from(s, "hex");
const seed = (label) => crypto.createHash("sha256").update(`rbkeeper-unlock-v1 fixture ${label}`).digest();
const PKCS8_ED25519 = hex("302e020100300506032b657004220420");

function ik(label = "IK") {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed(label)]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return { priv, pub, sign: (m) => crypto.sign(null, m, priv) };
}
async function ek(label = "EK") {
  const kp = await hpkeSuite.kem.deriveKeyPair(seed(label));
  return {
    pub: Buffer.from(await hpkeSuite.kem.serializePublicKey(kp.publicKey)),
    priv: Buffer.from(await hpkeSuite.kem.serializePrivateKey(kp.privateKey)),
  };
}
function request(id, ephPub, { ts = 1_800_000_000, bootId = "boot-1", nonce = "bm9uY2Utbm9uY2UtMDE=", requestId = "req-1" } = {}) {
  const msg = { type: "unlock_request", headless_id: fingerprint(id.pub), boot_id: bootId, eph_pub: b64(ephPub), ts, nonce };
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

test("fingerprint, code and info have fixed shapes", async () => {
  const id = ik(); const e = await ek();
  assert.match(fingerprint(id.pub), /^rbk1-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.match(comparisonCode(e.pub, "boot-1"), /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.notEqual(comparisonCode(e.pub, "boot-1"), comparisonCode(e.pub, "boot-2"));
  assert.equal(unlockInfo("rbk1-AAAA-BBBB-CCCC", "b").toString(), "rbkeeper-unlock-v1|rbk1-AAAA-BBBB-CCCC|b");
});

test("parsePublicKey accepts exactly a base64 32-byte Ed25519 key", () => {
  const id = ik();
  assert.deepEqual(parsePublicKey("  " + b64(id.pub) + "\n"), { pub: id.pub, id: fingerprint(id.pub) });
  for (const bad of ["", "nope", b64(id.pub.subarray(0, 31)), b64(Buffer.concat([id.pub, Buffer.from([0])])), b64(id.pub).replace(/=$/, "")]) {
    assert.equal(parsePublicKey(bad), null, bad);
  }
});

test("a request signed by the pinned key verifies; name comes from the pin", async () => {
  const id = ik(); const e = await ek();
  const v = verifyUnlockRequest(request(id, e.pub), pinsFor(id), { now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.name, "nas");
  assert.equal(v.code, comparisonCode(e.pub, "boot-1"));
  assert.equal(v.requestId, "req-1");
});

test("unknown id, other key, tampered field, stale ts, malformed → not approvable", async () => {
  const id = ik(); const other = ik("other IK"); const e = await ek(); const e2 = await ek("EK2");
  const pins = pinsFor(id);
  assert.deepEqual(verifyUnlockRequest(request(other, e.pub), pins, { now: NOW }), { ok: false, reason: "unknown" });
  // the other key claims the pinned id
  const forged = request(other, e.pub); forged.headless_id = fingerprint(id.pub);
  assert.equal(verifyUnlockRequest(forged, pins, { now: NOW }).reason, "bad-signature");
  // a relay swaps the ephemeral key / boot id
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), eph_pub: b64(e2.pub) }, pins, { now: NOW }).reason, "bad-signature");
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), boot_id: "boot-2" }, pins, { now: NOW }).reason, "bad-signature");
  // unsigned service fields do not matter
  assert.equal(verifyUnlockRequest({ ...request(id, e.pub), name: "evil" }, pins, { now: NOW }).name, "nas");
  assert.equal(verifyUnlockRequest(request(id, e.pub), pins, { now: NOW + (MAX_SKEW_SEC + 1) * 1000 }).reason, "stale");
  assert.equal(verifyUnlockRequest(request(id, e.pub), pins, { now: NOW - (MAX_SKEW_SEC + 1) * 1000 }).reason, "stale");
  for (const patch of [{ type: "x" }, { sig: "AAAA" }, { eph_pub: "x" }, { ts: "1" }, { boot_id: "a:b" }, { request_id: "" }, { nonce: "" }, { headless_id: "nas" }]) {
    assert.equal(verifyUnlockRequest({ ...request(id, e.pub), ...patch }, pins, { now: NOW }).reason, "malformed", JSON.stringify(patch));
  }
  assert.equal(verifyUnlockRequest(null, pins).reason, "malformed");
  // a tombstoned pin is gone
  const dead = { [fingerprint(id.pub)]: pinTombstone(new Date("2026-10-02T00:00:00Z")) };
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
  assert.deepEqual(Object.keys(activePins({ [a.id]: a.entry, "rbk1-0000-0000-0000": a.entry })), [a.id]);
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

const FIXTURE_VAULT = { password: "fixture-vault-password-not-a-secret", format: "pbkdf2-v2", salt: "Zml4dHVyZS1zYWx0" };
const FIXTURE_TOKEN = "fixture-device-token-not-a-secret";

test("seal → open round trip; wrong aad, info or key fails", async () => {
  const e = await ek(); const wrong = await ek("other EK");
  const payload = buildUnlockPayload({ vaultKey: FIXTURE_VAULT, deviceToken: FIXTURE_TOKEN, now: NOW });
  const ctx = { headlessId: "rbk1-AAAA-BBBB-CCCC", bootId: "boot-1", requestId: "req-1" };
  const sealed = await sealUnlock({ ...ctx, ephPub: e.pub, payload });
  assert.deepEqual(await openUnlock({ ...ctx, ephPriv: e.priv, ...sealed }), payload);
  await assert.rejects(openUnlock({ ...ctx, requestId: "req-2", ephPriv: e.priv, ...sealed }));
  await assert.rejects(openUnlock({ ...ctx, bootId: "boot-2", ephPriv: e.priv, ...sealed }));
  await assert.rejects(openUnlock({ ...ctx, ephPriv: wrong.priv, ...sealed }));
  assert.ok(!JSON.stringify(sealed).includes("fixture"));
});

test("payload shape: v, vault {password, format, salt?}, device_token, integer issued_at", () => {
  assert.deepEqual(buildUnlockPayload({ vaultKey: { password: "p", format: "sha256-v2" }, deviceToken: "t", now: 1500 }),
    { v: 1, vault: { password: "p", format: "sha256-v2" }, device_token: "t", issued_at: 1 });
  assert.throws(() => buildUnlockPayload({ vaultKey: null, deviceToken: "t" }));
  assert.throws(() => buildUnlockPayload({ vaultKey: { password: "p", format: "f" }, deviceToken: "" }));
});

// The shared vector: every input is derived from a fixture label, so the daemon's tests
// can recompute or consume it without any real secret.
async function buildVector() {
  const id = ik(); const e = await ek();
  const bootId = "fixture-boot-0001"; const ts = 1_800_000_000; const nonce = "Zml4dHVyZS1ub25jZQ=="; const requestId = "fixture-request-0001";
  const msg = request(id, e.pub, { ts, bootId, nonce, requestId });
  const headlessId = fingerprint(id.pub);
  const payload = buildUnlockPayload({ vaultKey: FIXTURE_VAULT, deviceToken: FIXTURE_TOKEN, now: ts * 1000 });
  const ekm = seed("sender ekm");
  const sealed = await sealUnlock({ ephPub: e.pub, headlessId, bootId, requestId, payload, ekm });
  return {
    note: "rbkeeper-unlock-v1 shared test vector. All inputs are FIXTURES: seeds are sha256(\"rbkeeper-unlock-v1 fixture <label>\"). Regenerate with UPDATE_VECTORS=1 npm test.",
    ik_seed_hex: seed("IK").toString("hex"),
    ik_pub_b64: b64(id.pub),
    headless_id: headlessId,
    ek_ikm_hex: seed("EK").toString("hex"),
    ek_priv_b64: b64(e.priv),
    eph_pub_b64: b64(e.pub),
    boot_id: bootId, ts, nonce,
    signed_bytes: signedBytes(msg).toString("utf8"),
    sig_b64: msg.sig,
    code: comparisonCode(e.pub, bootId),
    request_id: requestId,
    info: unlockInfo(headlessId, bootId).toString("utf8"),
    aad: requestId,
    plaintext: canonicalJson(payload),
    sender_ekm_hex: ekm.toString("hex"),
    enc_b64: sealed.enc,
    ciphertext_b64: sealed.ciphertext,
  };
}

test("shared vector test/vectors/rbkeeper-unlock-v1.json is current and self-consistent", async () => {
  const v = await buildVector();
  if (process.env.UPDATE_VECTORS === "1") fs.writeFileSync(VECTOR_PATH, JSON.stringify(v, null, 2) + "\n");
  const onDisk = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8"));
  assert.deepEqual(onDisk, v);
  // the daemon's half against the file's own numbers
  const pins = { [onDisk.headless_id]: { name: "fixture", ed25519_pub: onDisk.ik_pub_b64, updated_at: "2026-10-01T00:00:00.000Z" } };
  const msg = { type: "unlock_request", headless_id: onDisk.headless_id, boot_id: onDisk.boot_id, eph_pub: onDisk.eph_pub_b64,
    ts: onDisk.ts, nonce: onDisk.nonce, sig: onDisk.sig_b64, request_id: onDisk.request_id };
  assert.equal(signedBytes(msg).toString("utf8"), onDisk.signed_bytes);
  assert.equal(verifyUnlockRequest(msg, pins, { now: onDisk.ts * 1000 }).ok, true);
  const opened = await openUnlock({ ephPriv: unb64(onDisk.ek_priv_b64), headlessId: onDisk.headless_id, bootId: onDisk.boot_id,
    requestId: onDisk.request_id, enc: onDisk.enc_b64, ciphertext: onDisk.ciphertext_b64 });
  assert.equal(canonicalJson(opened), onDisk.plaintext);
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

test("enroll asks for a secret-less headless:<name>:<boot> device and returns its token", async () => {
  const f = fakeFetch({ "POST /api/keeper/devices/enroll": () => [200, { status: "ok", token: "t-1", secret_bound: false, device: { device_id: "d-1" } }] });
  assert.deepEqual(await enrollHeadlessDevice(CFG, { name: "nas", bootId: "b1" }, { fetchImpl: f }), { token: "t-1", deviceId: "d-1" });
  assert.deepEqual(f.calls[0].body, { device_name: "headless:nas:b1", platform: "headless", secret_less: true });
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

test("register / delete call the headless registration API", async () => {
  const id = ik();
  const f = fakeFetch({ "POST /api/keeper/headless": () => [200, {}], "DELETE *": () => [404, {}] });
  await registerHeadless(CFG, { id: fingerprint(id.pub), name: "nas", pub: id.pub }, { fetchImpl: f });
  assert.deepEqual(f.calls[0].body, { id: fingerprint(id.pub), name: "nas", ed25519_pub: b64(id.pub) });
  await deleteHeadless(CFG, fingerprint(id.pub), { fetchImpl: f }); // 404 = already gone
  assert.equal(f.calls[1].path, `/api/keeper/headless/${fingerprint(id.pub)}`);
  await assert.rejects(registerHeadless(CFG, { id: "x", name: "nas", pub: id.pub }, { fetchImpl: fakeFetch({}) }), /HTTP 404/);
});

test("log lines carry identifiers only, never secrets", () => {
  const line = unlockLogLine("approved", { request_id: "r", headless_id: "rbk1-AAAA-BBBB-CCCC", name: "nas",
    password: FIXTURE_VAULT.password, device_token: FIXTURE_TOKEN, ciphertext: "c", sig: "s", eph_pub: "e" });
  assert.equal(line, "[keeper] unlock approved request_id=r headless_id=rbk1-AAAA-BBBB-CCCC name=nas");
});
