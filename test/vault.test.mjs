// Unit tests for the synced-vault client core (src/vault.js): crypto round-trip,
// last-write-wins merge, and the pull/merge/push sync against a fake service that
// mimics /api/vault (opaque ciphertext store + optimistic-version 409s).
import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptVault, decryptVault, mergeFieldMaps, secretIdOf,
  pullVault, putVault, syncVault, VAULT_FORMAT,
} from "../src/vault.js";

const SECRET = "correct horse battery staple — high entropy session secret";

// A minimal in-memory stand-in for the service's /api/vault router: stores the
// ciphertext byte-for-byte (never decrypts), enforces base_version, returns 404
// when empty. Shared by a "baseUrl" so multiple clients hit the same store.
function fakeService() {
  let state = null; // { version, secret_id, format, ciphertext }
  async function handler(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    if (method === "GET") {
      if (!state) return jr(404, { detail: "No vault" });
      return jr(200, { version: state.version, secret_id: state.secret_id, format: state.format, updated_at: "t", ciphertext: state.ciphertext });
    }
    if (method === "PUT") {
      const body = JSON.parse(opts.body);
      const base = Number(body.base_version) || 0;
      const cur = state ? state.version : 0;
      if (base !== cur) return jr(409, { detail: { error: "version conflict", current: state ? metaOf(state) : { version: 0 } } });
      state = { version: cur + 1, secret_id: body.secret_id, format: body.format, ciphertext: body.ciphertext };
      return jr(200, { ok: true, metadata: metaOf(state) });
    }
    if (method === "DELETE") { state = null; return jr(200, { deleted: true }); }
    return jr(405, {});
  }
  return { fetchImpl: handler, peek: () => state };
}
const metaOf = (s) => ({ version: s.version, secret_id: s.secret_id, format: s.format, updated_at: "t" });
function jr(status, obj) {
  return { status, ok: status >= 200 && status < 300, json: async () => obj };
}

test("encrypt/decrypt round-trips and rejects tampering", () => {
  const blob = { schema: 1, fields: { "s|h|sel": { value: "hunter2", auto: true, updated_at: "2026-01-01" } } };
  const ct = encryptVault(SECRET, blob);
  assert.deepEqual(decryptVault(SECRET, ct), blob);
  assert.throws(() => decryptVault("wrong secret", ct));
  // flip a byte in the middle → auth tag check fails
  const buf = Buffer.from(ct, "base64");
  buf[20] ^= 0xff;
  assert.throws(() => decryptVault(SECRET, buf.toString("base64")));
});

test("mergeFieldMaps is last-write-wins with tombstones, tie → remote", () => {
  const remote = {
    a: { value: "R", updated_at: "2026-01-02" },
    b: { value: "old", updated_at: "2026-01-01" },
    c: { deleted: true, updated_at: "2026-01-05" },
    tie: { value: "REMOTE", updated_at: "2026-01-09" },
  };
  const local = {
    a: { value: "L", updated_at: "2026-01-01" }, // older → remote wins
    b: { value: "new", updated_at: "2026-01-03" }, // newer → local wins
    c: { value: "resurrect", updated_at: "2026-01-04" }, // older than tombstone → stays deleted
    d: { value: "only-local", updated_at: "2026-01-01" },
    tie: { value: "LOCAL", updated_at: "2026-01-09" }, // equal ts → remote
  };
  const m = mergeFieldMaps(remote, local);
  assert.equal(m.a.value, "R");
  assert.equal(m.b.value, "new");
  assert.equal(m.c.deleted, true);
  assert.equal(m.d.value, "only-local");
  assert.equal(m.tie.value, "REMOTE");
});

test("pullVault returns an empty vault on 404", async () => {
  const svc = fakeService();
  const { version, data } = await pullVault({ baseUrl: "http://x", apiKey: "k" }, SECRET, { fetchImpl: svc.fetchImpl });
  assert.equal(version, 0);
  assert.deepEqual(data.fields, {});
});

test("putVault stores ciphertext unchanged and bumps the version", async () => {
  const svc = fakeService();
  const data = { schema: 1, fields: { k: { value: "v", auto: false, updated_at: "2026-01-01" } } };
  const r = await putVault({ baseUrl: "http://x", apiKey: "k" }, SECRET, data, 0, { fetchImpl: svc.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
  const stored = svc.peek();
  assert.equal(stored.format, VAULT_FORMAT);
  assert.equal(stored.secret_id, secretIdOf(SECRET));
  // server never decrypts; but our client can round-trip the stored ciphertext
  assert.deepEqual(decryptVault(SECRET, stored.ciphertext), data);
});

test("syncVault: two devices converge, and a stale writer retries on 409", async () => {
  const svc = fakeService();
  const cfg = { baseUrl: "http://x", apiKey: "k" };
  // Device A saves entry a.
  await syncVault(cfg, SECRET, (remote) => ({ ...remote, a: { value: "A", auto: false, updated_at: "2026-01-01T00:00:00Z" } }), { fetchImpl: svc.fetchImpl });
  // Device B saves entry b — it pulls A's version first, so both survive.
  const bFields = await syncVault(cfg, SECRET, (remote) => ({ ...remote, b: { value: "B", auto: false, updated_at: "2026-01-02T00:00:00Z" } }), { fetchImpl: svc.fetchImpl });
  assert.equal(bFields.a.value, "A");
  assert.equal(bFields.b.value, "B");
  assert.equal(svc.peek().version, 2);

  // A stale writer whose first PUT races a concurrent bump must retry, not clobber.
  let firstPull = true;
  const racingFetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    if (method === "PUT" && firstPull) {
      firstPull = false;
      // Simulate someone else bumping the version between our pull and put.
      await syncVault(cfg, SECRET, (r) => ({ ...r, sneak: { value: "X", updated_at: "2026-01-03T00:00:00Z" } }), { fetchImpl: svc.fetchImpl });
    }
    return svc.fetchImpl(url, opts);
  };
  const merged = await syncVault(cfg, SECRET, (remote) => ({ ...remote, c: { value: "C", updated_at: "2026-01-04T00:00:00Z" } }), { fetchImpl: racingFetch });
  assert.equal(merged.a.value, "A");
  assert.equal(merged.b.value, "B");
  assert.equal(merged.sneak.value, "X"); // the concurrent write survived the retry
  assert.equal(merged.c.value, "C");
});

test("pullVault rejects a blob encrypted under a different secret", async () => {
  const svc = fakeService();
  await putVault({ baseUrl: "http://x", apiKey: "k" }, "some-other-secret", { schema: 1, fields: {} }, 0, { fetchImpl: svc.fetchImpl });
  await assert.rejects(
    () => pullVault({ baseUrl: "http://x", apiKey: "k" }, SECRET, { fetchImpl: svc.fetchImpl }),
    /secret mismatch/,
  );
});
