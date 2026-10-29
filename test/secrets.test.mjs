// The session-secret store at rest (src/secrets.js + src/securestore.js).
//
// Issue #22: the secrets — the most sensitive thing the Keeper holds — sat in a
// plaintext `secrets.json` that nothing ever encrypted and nothing ever chmod'd,
// while fields/vault-key already went through the OS-encrypted `securestore`.
// These tests pin the new arrangement:
//  - `secrets.json` is a provisioning INBOX (the external export script can't call
//    safeStorage); the first read folds it into OS-encrypted `secrets.enc.json` and
//    removes it, so no plaintext copy stands;
//  - the fold MERGES — an id the encrypted store already holds is never dropped by
//    the external writer's fresh file;
//  - with no OS backend nothing is silently written in the clear: the inbox stays,
//    chmod 600, and reads still work;
//  - `readJsonState` tells "missing" (empty store) apart from corrupt / no-key /
//    undecryptable (data we have and cannot see), which the old `{}` hid;
//  - a corrupt inbox is never shredded.
//
// No electron needed: securestore takes an injected safeStorage (`_setSafeForTest`)
// and `os.homedir()` follows $HOME, so the whole store runs against a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  _setSafeForTest, readJsonState, writeJson, readFailed, EncryptionUnavailable,
  MISSING, PLAINTEXT, ENCRYPTED, CORRUPT, NO_KEY, UNDECRYPTABLE,
} from "../src/securestore.js";
import { createSecretStore, vaultPath, securePath, secretIdOf } from "../src/secrets.js";

const BASE = "https://rb.example.com";

// A stand-in for Electron safeStorage: a real, reversible transform (not the identity)
// so an "encrypted" file provably does not contain the plaintext.
// A different `key` stands in for a different OS keyring: envelopes written under one
// are UNDECRYPTABLE under the other while encryption stays available — exactly what a
// reset login keyring / Windows profile leaves behind.
function fakeSafe({ ok = true, key = "test-key" } = {}) {
  const KEY = crypto.createHash("sha256").update(key).digest();
  return {
    isEncryptionAvailable: () => ok,
    encryptString(s) {
      const b = Buffer.from(s, "utf8");
      return Buffer.from(b.map((v, i) => v ^ KEY[i % KEY.length]));
    },
    decryptString(buf) {
      const b = Buffer.from(buf);
      return Buffer.from(b.map((v, i) => v ^ KEY[i % KEY.length])).toString("utf8");
    },
  };
}

let tmp;
function freshHome() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-secrets-"));
  process.env.HOME = tmp;
  return tmp;
}

const SECRET = "s3ssion-secret-value";
const SID = secretIdOf(SECRET);
const OLD = "an-older-held-secret";
const OLD_SID = secretIdOf(OLD);

function writeInbox(entries) {
  const p = vaultPath(BASE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ base_url: BASE, secrets: entries }, null, 2));
  return p;
}
const entry = (secret, label) => ({ [secretIdOf(secret)]: { secret, label, user_id: "u1", source: "export" } });

test.beforeEach(() => { freshHome(); _setSafeForTest(fakeSafe()); });
test.afterEach(() => { _setSafeForTest(undefined); fs.rmSync(tmp, { recursive: true, force: true }); });

test("a plaintext inbox is absorbed into the encrypted store and removed", () => {
  const inbox = writeInbox(entry(SECRET, "prod"));
  const store = createSecretStore({ baseUrl: BASE });

  assert.equal(store.getSecret(SID), SECRET); // still answers while migrating

  assert.equal(fs.existsSync(inbox), false, "the plaintext inbox must be gone");
  const encFile = securePath(BASE);
  assert.equal(fs.existsSync(encFile), true);

  // The bytes on disk must not contain the secret in the clear.
  const raw = fs.readFileSync(encFile, "utf8");
  assert.equal(raw.includes(SECRET), false, "the secret must not be readable on disk");
  assert.match(raw, /__securestore_v1__/);
  assert.equal((fs.statSync(encFile).mode & 0o777), 0o600, "chmod 600");

  // …and it still reads back through the store on a later run.
  assert.equal(createSecretStore({ baseUrl: BASE }).getSecret(SID), SECRET);
  assert.deepEqual(createSecretStore({ baseUrl: BASE }).listSecretIds(), [SID]);
});

