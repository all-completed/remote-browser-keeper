// Card / field formatting helpers — ported from the vanilla renderer/prompt.js.
// Pure functions (no DOM); React components compose them.

export function shortUrl(u) {
  try {
    const x = new URL(u);
    const s = x.host + (x.pathname === "/" ? "" : x.pathname);
    return s.length > 56 ? s.slice(0, 55) + "…" : s;
  } catch {
    return (u || "").length > 56 ? u.slice(0, 55) + "…" : u || "";
  }
}

// Masked: password, code, card-cvv. Plain (visible): text/login/email and the
// card fields (the number is shown grouped; only the CVV is masked).
export function isSecret(field) {
  const f = String(field || "").toLowerCase();
  return !(
    f === "text" || f === "login" || f === "email" ||
    f === "card-number" || f === "card-holder-name" || f === "card-exp" ||
    f === "card-billing-address"
  );
}

// ---- Card templates ----
export const CARD_NUMBER_DEFAULT = "#### #### #### ####"; // 16 digits, grouped
export const CARD_EXP_DEFAULT = "MM/YY";

function templateSlots(t) {
  return (String(t).match(/[A-Za-z#]/g) || []).length;
}
export function fillTemplate(template, raw) {
  const digits = String(raw).replace(/\D/g, "").slice(0, templateSlots(template));
  let out = "";
  let di = 0;
  for (const ch of String(template)) {
    if (/[A-Za-z#]/.test(ch)) {
      if (di < digits.length) out += digits[di++]; else break;
    } else if (di < digits.length) {
      out += ch;
    } else break;
  }
  return out;
}
export function cardNumberMask(format) {
  return format && format.indexOf("#") >= 0 ? format : CARD_NUMBER_DEFAULT;
}
export function cardExpTemplate(format) {
  return format && /[MY]/i.test(format) ? format : CARD_EXP_DEFAULT;
}

// A card-exp field whose format is year-only (YYYY/YY) or month-only (MM) renders
// a dropdown; combined MM/YY (or no format) stays typed. Returns 'year'|'month'|null.
export function expFieldMode(field, format) {
  if (String(field || "").toLowerCase() !== "card-exp") return null;
  const f = String(format || "");
  const hasY = /Y/i.test(f), hasM = /M/i.test(f);
  if (hasY && !hasM) return "year";
  if (hasM && !hasY) return "month";
  return null;
}
export function yearIsFourDigit(format) {
  return (String(format || "").match(/Y/gi) || []).length >= 4;
}
export function monthOptions() {
  return Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
}
export function yearOptions(format) {
  const four = yearIsFourDigit(format);
  const now = new Date().getFullYear();
  return Array.from({ length: 11 }, (_, i) => {
    const y = now + i;
    return four ? String(y) : String(y).slice(-2);
  });
}

const BILLING_TOKENS = {
  ADDRESS_LINE1: "address line 1", ADDRESS_LINE2: "address line 2",
  CITY: "city", ZIP: "ZIP", STATE: "state", COUNTRY: "country",
};
export function humanizeBilling(format) {
  if (!format) return "";
  return String(format).split(",")
    .map((t) => BILLING_TOKENS[t.trim().toUpperCase()] || t.trim())
    .filter(Boolean).join(", ");
}

export function isMultiline(field, format) {
  return String(field || "").toLowerCase() === "card-billing-address" && !(format && String(format).trim());
}

export function cardMaxLen(field, format) {
  switch (String(field || "").toLowerCase()) {
    case "card-number": return cardNumberMask(format).length;
    case "card-exp": return cardExpTemplate(format).length;
    case "card-cvv": return 4;
    default: return 0;
  }
}

// Transform input for digit-grouped / MM-YY card fields; null = not such a field.
export function formatCardInput(field, format, raw) {
  switch (String(field || "").toLowerCase()) {
    case "card-number": return fillTemplate(cardNumberMask(format), raw);
    case "card-exp": return fillTemplate(cardExpTemplate(format), raw);
    case "card-cvv": return String(raw).replace(/\D/g, "").slice(0, 4);
    default: return null;
  }
}

// Value to submit (card number is grouped for display; send digits only).
export function submitVal(field, v) {
  return String(field || "").toLowerCase() === "card-number" ? String(v).replace(/\D/g, "") : v;
}

export function cardHint(field, format) {
  switch (String(field || "").toLowerCase()) {
    case "card-number": return "card number · digits only";
    case "card-cvv": return "CVV";
    case "card-exp": return cardExpTemplate(format);
    case "card-holder-name": return "name on card";
    case "card-billing-address": return humanizeBilling(format) || "billing address";
    default: return "";
  }
}

// What kind of control a field renders as, plus its hint/limits.
export function describeField(field) {
  const kind = String(field.field || "").toLowerCase();
  const fmt = field.format;
  const exp = expFieldMode(kind, fmt);
  if (exp) {
    return {
      mode: exp, // "month" | "year"
      hint: exp === "month" ? "expiry month" : (yearIsFourDigit(fmt) ? "expiry year" : "expiry year (2-digit)"),
      options: exp === "month" ? monthOptions() : yearOptions(fmt),
    };
  }
  const multiline = isMultiline(kind, fmt);
  const secret = isSecret(kind);
  const maxLen = (Number.isInteger(field.length) && field.length > 0) ? field.length : cardMaxLen(kind, fmt);
  let hint = "", inputMode, placeholder, pattern;
  if (formatCardInput(kind, fmt, "") !== null) {
    inputMode = "numeric"; hint = cardHint(kind, fmt);
  } else if (kind.startsWith("card-")) {
    hint = cardHint(kind, fmt);
  } else {
    const pf = plainFormat(fmt);
    inputMode = pf.inputMode; placeholder = pf.placeholder; pattern = pf.pattern; hint = pf.hint;
  }
  const hints = [hint, maxLen ? `max ${maxLen}` : ""].filter(Boolean).join(" · ");
  return { mode: multiline ? "multiline" : "input", secret, maxLen, inputMode, placeholder, pattern, hint: hints };
}

// Apply card grouping / numeric / max-length as the user types (selects pass through).
export function transformValue(field, raw) {
  const kind = String(field.field || "").toLowerCase();
  if (expFieldMode(kind, field.format)) return raw; // dropdown value as-is
  let v = raw;
  const carded = formatCardInput(kind, field.format, v);
  if (carded !== null) v = carded;
  else {
    const pf = plainFormat(field.format);
    if (pf.transform) v = pf.transform(v);
  }
  const maxLen = (Number.isInteger(field.length) && field.length > 0) ? field.length : cardMaxLen(kind, field.format);
  if (maxLen && v.length > maxLen) v = v.slice(0, maxLen);
  return v;
}

// Non-card format → descriptor for the input (inputMode/placeholder/pattern/hint
// and an optional digit-only transform). Mirrors the old applyFormat().
export function plainFormat(format) {
  if (!format) return { hint: "" };
  const f = String(format).toLowerCase();
  if (f === "email") return { inputMode: "email", placeholder: "you@example.com", hint: "email" };
  if (f === "numeric" || f === "digits" || f === "number") {
    return { inputMode: "numeric", transform: (v) => String(v).replace(/[^0-9]/g, ""), hint: "digits only" };
  }
  return { pattern: format, hint: `format: ${format}` };
}
