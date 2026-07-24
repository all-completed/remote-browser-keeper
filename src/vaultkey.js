// The vault's DEDICATED encryption password (item 1) — independent of the session
// secret. Stored OS-encrypted (Electron safeStorage → macOS Keychain / Windows DPAPI /
// libsecret) via securestore, in ~/.remote-browser-keeper/<base-url>/vault-key.json.
//
// The Keeper GENERATES a high-entropy password on first use and can accept a
// user-chosen one (item 3, pbkdf2). A paired mobile device receives this same password
// through the pair QR (item 2) and stores it the same way, so every device shares one
// vault key with no key ever reaching the service.
import path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./securestore.js";
import { generateVaultKey, userVaultKey, FORMAT_SHA256_V2 } from "./vault.js";

function sanitizeForPath(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}
function keyPath(baseUrl) {
  return path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl), "vault-key.json");
}

// The stored vault key config { password, format, salt? }, or null when none is held.
export function loadVaultKey(baseUrl) {
  const o = readJson(keyPath(baseUrl));
  if (o && typeof o.password === "string" && o.password) {
    return { password: o.password, format: o.format || FORMAT_SHA256_V2, ...(o.salt ? { salt: o.salt } : {}) };
  }
  return null;
}

export function saveVaultKey(baseUrl, key) {
  writeJson(keyPath(baseUrl), { password: key.password, format: key.format || FORMAT_SHA256_V2, ...(key.salt ? { salt: key.salt } : {}) });
  return key;
}

// Return the held vault key, generating + persisting a fresh high-entropy one if absent.
export function ensureVaultKey(baseUrl) {
  return loadVaultKey(baseUrl) || saveVaultKey(baseUrl, generateVaultKey());
}

// Adopt a vault key received from a paired device (item 2). Overwrites any local one.
export function adoptVaultKey(baseUrl, key) {
  if (!key || typeof key.password !== "string" || !key.password) return null;
  return saveVaultKey(baseUrl, { password: key.password, format: key.format || FORMAT_SHA256_V2, salt: key.salt });
}

// Switch to a user-chosen password (item 3). Returns the new key; the caller re-encrypts
// + re-uploads the vault and re-shares via pairing.
export function setUserVaultKey(baseUrl, password) {
  return saveVaultKey(baseUrl, userVaultKey(password));
}

// The pair-QR payload half for the vault key (item 2): only what another device needs to
// derive the same key. Never logged / shown as renderer text (rides inside the QR image).
export function vaultKeyForPairing(baseUrl) {
  const k = ensureVaultKey(baseUrl);
  return { password: k.password, format: k.format, ...(k.salt ? { salt: k.salt } : {}) };
}