test("absorbing MERGES — the external writer's fresh file cannot drop a held secret", () => {
  // Round 1: one secret, migrated.
  writeInbox(entry(OLD, "first"));
  assert.equal(createSecretStore({ baseUrl: BASE }).getSecret(OLD_SID), OLD);

  // Round 2: the external script knows nothing of the encrypted store and writes a
  // BRAND-NEW secrets.json holding only the new secret.
  writeInbox(entry(SECRET, "second"));
  const store = createSecretStore({ baseUrl: BASE });

  assert.equal(store.getSecret(SECRET === OLD ? OLD_SID : SID), SECRET);
  assert.equal(store.getSecret(OLD_SID), OLD, "the previously held secret must survive");
  assert.deepEqual(new Set(store.listSecretIds()), new Set([OLD_SID, SID]));
  assert.equal(fs.existsSync(vaultPath(BASE)), false);
});

test("no OS backend: nothing is written in the clear; the inbox stays, chmod 600", () => {
  _setSafeForTest(null); // no safeStorage at all (headless Linux / outside Electron)
  const inbox = writeInbox(entry(SECRET, "prod"));
  fs.chmodSync(inbox, 0o644);

  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.getSecret(SID), SECRET, "reads must keep working");
  assert.equal(fs.existsSync(inbox), true, "the only copy must not be shredded");
  assert.equal(fs.existsSync(securePath(BASE)), false, "no second plaintext file pretending to be encrypted");
  assert.equal((fs.statSync(inbox).mode & 0o777), 0o600, "the chmod 600 the docs promised");
});

test("safeStorage present but encryption unavailable is the same refusal", () => {
  _setSafeForTest(fakeSafe({ ok: false }));
  const inbox = writeInbox(entry(SECRET, "prod"));
  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.getSecret(SID), SECRET);
  assert.equal(fs.existsSync(inbox), true);
  assert.equal(fs.existsSync(securePath(BASE)), false);
  assert.throws(() => writeJson(path.join(tmp, "x.json"), { a: 1 }, { requireEncryption: true }), EncryptionUnavailable);
  assert.equal(fs.existsSync(path.join(tmp, "x.json")), false, "the refusal must not leave the file behind");
});

test("a failed migration loses nothing: the inbox survives and the held store is intact", () => {
  // One secret already in the encrypted store…
  writeInbox(entry(OLD, "first"));
  assert.equal(createSecretStore({ baseUrl: BASE }).getSecret(OLD_SID), OLD);
  const before = fs.readFileSync(securePath(BASE), "utf8");

  // …then the encrypt step starts failing while a new inbox is waiting.
  const broken = fakeSafe();
  _setSafeForTest({ ...broken, encryptString() { throw new Error("keychain locked"); } });
  const inbox = writeInbox(entry(SECRET, "second"));

  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.getSecret(SID), SECRET, "the inbox is still served in memory");
  assert.equal(store.getSecret(OLD_SID), OLD, "…and so is the held one");
  assert.equal(fs.existsSync(inbox), true, "the inbox must NOT be shredded after a failed write");
  assert.equal(fs.readFileSync(securePath(BASE), "utf8"), before, "the held store must be byte-identical");
  assert.equal(fs.existsSync(securePath(BASE) + ".tmp"), false, "no half-written temp file left behind");

  // Recovery: once encryption works again the same read completes the migration.
  _setSafeForTest(broken);
  const after = createSecretStore({ baseUrl: BASE });
  assert.equal(after.getSecret(SID), SECRET);
  assert.equal(after.getSecret(OLD_SID), OLD);
  assert.equal(fs.existsSync(inbox), false);
});

// Absorbing an inbox must never REPLACE a store we could not read. The store is only
// unreadable because the key is gone (a reset keyring), and the key can come back —
// which makes those bytes recoverable, and overwriting them the one irreversible step.
// `merged` holds the inbox alone in that case, and the read-back check only knows the
// ids it just wrote, so nothing downstream would notice the loss.
function resetTheKeyring() {
  // The old secret, encrypted under keyring A…
  writeInbox(entry(OLD, "first"));
  assert.equal(createSecretStore({ baseUrl: BASE }).getSecret(OLD_SID), OLD);
  const envelope = fs.readFileSync(securePath(BASE), "utf8");
  // …then the login keyring is reset: encryption still works, that envelope does not.
  _setSafeForTest(fakeSafe({ key: "keyring-B-after-a-reset" }));
  assert.equal(readJsonState(securePath(BASE)).state, UNDECRYPTABLE, "precondition");
  return envelope;
}

