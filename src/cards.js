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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cards are scoped per service base URL (like history/logs), so dev test cards and
// prod cards stay separate: ~/.remote-browser-keeper/<base-url>/cards.json
function sanitizeForPath(s) {
  return String(s || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

export function cardsPath(baseUrl) {
  return path.join(os.homedir(), ".remote-browser-keeper", sanitizeForPath(baseUrl), "cards.json");
}

export function loadCards(baseUrl) {
  try {
    const v = JSON.parse(fs.readFileSync(cardsPath(baseUrl), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Persist the whole store (chmod 600 — it holds card data).
export function saveCards(baseUrl, store) {
  const p = cardsPath(baseUrl);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store || {}, null, 2));
  try { fs.chmodSync(p, 0o600); } catch {}
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
