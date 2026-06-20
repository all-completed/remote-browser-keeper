let currentId = null;
let inputs = []; // [{ selector, el }]
let pickedCardId = null;  // saved card chosen in the picker (for "remember this site")
let rememberEl = null;    // the "auto-fill on this site next time" checkbox

const $ = (id) => document.getElementById(id);
const fieldsEl = $("fields");
const sessionEl = $("session");
const urlEl = $("url");
const msgEl = $("message");
const proofEl = $("proof");
const proofImg = $("proofImg");

function shortUrl(u) {
  try {
    const x = new URL(u);
    const s = x.host + (x.pathname === "/" ? "" : x.pathname);
    return s.length > 56 ? s.slice(0, 55) + "…" : s;
  } catch {
    return u.length > 56 ? u.slice(0, 55) + "…" : u;
  }
}

function isSecret(field) {
  const f = String(field || "").toLowerCase();
  // Masked: password, code, card-number, card-cvv. Plain: text/login/email and
  // card-holder-name / card-exp / card-billing-address.
  return !(
    f === "text" || f === "login" || f === "email" ||
    f === "card-holder-name" || f === "card-exp" || f === "card-billing-address"
  );
}

// ---- Card formatting templates ----
// A template has slot chars (letters or '#') with literal separators (space, '/').
const CARD_NUMBER_DEFAULT = "################"; // 16 digits, no grouping
const CARD_EXP_DEFAULT = "MM/YY";

function templateSlots(t) {
  return (String(t).match(/[A-Za-z#]/g) || []).length;
}
function fillTemplate(template, raw) {
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
function cardNumberMask(format) {
  return format && format.indexOf("#") >= 0 ? format : CARD_NUMBER_DEFAULT;
}
function cardExpTemplate(format) {
  return format && /[MY]/i.test(format) ? format : CARD_EXP_DEFAULT;
}

const BILLING_TOKENS = {
  ADDRESS_LINE1: "address line 1", ADDRESS_LINE2: "address line 2",
  CITY: "city", ZIP: "ZIP", STATE: "state", COUNTRY: "country",
};
function humanizeBilling(format) {
  if (!format) return "";
  return String(format).split(",")
    .map((t) => BILLING_TOKENS[t.trim().toUpperCase()] || t.trim())
    .filter(Boolean).join(", ");
}

// Multi-line only for a whole billing address (no specific component format).
function isMultiline(field, format) {
  return String(field || "").toLowerCase() === "card-billing-address" && !(format && String(format).trim());
}

function cardMaxLen(field, format) {
  switch (String(field || "").toLowerCase()) {
    case "card-number": return cardNumberMask(format).length;
    case "card-exp": return cardExpTemplate(format).length;
    case "card-cvv": return 4;
    default: return 0;
  }
}

// Transform input for digit-grouped/MM-YY card fields; null = not such a field.
function formatCardInput(field, format, raw) {
  switch (String(field || "").toLowerCase()) {
    case "card-number": return fillTemplate(cardNumberMask(format), raw);
    case "card-exp": return fillTemplate(cardExpTemplate(format), raw);
    case "card-cvv": return String(raw).replace(/\D/g, "").slice(0, 4);
    default: return null;
  }
}

// Value to submit (card number is grouped for display; send digits only).
function submitVal(field, v) {
  return String(field || "").toLowerCase() === "card-number" ? String(v).replace(/\D/g, "") : v;
}

function cardHint(field, format) {
  switch (String(field || "").toLowerCase()) {
    case "card-number": return "card number · digits only";
    case "card-cvv": return "CVV";
    case "card-exp": return cardExpTemplate(format);
    case "card-holder-name": return "name on card";
    case "card-billing-address": return humanizeBilling(format) || "billing address";
    default: return "";
  }
}

function applyFormat(input, format) {
  if (!format) return "";
  const f = String(format).toLowerCase();
  if (f === "email") { input.placeholder = "you@example.com"; input.inputMode = "email"; return "email"; }
  if (f === "numeric" || f === "digits" || f === "number") {
    input.inputMode = "numeric";
    input.addEventListener("input", () => { input.value = input.value.replace(/[^0-9]/g, ""); });
    return "digits only";
  }
  // treat as a regex constraint
  try { input.pattern = format; } catch {}
  return `format: ${format}`;
}

function makeRow(field) {
  const wrap = document.createElement("div");
  wrap.className = "field";

  const label = document.createElement("label");
  label.className = "flabel";
  label.textContent = field.label || "Enter value";
  wrap.appendChild(label);

  const row = document.createElement("div");
  row.className = "inputRow";

  const kind = String(field.field || "").toLowerCase();
  const fmt = field.format;
  const multiline = isMultiline(kind, fmt);
  const secret = isSecret(kind);

  let input;
  if (multiline) {
    input = document.createElement("textarea");
    input.rows = 3;
    input.autocapitalize = "sentences";
  } else {
    input = document.createElement("input");
    input.type = secret ? "password" : "text";
    input.autocapitalize = kind === "card-holder-name" ? "words" : "off";
  }
  input.autocomplete = "off"; input.autocorrect = "off"; input.spellcheck = false;
  input.placeholder = "Type here…";

  const ml = (Number.isInteger(field.length) && field.length > 0) ? field.length : cardMaxLen(kind, fmt);
  if (ml) input.maxLength = ml;

  // Field-specific formatting + hint.
  let hintText = "";
  if (formatCardInput(kind, fmt, "") !== null) {
    // card-number / card-exp / card-cvv: live digit-grouping / MM-YY.
    input.inputMode = "numeric";
    input.addEventListener("input", () => { input.value = formatCardInput(kind, fmt, input.value); });
    hintText = cardHint(kind, fmt);
  } else if (kind.startsWith("card-")) {
    // card-holder-name / card-billing-address: no transform, just a hint.
    hintText = cardHint(kind, fmt);
  } else {
    hintText = applyFormat(input, field.format);
  }
  row.appendChild(input);

  if (secret && !multiline) {
    const reveal = document.createElement("button");
    reveal.type = "button"; reveal.className = "reveal"; reveal.title = "Show / hide";
    reveal.textContent = "👁";
    reveal.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      input.focus();
    });
    row.appendChild(reveal);
  }
  wrap.appendChild(row);

  const hints = [];
  if (hintText) hints.push(hintText);
  if (ml) hints.push(`max ${ml}`);
  if (hints.length) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = hints.join(" · ");
    wrap.appendChild(hint);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !multiline) { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });

  inputs.push({ selector: field.selector, el: input, field: kind });
  return wrap;
}