test("an UNDECRYPTABLE held store is moved aside, never written over", () => {
  const envelope = resetTheKeyring();
  const inbox = writeInbox(entry(SECRET, "second"));

  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.getSecret(SID), SECRET, "the newly provisioned secret is served");

  // The old envelope's bytes must still exist, untouched.
  const aside = `${securePath(BASE)}.unreadable`;
  assert.equal(fs.readFileSync(aside, "utf8"), envelope, "the unreadable store must survive byte-identical");
  assert.notEqual(fs.readFileSync(securePath(BASE), "utf8"), envelope);

  // …and they are genuinely RECOVERABLE, not merely present: the original keyring
  // still decrypts them back to the secret they held.
  _setSafeForTest(fakeSafe());
  assert.equal(readJsonState(aside).data.secrets[OLD_SID].secret, OLD, "recoverable once the key is back");

  // The inbox is still shredded — its secret did reach the encrypted store.
  _setSafeForTest(fakeSafe({ key: "keyring-B-after-a-reset" }));
  assert.equal(fs.existsSync(inbox), false);
  assert.deepEqual(createSecretStore({ baseUrl: BASE }).listSecretIds(), [SID]);
});

test("a second reset never overwrites an already-parked unreadable store", () => {
  const first = resetTheKeyring();
  writeInbox(entry(SECRET, "second"));
  assert.equal(createSecretStore({ baseUrl: BASE }).getSecret(SID), SECRET);

  // Reset again, with the first salvaged envelope still parked beside the store.
  const second = fs.readFileSync(securePath(BASE), "utf8");
  _setSafeForTest(fakeSafe({ key: "keyring-C-after-another-reset" }));
  const third = "third-secret", THIRD_SID = secretIdOf(third);
  writeInbox(entry(third, "third"));
  assert.equal(createSecretStore({ baseUrl: BASE }).getSecret(THIRD_SID), third);

  assert.equal(fs.readFileSync(`${securePath(BASE)}.unreadable`, "utf8"), first, "the first salvage must not be clobbered");
  assert.equal(fs.readFileSync(`${securePath(BASE)}.unreadable-2`, "utf8"), second, "the second goes to a free name");
});

test("if the unreadable store cannot be moved aside, nothing is absorbed", () => {
  // The move-aside has to FAIL while the write that follows it would still succeed —
  // otherwise the write fails too and the test would pass for the wrong reason. A HOME
  // deep enough that `<store>.unreadable` crosses PATH_MAX does exactly that: the
  // rename is ENAMETOOLONG, `<store>` and its `.tmp` are both still writable.
  const TAIL = path.join(".remote-browser-keeper", "rb.example.com", "secrets.enc.json");
  const WANT = 4088; // 4088 + ".tmp" still fits in PATH_MAX (4095); + ".unreadable" does not
  const deeper = (n) => path.join(process.env.HOME, "d".repeat(n), TAIL).length;
  while (deeper(200) <= WANT) process.env.HOME = path.join(process.env.HOME, "d".repeat(200));
  process.env.HOME = path.join(process.env.HOME, "d".repeat(WANT - deeper(1) + 1));
  assert.equal(securePath(BASE).length, WANT, "the store path must sit in the window");

  const envelope = resetTheKeyring();
  const inbox = writeInbox(entry(SECRET, "second"));

  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.getSecret(SID), SECRET, "the inbox is still served in memory");
  assert.equal(fs.existsSync(inbox), true, "the inbox must NOT be shredded");
  assert.equal(fs.readFileSync(securePath(BASE), "utf8"), envelope, "the unreadable store stays put, byte-identical");
  assert.deepEqual(fs.readdirSync(path.dirname(inbox)).sort(), ["secrets.enc.json", "secrets.json"],
    "no half-done salvage, and nothing written over the store");
});

