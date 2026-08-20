// Device enrollment: trading the shared account key for a credential of this device's own.
//
// Until now every Keeper on an account presented the SAME key (`~/.ac-api-key`), so a
// device's identity was whatever it claimed in its `hello` frame, and the only way to cut
// one device off was to rotate the account key — which cuts off every other device and
// every script at the same time. The service now mints per-device tokens
// (vasyaod/remote-browser-service#33); this module is the client half (issue #15).
//
// Two rules shape everything here, both from the issue's hard constraint:
//
//   1. ADDITIVE, NEVER A CUT. The shared key keeps working forever. We enroll only when
//      the service offers it, we keep the shared key afterwards, and any doubt about the
//      device token (revoked, unreadable, service too old) falls back to the shared key
//      rather than to a broken client. A Keeper the owner cannot reach must never end up
//      unable to authenticate because of something we did here.
//   2. THE TOKEN IS A CREDENTIAL. It is stored encrypted-at-rest via securestore (macOS
//      Keychain / DPAPI / libsecret) exactly like the card store, never in settings.json,
//      never in an environment variable, and never in a URL — the service deliberately
//      refuses device tokens presented as `?api_key=` precisely so they cannot leak
//      through access logs.
//
// This module is intentionally free of Electron imports so the whole decision table can
// be unit-tested; main.js supplies the storage path and does the wiring.

export const ENROLL_PATH = "/api/keeper/devices/enroll";

// How long to wait before asking again after a service says "no" in a way that might
// change (a 5xx, a network blip). An outright "this service has no such endpoint" is
// remembered for the whole run instead — see `enrollmentState`.
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

// What a service's answer to an enrollment attempt MEANS for us.
//
//   ok           — enrolled; use the token from here on
//   unsupported  — this service predates #33 (404), or has no metadata store wired
//                  (503). Not an error: it is capability negotiation, and the shared key
//                  keeps working. Do not ask again this run.
//   unauthorized — the credential we presented isn't valid (401/403). Enrolling cannot
//                  fix that; the connection itself will report the real problem.
//   error        — anything transient. Try again later.
export function classifyEnrollStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 501 || status === 503) return "unsupported";
  if (status === 401 || status === 403) return "unauthorized";
  return "error";
}

// Which credential to present. The device token wins when we have one; otherwise the
// shared account key, which is exactly today's behaviour. Returned tagged, because the
// caller has to know which of the two failed when a socket is rejected.
export function pickCredential({ deviceToken, apiKey } = {}) {
  const t = typeof deviceToken === "string" ? deviceToken.trim() : "";
  if (t) return { token: t, kind: "device" };
  const k = typeof apiKey === "string" ? apiKey.trim() : "";
  return k ? { token: k, kind: "account" } : { token: "", kind: "none" };
}

// Did the service just tell us this device's token is no longer good?
//
// Two shapes, both from the service's own code: the WS upgrade is refused with 401
// "Device token is not enrolled" when no record backs the token, and a live socket is
// closed with 1008 "Device token revoked" the moment the user revokes it in the UI.
//
// `kind` is what we actually presented, and it is load-bearing: the very same 401 means
// "this device was revoked" for a device token and "the account key is wrong" for the
// shared key. Acting on the second would throw away a perfectly good token because the
// user mistyped their key — so nothing here fires unless we presented a device token.
// The reason text is only corroboration; the service is free to reword it, and a rejected
// upgrade delivers a bare status line with no detail at all.
export function isRevocationSignal({ kind = "", httpStatus = 0, code = 0, reason = "" } = {}) {
  if (kind !== "device") return false;
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (code === 1008) return true;
  return /revoke|not enrolled/i.test(String(reason || ""));
}

// The in-memory record of where enrollment stands this run. Deliberately NOT persisted:
// "this service doesn't support enrollment" is a fact about the service, and a service is
// upgraded far more often than the Keeper restarts — persisting it would leave a device
// permanently on the shared key after the service caught up.
export function enrollmentState() {
  return { supported: null, lastAttempt: 0, attempts: 0, lastError: "" };
}

// Should we try (again) right now? Only when there is nothing better to present, the
// service hasn't already said it can't, and we aren't hammering it.
export function shouldEnroll(state, { hasDeviceToken, hasApiKey, now = Date.now() } = {}) {
  if (hasDeviceToken || !hasApiKey) return false;   // nothing to upgrade, or nothing to upgrade WITH
  if (state.supported === false) return false;      // asked and answered for this run
  if (!state.lastAttempt) return true;
  return now - state.lastAttempt >= RETRY_AFTER_MS;
}

// Ask the service for a token of this device's own.
//
// `identity` is the same non-secret block already sent in `hello` ({id, name, platform,
// app_version}); the service assigns the authoritative device id, so ours is only a
// naming hint. Returns a discriminated result and never throws — a failure to enroll is
// never allowed to take down a Keeper that is otherwise working fine.
export async function enrollDevice({ baseUrl, apiKey, identity = {}, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!baseUrl || !apiKey) return { ok: false, reason: "unauthorized", status: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${ENROLL_PATH}`, {
      method: "POST",
      // Header, not query — the service rejects device tokens on the URL, and the key we
      // present to get one has no business there either.
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        device_name: identity.name || undefined,
        platform: identity.platform || undefined,
        app_version: identity.app_version || undefined,
      }),
      signal: ctl.signal,
    });
    const outcome = classifyEnrollStatus(res.status);
    if (outcome !== "ok") return { ok: false, reason: outcome, status: res.status };
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const token = body && typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return { ok: false, reason: "error", status: res.status };
    const device = (body && body.device) || {};
    return {
      ok: true,
      token,
      // The service assigns the id; adopting it keeps our own reports pointing at the
      // record the user sees and revokes in the Devices page.
      deviceId: typeof device.id === "string" ? device.id : "",
      // False when enrolled from a browser login rather than a key: the device can still
      // fill fields, but cannot be the key authority for NEW encrypted sessions. We only
      // ever enroll with the account key, so this should be true — worth surfacing if not.
      secretBound: !!(body && body.secret_bound),
    };
  } catch (e) {
    return { ok: false, reason: "error", status: 0, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
