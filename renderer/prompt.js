let currentId = null;
let inputs = []; // [{ selector, el }]

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
  return !(field === "text" || field === "login" || field === "email");
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
  const input = document.createElement("input");
  input.type = isSecret(field.field) ? "password" : "text";
  input.autocomplete = "off"; input.autocorrect = "off";
  input.autocapitalize = "off"; input.spellcheck = false;
  input.placeholder = "Type here…";
  if (Number.isInteger(field.length) && field.length > 0) input.maxLength = field.length;
  const hintText = applyFormat(input, field.format);
  row.appendChild(input);

  const reveal = document.createElement("button");
  reveal.type = "button"; reveal.className = "reveal"; reveal.title = "Show / hide";
  reveal.textContent = "👁";
  reveal.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    input.focus();
  });
  row.appendChild(reveal);
  wrap.appendChild(row);

  const hints = [];
  if (hintText) hints.push(hintText);
  if (Number.isInteger(field.length) && field.length > 0) hints.push(`max ${field.length}`);
  if (hints.length) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = hints.join(" · ");
    wrap.appendChild(hint);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });

  inputs.push({ selector: field.selector, el: input });
  return wrap;
}

window.keeper.onRequest((req) => {
  currentId = req.request_id;
  inputs = [];
  fieldsEl.replaceChildren();

  sessionEl.textContent = `session: ${req.session_id || "?"}`;
  if (req.url) { urlEl.textContent = shortUrl(req.url); urlEl.title = req.url; urlEl.hidden = false; }
  else urlEl.hidden = true;
  if (req.message) { msgEl.textContent = req.message; msgEl.hidden = false; } else msgEl.hidden = true;

  if (typeof req.screenshot === "string" && /^data:image\//.test(req.screenshot)) {
    proofImg.src = req.screenshot; proofEl.hidden = false;
  } else { proofImg.removeAttribute("src"); proofEl.hidden = true; }

  const fields = Array.isArray(req.fields) ? req.fields : [];
  for (const f of fields) fieldsEl.appendChild(makeRow(f));

  setTimeout(() => { if (inputs[0]) inputs[0].el.focus(); }, 0);
});

function send() {
  if (!currentId) return;
  const values = inputs.map((i) => ({ selector: i.selector, value: i.el.value }));
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
