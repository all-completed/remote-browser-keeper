// Device enrollment (issue #15). The rules under test are the ones the issue calls
// non-negotiable: a Keeper on the shared key must keep working against every service,
// old or new, and must never be talked into an auth-failure loop.
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyEnrollStatus,
  pickCredential,
  isRevocationSignal,
  enrollmentState,
  shouldEnroll,
  enrollDevice,
  RETRY_AFTER_MS,
} from "../src/enroll.js";

test("a service that has never heard of enrollment is a capability gap, not an error", () => {
  assert.equal(classifyEnrollStatus(404), "unsupported"); // predates the feature
  assert.equal(classifyEnrollStatus(503), "unsupported"); // feature present, unwired
  assert.equal(classifyEnrollStatus(200), "ok");
  assert.equal(classifyEnrollStatus(401), "unauthorized");
  assert.equal(classifyEnrollStatus(500), "error");       // transient — worth retrying
});

test("the device token wins when present; the account key is always the fallback", () => {
  assert.deepEqual(pickCredential({ deviceToken: "dt", apiKey: "ak" }), { token: "dt", kind: "device" });
  assert.deepEqual(pickCredential({ apiKey: "ak" }), { token: "ak", kind: "account" });
  assert.deepEqual(pickCredential({ deviceToken: "   ", apiKey: "ak" }), { token: "ak", kind: "account" });
  assert.deepEqual(pickCredential({}), { token: "", kind: "none" });
});

test("a 401 on the ACCOUNT key never discards a device token", () => {
  // The same status means opposite things depending on what we presented. Treating a
  // mistyped account key as a revoke would throw away a valid enrollment.
  assert.equal(isRevocationSignal({ kind: "account", httpStatus: 401 }), false);
  assert.equal(isRevocationSignal({ kind: "device", httpStatus: 401 }), true);
  assert.equal(isRevocationSignal({ kind: "device", code: 1008, reason: "Device token revoked" }), true);
  // An ordinary disconnect is not a revoke — this is the case that would otherwise
  // silently un-enroll a device every time the network hiccuped.
  assert.equal(isRevocationSignal({ kind: "device", code: 1006 }), false);
  assert.equal(isRevocationSignal({ kind: "device", code: 1000 }), false);
});

test("enrollment is attempted only when there is something to upgrade, and with room to breathe", () => {
  const st = enrollmentState();
  assert.equal(shouldEnroll(st, { hasDeviceToken: false, hasApiKey: true }), true);
  assert.equal(shouldEnroll(st, { hasDeviceToken: true, hasApiKey: true }), false);  // already enrolled
  assert.equal(shouldEnroll(st, { hasDeviceToken: false, hasApiKey: false }), false); // nothing to present

  const now = 1_000_000;
  const tried = { ...enrollmentState(), lastAttempt: now };
  assert.equal(shouldEnroll(tried, { hasDeviceToken: false, hasApiKey: true, now: now + 1000 }), false);
  assert.equal(shouldEnroll(tried, { hasDeviceToken: false, hasApiKey: true, now: now + RETRY_AFTER_MS }), true);

  const old = { ...enrollmentState(), supported: false };
  assert.equal(shouldEnroll(old, { hasDeviceToken: false, hasApiKey: true }), false); // asked and answered
});

test("enrollDevice sends the key in a header, never the URL", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    // `device_id` is what the service actually returns (public_device_record) — reading
    // `id` here is what shipped first, and it silently left every device unadopted.
    return { status: 200, json: async () => ({ token: "dev-token", device: { device_id: "d1" }, secret_bound: true }) };
  };
  const res = await enrollDevice({
    baseUrl: "https://rb.example.com/",
    apiKey: "SHARED-KEY",
    identity: { name: "mac", platform: "macOS", app_version: "0.1.0" },
    fetchImpl,
  });
  assert.deepEqual(res, { ok: true, token: "dev-token", deviceId: "d1", secretBound: true });
  assert.equal(seen.url, "https://rb.example.com/api/keeper/devices/enroll");
  assert.ok(!seen.url.includes("SHARED-KEY"));           // the service rejects tokens on the URL
  assert.equal(seen.init.headers.Authorization, "Bearer SHARED-KEY");
  assert.deepEqual(JSON.parse(seen.init.body), {
    device_name: "mac", platform: "macOS", app_version: "0.1.0",
  });
});

test("an old service, a broken one, and a hung one all leave us on the account key", async () => {
  const gone = await enrollDevice({ baseUrl: "https://x", apiKey: "k", fetchImpl: async () => ({ status: 404 }) });
  assert.deepEqual(gone, { ok: false, reason: "unsupported", status: 404 });

  const thrown = await enrollDevice({
    baseUrl: "https://x", apiKey: "k",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, "error");  // never propagates: a Keeper that works keeps working

  // A 200 with no token is not an enrollment, however cheerful the body is.
  const empty = await enrollDevice({
    baseUrl: "https://x", apiKey: "k",
    fetchImpl: async () => ({ status: 200, json: async () => ({ status: "success" }) }),
  });
  assert.equal(empty.ok, false);
});

test("no account key means no enrollment attempt at all", async () => {
  let called = false;
  const res = await enrollDevice({
    baseUrl: "https://x", apiKey: "",
    fetchImpl: async () => { called = true; return { status: 200 }; },
  });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});
