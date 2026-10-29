// Where this device's own token lives (issue #15).
//
// It is a credential, so it gets the same treatment as the card store: an encrypted
// envelope via securestore (macOS Keychain / Windows DPAPI / Linux libsecret), chmod 600,
// under the same per-base-URL directory as everything else. Per base URL matters here as
// much as it does for the vault key — a dev Keeper and a prod Keeper on one machine are
// two separate devices with two separate tokens, and mixing them would have each one
// presenting a token the other service has never heard of.
//
// The shared account key is NOT stored here and is never touched by this module. That
// separation is the whole point: revoking this device must leave the account key, and
// every other device, exactly as they were.
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { readJson, writeJson } from "./securestore.js";

function sanitizeForPath(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

export function deviceTokenPath(baseUrl) {
  return path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl), "device-token.json");
}

// The stored token, or "" when this device hasn't enrolled (or the store can't be read
// on this machine — an unreadable token is the same as none, and we fall back to the
// account key rather than presenting something we can't verify).
export function loadDeviceToken(baseUrl) {
  const o = readJson(deviceTokenPath(baseUrl));
  return o && typeof o.token === "string" ? o.token.trim() : "";
}

// The whole record: the token plus the non-secret enrollment facts worth showing in
// Settings ("this device is enrolled, as <id>, since <when>").
export function loadDeviceEnrollment(baseUrl) {
  const o = readJson(deviceTokenPath(baseUrl)) || {};
  return {
    token: typeof o.token === "string" ? o.token.trim() : "",
    deviceId: typeof o.device_id === "string" ? o.device_id : "",
    enrolledAt: typeof o.enrolled_at === "string" ? o.enrolled_at : "",
    secretBound: !!o.secret_bound,
  };
}

export function saveDeviceToken(baseUrl, { token, deviceId = "", secretBound = false }) {
  const p = deviceTokenPath(baseUrl);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeJson(p, {
    token,
    device_id: deviceId,
    secret_bound: !!secretBound,
    enrolled_at: new Date().toISOString(),
  });
}

// Forget the token — after a revoke, or when the service says no record backs it.
// Deleting the file (rather than blanking the field) keeps "never enrolled" and
// "enrollment withdrawn" indistinguishable on disk, which is what we want: the next
// connect simply re-enrolls if the service still offers it.
export function clearDeviceToken(baseUrl) {
  try { fs.unlinkSync(deviceTokenPath(baseUrl)); } catch { /* already gone */ }
}
