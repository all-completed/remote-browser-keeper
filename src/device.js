// This device's identity, and the inert report that says WHICH vault it is holding.
//
// Without it neither the user nor the service can answer two operational questions:
// which devices are paired and hold a vault, and what vault version each is on. The
// second is security-relevant — a device left on the legacy v1 key model is an exposure,
// not cosmetic version skew (see vault.js's header).
//
// Everything here is NON-SECRET metadata: a stable id, a human-readable name, the
// platform, the app version, and the vault's blob `schema` + key `format` + last synced
// `version`. It never carries the vault password, the derived key, a session secret, or
// any field/card value.
//
// The one sharp edge is `secret_id`, which is why this module does not compute one:
// vaultKeyReport() (vault.js) owns that rule — the id is publishable under v2, but under
// legacy aesgcm-sha256-v1 it IS the AES key, so a v1 device reports its format and no id.
//
// The id lives beside the other per-service state, in
// ~/.remote-browser-keeper/<base-url>/device.json — plain JSON like settings.json, since
// it is a label, not a credential. Per base URL, so a dev and a prod Keeper on the same
// machine are two distinct devices, exactly as they are for every other stored file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { app } from "electron";
import { loadVaultKey } from "./vaultkey.js";
import { vaultKeyReport } from "./vault.js";

const PLATFORMS = { darwin: "macOS", win32: "Windows", linux: "Linux" };

function sanitizeForPath(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}
function devicePath(baseUrl) {
  return path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl), "device.json");
}

// The stable id for this install + service, generated once and reused forever after.
function loadOrCreateId(baseUrl) {
  const p = devicePath(baseUrl);
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    if (o && typeof o.id === "string" && o.id) return o.id;
  } catch { /* absent or unreadable — mint a new one below */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ id }, null, 2));
  } catch { /* unwritable home: the id is still usable for this run */ }
  return id;
}

// Who this device is: { id, name, platform, app_version }.
export function deviceIdentity(baseUrl) {
  return {
    id: loadOrCreateId(baseUrl),
    name: String(os.hostname() || "").replace(/\.local$/i, "") || "Keeper",
    platform: PLATFORMS[process.platform] || process.platform,
    app_version: app.getVersion(),
  };
}

// Identity + vault state, as sent on connect and shown in Settings.
//
// `state` is the single field to act on, and it keeps apart the two failures that look
// alike from outside but need opposite fixes:
//   no_key       — this device holds no vault key (never paired, or it was cleared)
//   needs_repair — a vault exists but this device cannot decrypt it (VaultKeyMismatch:
//                  the password was changed elsewhere) → re-pair
//   legacy_v1    — holding the legacy aesgcm-sha256-v1 key model → migrate
//   ok           — on a v2 key model and in sync
export function buildDeviceReport(baseUrl, { needsRepair = false, version = null } = {}) {
  let key = null;
  try { key = loadVaultKey(baseUrl); } catch { key = null; }
  const vault = vaultKeyReport(key);
  const state = !vault.has_key ? "no_key" : needsRepair ? "needs_repair" : vault.legacy ? "legacy_v1" : "ok";
  return {
    device: deviceIdentity(baseUrl),
    vault: { ...vault, needs_migration: vault.legacy, version: Number.isFinite(version) ? version : null, state },
  };
}
