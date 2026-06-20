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

export function cardsPath() {
  return path.join(os.homedir(), ".remote-browser-keeper", "cards.json");
}

export function loadCards() {
  try {
    const v = JSON.parse(fs.readFileSync(cardsPath(), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Persist the whole store (chmod 600 — it holds card data).
export function saveCards(store) {
  const p = cardsPath();
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