test("with every salvage name already taken, nothing is absorbed either", () => {
  const envelope = resetTheKeyring();
  const inbox = writeInbox(entry(SECRET, "second"));
  // Every `.unreadable[-N]` name occupied by an earlier salvage. The backstop must
  // refuse the absorb rather than pick one to overwrite.
  const taken = new Map();
  for (let n = 1; n <= 50; n++) {
    const p = `${securePath(BASE)}.unreadable${n > 1 ? `-${n}` : ""}`;
    taken.set(p, `salvaged envelope ${n}`);
    fs.writeFileSync(p, taken.get(p));
  }

  assert.equal(createSecretStore({ baseUrl: BASE }).getSecret(SID), SECRET);
  assert.equal(fs.existsSync(inbox), true, "the inbox must NOT be shredded");
  assert.equal(fs.readFileSync(securePath(BASE), "utf8"), envelope, "the unreadable store stays put");
  for (const [p, want] of taken) assert.equal(fs.readFileSync(p, "utf8"), want, `${path.basename(p)} must be untouched`);
});

test("a corrupt inbox is reported, not shredded", () => {
  const inbox = vaultPath(BASE);
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.writeFileSync(inbox, "{ not json at all");

  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.getSecret(SID), null);
  assert.equal(fs.existsSync(inbox), true, "a file we merely failed to parse must survive");
  assert.equal(fs.readFileSync(inbox, "utf8"), "{ not json at all");
});

test("verification still guards a tampered store", () => {
  // An entry whose secret does not hash to its id must not be handed back.
  writeInbox({ [SID]: { secret: "not-the-right-secret", label: "tampered" } });
  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.getSecret(SID), null);
  assert.equal(store.firstSecret(), null);
  assert.deepEqual(store.meta(SID), { label: "tampered" }, "metadata is still listable, minus the secret");
});

test("firstSecret + meta read through the encrypted store", () => {
  writeInbox(entry(SECRET, "prod"));
  const store = createSecretStore({ baseUrl: BASE });
  assert.equal(store.firstSecret(), SECRET);
  assert.deepEqual(store.meta(SID), { label: "prod", user_id: "u1", source: "export" });
  assert.equal(store.has(SID), true);
  assert.equal(store.has(secretIdOf("nope")), false);
});

// ---------- securestore states ----------

test("readJsonState tells an empty store from one we cannot read", () => {
  const p = path.join(tmp, "s.json");

  assert.equal(readJsonState(p).state, MISSING);
  assert.equal(readFailed(MISSING), false, "a missing file is genuinely empty, not a failure");

  fs.writeFileSync(p, JSON.stringify({ a: 1 }));
  assert.deepEqual(readJsonState(p), { state: PLAINTEXT, data: { a: 1 } });

  writeJson(p, { a: 2 });
  assert.deepEqual(readJsonState(p).data, { a: 2 });
  assert.equal(readJsonState(p).state, ENCRYPTED);

  // The same envelope on a machine with no OS key: NOT an empty store.
  _setSafeForTest(null);
  assert.equal(readJsonState(p).state, NO_KEY);
  assert.equal(readFailed(NO_KEY), true);

  // A backend that refuses to decrypt it.
  _setSafeForTest({ isEncryptionAvailable: () => true, decryptString() { throw new Error("nope"); }, encryptString: (s) => Buffer.from(s) });
  assert.equal(readJsonState(p).state, UNDECRYPTABLE);
  assert.equal(readFailed(UNDECRYPTABLE), true);

  fs.writeFileSync(p, "}{");
  assert.equal(readJsonState(p).state, CORRUPT);
  assert.equal(readFailed(CORRUPT), true);

  // A JSON scalar is not a store either.
  fs.writeFileSync(p, "42");
  assert.equal(readJsonState(p).state, CORRUPT);
});

test("a write that cannot be completed leaves no temp file behind", () => {
  // The replace is write-then-rename; when the rename cannot happen the temp copy
  // must not survive as a stray file holding the same contents.
  const dir = path.join(tmp, "in-the-way");
  fs.mkdirSync(dir);
  assert.throws(() => writeJson(dir, { secret: "x" }));
  assert.equal(fs.existsSync(`${dir}.tmp`), false);
});
