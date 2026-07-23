// Saved field values (passwords and other entered values) the user chose to keep,
// so future fill_requests for the same field prefill automatically. Three scopes,
// implied by where the value lives:
//   - "session" : in-memory only, cleared when the Keeper restarts.
//   - "forever" : persisted to ~/.remote-browser-keeper/<base-url>/fields.json,
//                 OS-encrypted via securestore (safeStorage/Keychain) when available.
//   - "vault"   : cached locally in vault.json (also OS-encrypted) AND end-to-end
//                 encrypted + synced across every paired Keeper via /api/vault
//                 (see vault.js). The local cache is the source for auto-fill; main.js
//                 pushes/pulls it. Vault entries carry an `updated_at` for merge, and
//                 a delete leaves a { deleted, updated_at } tombstone so it propagates.
// Keyed by session + host + selector. Values stay on this machine, never sent to the AI.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./securestore.js";

const memory = new Map(); // "session|host|selector" -> value (cleared on restart)

function sanitizeForPath(s) {
  return String(s || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}
function fieldsPath(baseUrl) {
  return path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl), "fields.json");
}
function vaultFilePath(baseUrl) {
  return path.join(app.getPath("home"), ".remote-browser-keeper", sanitizeForPath(baseUrl), "vault.json");
}
function nowIso() { return new Date().toISOString(); }
// Normalize the parts so the same field always maps to ONE key — incidental
// whitespace in the agent-supplied selector (or session) otherwise creates a second,
// identical-looking entry AND makes auto-fill miss the saved value (→ re-prompt → dup).
function keyOf(session, host, selector) {
  return `${String(session || "").trim()}|${host}|${String(selector || "").trim()}`;
}
function loadPersisted(baseUrl) {
  const obj = readJson(fieldsPath(baseUrl));
  return obj && typeof obj === "object" ? obj : {};
}
function writePersisted(baseUrl, obj) {
  try { fs.mkdirSync(path.dirname(fieldsPath(baseUrl)), { recursive: true }); } catch { /* ignore */ }
  writeJson(fieldsPath(baseUrl), obj);
}

// --- Vault local cache (the mergeable copy main.js syncs to /api/vault) ---
// Returns the raw field map, which MAY include { deleted, updated_at } tombstones.
function loadVaultFields(baseUrl) {
  const obj = readJson(vaultFilePath(baseUrl));
  const fields = obj && typeof obj === "object" ? obj.fields : null;
  return fields && typeof fields === "object" ? fields : {};
}
function writeVaultFields(baseUrl, fields) {
  try { fs.mkdirSync(path.dirname(vaultFilePath(baseUrl)), { recursive: true }); } catch { /* ignore */ }
  writeJson(vaultFilePath(baseUrl), { schema: 1, fields: fields || {} });
}
function isLive(entry) { return entry && typeof entry === "object" && !entry.deleted; }

// An entry is { value, auto }; older persisted entries may be a bare string.
function unwrap(entry) {
  if (entry && typeof entry === "object") return { value: entry.value, auto: !!entry.auto };
  return { value: entry, auto: false };
}

// Returns { value, scope, auto } or null. Scope is derived from where it's stored;
// auto means "fill automatically without prompting next time".
export function getSaved(baseUrl, session, host, selector) {
  const k = keyOf(session, host, selector);
  if (memory.has(k)) { const e = unwrap(memory.get(k)); return { value: e.value, auto: e.auto, scope: "session" }; }
  const persisted = loadPersisted(baseUrl);
  if (Object.prototype.hasOwnProperty.call(persisted, k)) { const e = unwrap(persisted[k]); return { value: e.value, auto: e.auto, scope: "forever" }; }
  const vaultFields = loadVaultFields(baseUrl);
  if (isLive(vaultFields[k])) { const e = vaultFields[k]; return { value: e.value, auto: !!e.auto, scope: "vault" }; }
  return null;
}