window.keeper.onRequest((req) => {
  currentId = req.request_id;
  inputs = [];
  pickedCardId = null;
  rememberEl = null;
  fieldsEl.replaceChildren();

  sessionEl.textContent = `session: ${req.session_id || "?"}`;
  if (req.url) { urlEl.textContent = shortUrl(req.url); urlEl.title = req.url; urlEl.hidden = false; }
  else urlEl.hidden = true;
  if (req.message) { msgEl.textContent = req.message; msgEl.hidden = false; } else msgEl.hidden = true;

  if (typeof req.screenshot === "string" && /^data:image\//.test(req.screenshot)) {
    proofImg.src = req.screenshot; proofEl.hidden = false;
  } else { proofImg.removeAttribute("src"); proofEl.hidden = true; }

  const fields = Array.isArray(req.fields) ? req.fields : [];
  const hasCard = fields.some((f) => String((f && f.field) || "").toLowerCase().startsWith("card-"));
  if (hasCard && Array.isArray(req.cards) && req.cards.length) {
    fieldsEl.appendChild(makeCardPicker(req));
  }
  for (const f of fields) fieldsEl.appendChild(makeRow(f));

  setTimeout(() => { if (inputs[0]) inputs[0].el.focus(); }, 0);
});

// "Use a saved card or fill manually" — picking a card pre-fills the card fields
// (via main; values stay local), which the user then reviews and sends.
function makeCardPicker(req) {
  const wrap = document.createElement("div");
  wrap.className = "field cardPicker";
  const label = document.createElement("label");
  label.className = "flabel";
  label.textContent = "Use a saved card";
  wrap.appendChild(label);

  const sel = document.createElement("select");
  sel.className = "cardSelect";
  const manual = document.createElement("option");
  manual.value = ""; manual.textContent = "— Fill manually —";
  sel.appendChild(manual);
  for (const c of req.cards) {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.id + (c.isDefault ? " (default)" : "");
    sel.appendChild(o);
  }
  wrap.appendChild(sel);

  // "Auto-fill on this site next time" — records the request's domain for the
  // chosen card so future requests from it fill silently. Shown once a card is picked.
  const remember = document.createElement("label");
  remember.className = "rememberRow";
  remember.hidden = true;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  const txt = document.createElement("span");
  txt.textContent = req.host ? `Auto-fill on ${req.host} next time` : "Auto-fill on this site next time";
  remember.appendChild(cb);
  remember.appendChild(txt);
  rememberEl = cb;
  wrap.appendChild(remember);

  sel.addEventListener("change", async () => {
    pickedCardId = sel.value || null;
    remember.hidden = !pickedCardId;
    if (!pickedCardId) return; // manual — leave fields as-is
    let values = [];
    try { values = await window.keeper.cardValues(req.request_id, pickedCardId); } catch {}
    for (const v of values || []) {
      const item = inputs.find((i) => i.selector === v.selector);
      if (item) {
        item.el.value = v.value;
        item.el.dispatchEvent(new Event("input", { bubbles: true })); // let the field re-format
      }
    }
  });
  return wrap;
}

function send() {
  if (!currentId) return;
  // Approve this site for the chosen card if "remember" is ticked (fire-and-forget).
  if (pickedCardId && rememberEl && rememberEl.checked) {
    try { window.keeper.rememberCardDomain(currentId, pickedCardId); } catch {}
  }
  const values = inputs.map((i) => ({ selector: i.selector, value: submitVal(i.field, i.el.value) }));
  window.keeper.submit(currentId, values);
  inputs.forEach((i) => { i.el.value = ""; }); // don't leave secrets in the DOM
  currentId = null;
}
function cancel() {
  if (currentId) window.keeper.cancel(currentId);
  inputs.forEach((i) => { i.el.value = ""; });
  currentId = null;
}

$("send").addEventListener("click", send);
$("cancel").addEventListener("click", cancel);

// Click the proof to open it at full / natural size in a separate window.
proofImg.addEventListener("click", () => {
  if (proofImg.src && /^data:image\//.test(proofImg.src)) window.keeper.viewImage(proofImg.src);
});
