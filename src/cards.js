// Saved payment cards for unattended auto-fill of card request_fills.
//
// When the service sends a fill_request whose fields are ALL card-* kinds, the
// Keeper can answer it automatically from a locally-stored card — no prompt — by
// mapping each field (+ its format) to the saved card. The proof screenshot +
// metadata are still recorded in history (values are never logged).
//
// Store: ~/.remote-browser-keeper/cards.json (global; a card is the same across
// service envs). chmod 600 — it holds card data. See docs/file-structure.md.
// Shape:
//   {
//     "autofill": true,                 // opt-out with false
//     "default": "visa",                // which card to use
//     "cards": {
//       "visa": {
//         "holder": "JOHN DOE",
//         "number": "4111111111111111",
//         "cvv": "123",                 // omit to be prompted for CVV each time
//         "exp_month": "12", "exp_year": "2028",
//         "billing": { "address_line1": "...", "address_line2": "",
//                      "city": "...", "zip": "...", "state": "CA", "country": "US" }
//       }
//     }
//   }
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readJson } from "./securestore.js";

// Cards are scoped per service base URL (like history/logs), so dev test cards and
// prod cards stay separate: ~/.remote-browser-keeper/<base-url>/cards.json
// At rest the file is OS-encrypted via safeStorage (macOS Keychain / Windows DPAPI
// / Linux libsecret); plaintext only where no backend exists — see securestore.js.
// Existing plaintext files migrate on next save.
function sanitizeForPath(s) {
  return String(s || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

export function cardsPath(baseUrl) {
  return path.join(os.homedir(), ".remote-browser-keeper", sanitizeForPath(baseUrl), "cards.json");
}

// Cards are stored ONLY in the synced vault (see vault.js) — there is NO separate on-disk
// card file. At runtime they live in this in-memory store, hydrated from the vault on each
// sync (mergeRemoteCards) and pushed back to the vault on change (main.js). An existing
// legacy cards.json is read once as a migration source, then removed once the vault holds
// the cards (dropLegacyCardsFile, called after a successful sync).
const _mem = new Map(); // baseUrl -> runtime card store { autofill?, default?, cards, _tombstones, _meta_updated_at }
function nowIso() { return new Date().toISOString(); }

function _store(baseUrl) {
  let s = _mem.get(baseUrl);
  if (s) return s;
  const legacy = readJson(cardsPath(baseUrl)); // one-time migration source (securestore)
  s = legacy && typeof legacy === "object" && (legacy.cards || legacy.autofill !== undefined || legacy._tombstones) ? legacy : {};
  _mem.set(baseUrl, s);
  return s;
}

// A caller-owned copy to mutate — so saveCards can diff it against the runtime store.
export function loadCards(baseUrl) {
  return JSON.parse(JSON.stringify(_store(baseUrl)));
}

// Card content excluding the sync timestamp, for change detection (top-level keys sorted
// for stability; nested `billing` order is stable in practice).
function cardContentKey(c) {
  if (!c || typeof c !== "object") return JSON.stringify(c);
  const { updated_at, ...rest } = c;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// Update the runtime card store (IN MEMORY ONLY — cards persist solely in the synced
// vault, which main.js pushes right after). Central sync bookkeeping so no mutation site
// has to: stamp changed/new cards with `updated_at`, record `_tombstones` for deletes, and
// `_meta_updated_at` for autofill/default — this drives the per-card vault merge (vault.js).
export function saveCards(baseUrl, store) {
  const next = store || {};
  const prev = _store(baseUrl);
  const now = nowIso();
  const prevCards = (prev && prev.cards) || {};
  const nextCards = next.cards || {};
  for (const id of Object.keys(nextCards)) {
    const c = nextCards[id];
    if (!c || typeof c !== "object") continue;
    if (cardContentKey(c) !== cardContentKey(prevCards[id])) c.updated_at = now;        // changed/new
    else if (!c.updated_at) c.updated_at = (prevCards[id] && prevCards[id].updated_at) || now; // keep
  }
  const tombs = { ...((prev && prev._tombstones) || {}) };
  for (const id of Object.keys(prevCards)) if (!(id in nextCards)) tombs[id] = now; // deleted → tombstone
  for (const id of Object.keys(nextCards)) delete tombs[id];                          // resurrected
  next._tombstones = tombs;
  if ((prev && prev.autofill) !== next.autofill || (prev && prev.default) !== next.default) next._meta_updated_at = now;
  else if (!next._meta_updated_at) next._meta_updated_at = (prev && prev._meta_updated_at) || now;
  _mem.set(baseUrl, next);
}

// Once the vault holds the cards, drop the legacy on-disk cards.json so nothing card-
// related persists locally (migration complete). No-op if the file is already gone.
export function dropLegacyCardsFile(baseUrl) {
  try { fs.unlinkSync(cardsPath(baseUrl)); } catch { /* absent — fine */ }
}

// --- Synced-vault helpers (used by main.js against the vault `cards` collection) ---
// The vault `cards` map (live cards each carrying `updated_at`, plus `{deleted,updated_at}`
// tombstones) + `cardsMeta` ({ autofill, default, updated_at }). Stamps any un-timestamped
// (migrated) cards in memory.
export function localCardCollection(baseUrl) {
  const store = _store(baseUrl);
  const cards = store.cards || {};
  const now = nowIso();
  for (const id of Object.keys(cards)) {
    if (cards[id] && typeof cards[id] === "object" && !cards[id].updated_at) cards[id].updated_at = now;
  }
  if (!store._meta_updated_at) store._meta_updated_at = now;
  const map = {};
  for (const id of Object.keys(cards)) map[id] = cards[id];
  for (const [id, ts] of Object.entries(store._tombstones || {})) if (!(id in map)) map[id] = { deleted: true, updated_at: ts };
  const cardsMeta = { updated_at: store._meta_updated_at };
  if (store.autofill !== undefined) cardsMeta.autofill = store.autofill;
  if (store.default !== undefined) cardsMeta.default = store.default;
  return { cards: map, cardsMeta };
}

// Merge a decrypted remote cards map + meta into the runtime store (per-card last-write-
// wins, tombstones for deletes; meta by its own updated_at) and return the merged
// { cards, cardsMeta } to push back. Live cards land in store.cards; tombstones in
// store._tombstones — so the card iterators keep seeing only live cards. In memory only.
export function mergeRemoteCards(baseUrl, remoteCards, remoteMeta) {
  const local = localCardCollection(baseUrl);
  const at = (e) => (e && typeof e.updated_at === "string" ? e.updated_at : "");
  const map = {};
  for (const k of new Set([...Object.keys(remoteCards || {}), ...Object.keys(local.cards || {})])) {
    const r = (remoteCards || {})[k];
    const l = (local.cards || {})[k];
    map[k] = r && l ? (at(l) > at(r) ? l : r) : r || l;
  }
  const lm = local.cardsMeta || {};
  const rm = remoteMeta || {};
  const mergedMeta = at(rm) > at(lm) ? { ...rm } : { ...lm };
  const store = _store(baseUrl);
  const liveCards = {};
  const tombs = {};
  for (const [id, e] of Object.entries(map)) {
    if (e && e.deleted) tombs[id] = e.updated_at;
    else if (e) liveCards[id] = e;
  }
  store.cards = liveCards;
  store._tombstones = tombs;
  store._meta_updated_at = mergedMeta.updated_at || nowIso();
  if (mergedMeta.autofill !== undefined) store.autofill = mergedMeta.autofill;
  if (mergedMeta.default !== undefined) store.default = mergedMeta.default;
  _mem.set(baseUrl, store);
  return { cards: map, cardsMeta: mergedMeta };
}

// Auto-fill on by default when a card exists; opt out with "autofill": false.
export function autofillEnabled(store) {
  return !!store && store.autofill !== false;
}

// True when every field in the request is a card-* kind.
export function isCardOnlyRequest(fields) {
  return (
    Array.isArray(fields) && fields.length > 0 &&
    fields.every((f) => String((f && f.field) || "").toLowerCase().startsWith("card-"))
  );
}

export function pickCard(store) {
  const cards = (store && store.cards) || {};
  const ids = Object.keys(cards);
  if (!ids.length) return null;
  const id = store && store.default && cards[store.default] ? store.default : ids[0];
  return cards[id] || null;
}

// ---- Per-domain auto-fill permission (stored on the card as `domains`) ----
// A card is auto-filled silently only on domains the user has approved for it;
// otherwise the prompt shows (with the picker + a "remember this site" option).
export function hostFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}
function domainMatches(approved, host) {
  if (approved === "*") return true; // "*" = approved for all sites
  const a = String(approved || "").toLowerCase().replace(/^www\./, "");
  return !!a && !!host && (host === a || host.endsWith("." + a));
}
// The card approved to auto-fill on `host`, or null. (default card preferred.)
export function findCardForDomain(store, host) {
  const cards = (store && store.cards) || {};
  if (!host) return null;
  const ids = Object.keys(cards);
  const ordered = store && store.default && cards[store.default]
    ? [store.default, ...ids.filter((i) => i !== store.default)] : ids;
  for (const id of ordered) {
    const doms = Array.isArray(cards[id].domains) ? cards[id].domains : [];
    if (doms.some((d) => domainMatches(d, host))) return cards[id];
  }
  return null;
}
// Record approval for `host` on a card (caller persists the store). Returns true if changed.
export function approveDomain(store, cardId, host) {
  const card = ((store && store.cards) || {})[cardId];
  if (!card || !host) return false;
  if (!Array.isArray(card.domains)) card.domains = [];
  if (card.domains.includes(host)) return false;
  card.domains.push(host);
  return true;
}
// Approve a card for ALL sites (wildcard). Returns true if changed.
export function approveAllSites(store, cardId) {
  const card = ((store && store.cards) || {})[cardId];
  if (!card) return false;
  if (!Array.isArray(card.domains)) card.domains = [];
  if (card.domains.includes("*")) return false;
  card.domains.push("*");
  return true;
}

const CARD_EXP_DEFAULT = "MM/YY";
function cardExpTemplate(format) {
  return format && /[MY]/i.test(format) ? format : CARD_EXP_DEFAULT;
}
function expFromTemplate(card, template) {
  const mm = String(card.exp_month == null ? "" : card.exp_month).replace(/\D/g, "").padStart(2, "0").slice(-2);
  const yraw = String(card.exp_year == null ? "" : card.exp_year).replace(/\D/g, "");
  const yyyy = yraw.length >= 4 ? yraw.slice(-4) : yraw.length === 2 ? "20" + yraw : yraw;
  const yy = yyyy.slice(-2);
  return String(template).replace(/Y{3,4}/g, yyyy).replace(/Y{1,2}/g, yy).replace(/M{1,2}/g, mm);
}

const BILLING_TOKENS = {
  ADDRESS_LINE1: "address_line1", ADDRESS_LINE2: "address_line2",
  CITY: "city", ZIP: "zip", STATE: "state", COUNTRY: "country",
};
function billingValue(card, format) {
  const b = (card && card.billing) || {};
  if (!format || !String(format).trim()) {
    return [b.address_line1, b.address_line2, b.city, b.zip, b.state, b.country].filter(Boolean).join(", ");
  }
  return String(format).split(",")
    .map((t) => { const k = BILLING_TOKENS[t.trim().toUpperCase()]; return k ? (b[k] || "") : ""; })
    .filter(Boolean).join(", ");
}

// Value for a request field from the saved card. null = not a card field.
export function cardValueForField(field, format, card) {
  switch (String(field || "").toLowerCase()) {
    case "card-holder-name": return String(card.holder || "");
    case "card-number": return String(card.number || "").replace(/\D/g, "");
    case "card-cvv": return String(card.cvv || "");
    case "card-exp": return expFromTemplate(card, cardExpTemplate(format));
    case "card-billing-address": return billingValue(card, format);
    default: return null;
  }
}

// Card ids for the prompt's "use a saved card" picker (no values).
export function cardOptions(store) {
  const cards = (store && store.cards) || {};
  const def = store && store.default;
  return Object.keys(cards).map((id) => ({ id, isDefault: id === def }));
}

// Map a card onto a request's fields for the picker — fills whatever it can
// (empties allowed); the user reviews/edits before sending.
export function mapCardToFields(card, fields) {
  if (!card || !Array.isArray(fields)) return [];
  return fields
    .map((f) => ({ selector: f && f.selector, value: cardValueForField(f && f.field, f && f.format, card) }))
    .filter((v) => v.selector && v.value != null);
}

// Build {selector,value}[] for a card-only request, or null if the card can't
// satisfy it (missing a core value other than billing) — caller then prompts.
export function buildCardValues(fields, card) {
  const values = [];
  for (const f of fields) {
    const kind = String((f && f.field) || "").toLowerCase();
    const value = cardValueForField(kind, f.format, card);
    if (value == null) return null; // not a card field — shouldn't happen
    // Billing components may legitimately be empty; core card fields must not be.
    if (kind !== "card-billing-address" && value === "") return null;
    values.push({ selector: f.selector, value });
  }
  return values;
}