export function saveValue(baseUrl, session, host, selector, value, scope, auto) {
  if (!host || !selector) return;
  const k = keyOf(session, host, selector);
  const entry = { value, auto: !!auto };
  if (scope === "session") {
    memory.set(k, entry);
    // ensure it isn't also persisted under the old scope
    const persisted = loadPersisted(baseUrl);
    if (k in persisted) { delete persisted[k]; writePersisted(baseUrl, persisted); }
    clearVault(baseUrl, k);
    return;
  }
  if (scope === "forever") {
    memory.delete(k);
    const persisted = loadPersisted(baseUrl);
    persisted[k] = entry;
    writePersisted(baseUrl, persisted);
    clearVault(baseUrl, k);
    return;
  }
  if (scope === "vault") {
    memory.delete(k);
    const persisted = loadPersisted(baseUrl);
    if (k in persisted) { delete persisted[k]; writePersisted(baseUrl, persisted); }
    const vaultFields = loadVaultFields(baseUrl);
    vaultFields[k] = { value, auto: !!auto, updated_at: nowIso() };
    writeVaultFields(baseUrl, vaultFields);
  }
}

// Drop a key from the vault cache when it moves to a non-vault scope, leaving a
// tombstone so the removal syncs to the other devices too.
function clearVault(baseUrl, k) {
  const vaultFields = loadVaultFields(baseUrl);
  if (isLive(vaultFields[k])) {
    vaultFields[k] = { deleted: true, updated_at: nowIso() };
    writeVaultFields(baseUrl, vaultFields);
  }
}

export function forget(baseUrl, session, host, selector) {
  if (!host || !selector) return;
  const k = keyOf(session, host, selector);
  memory.delete(k);
  const persisted = loadPersisted(baseUrl);
  if (k in persisted) { delete persisted[k]; writePersisted(baseUrl, persisted); }
  clearVault(baseUrl, k); // tombstone so the delete propagates to other devices
}

function parseKey(k) {
  const i1 = k.indexOf("|");
  const i2 = k.indexOf("|", i1 + 1);
  if (i1 < 0 || i2 < 0) return null;
  return { session: k.slice(0, i1), host: k.slice(i1 + 1, i2), selector: k.slice(i2 + 1) };
}

// List saved entries (metadata only — NEVER the value) for the management window.
export function listSaved(baseUrl) {
  // Dedup by normalized session|host|selector so the same field never shows twice
  // (whitespace-different keys, or a key present in both memory and persisted). A
  // persisted "forever" entry wins over an in-memory "session" one.
  const byKey = new Map();
  const add = (k, scope, auto) => {
    const p = parseKey(k);
    if (!p) return;
    const norm = `${p.session.trim()}|${p.host}|${p.selector.trim()}`;
    if (scope === "forever" || !byKey.has(norm)) byKey.set(norm, { ...p, scope, auto });
  };
  for (const [k, e] of memory.entries()) add(k, "session", !!unwrap(e).auto);
  const persisted = loadPersisted(baseUrl);
  for (const k of Object.keys(persisted)) add(k, "forever", !!unwrap(persisted[k]).auto);
  const vaultFields = loadVaultFields(baseUrl);
  for (const k of Object.keys(vaultFields)) if (isLive(vaultFields[k])) add(k, "vault", !!vaultFields[k].auto);
  return [...byKey.values()];
}

export function forgetAll(baseUrl) {
  memory.clear();
  writePersisted(baseUrl, {});
  // Tombstone every live vault entry so the wipe also propagates to paired devices.
  const vaultFields = loadVaultFields(baseUrl);
  let changed = false;
  for (const k of Object.keys(vaultFields)) {
    if (isLive(vaultFields[k])) { vaultFields[k] = { deleted: true, updated_at: nowIso() }; changed = true; }
  }
  if (changed) writeVaultFields(baseUrl, vaultFields);
}

// --- Vault sync helpers (used by main.js against /api/vault via vault.js) ---
// The full local vault field map (INCLUDING tombstones) to push to the server.
export function localVaultMap(baseUrl) {
  return loadVaultFields(baseUrl);
}
// Merge a decrypted remote field map into the local cache (last-write-wins by
// updated_at, tie → remote) and persist it. Returns the merged map so the caller
// can push it back — this is the mutate() passed to vault.syncVault().
export function mergeRemoteVault(baseUrl, remoteFields) {
  const local = loadVaultFields(baseUrl);
  const merged = {};
  const at = (e) => (e && typeof e.updated_at === "string" ? e.updated_at : "");
  for (const k of new Set([...Object.keys(remoteFields || {}), ...Object.keys(local || {})])) {
    const r = remoteFields && remoteFields[k];
    const l = local && local[k];
    merged[k] = r && l ? (at(l) > at(r) ? l : r) : r || l;
  }
  writeVaultFields(baseUrl, merged);
  return merged;
}
