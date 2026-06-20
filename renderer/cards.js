// Cards window: view/add/edit/delete saved cards in cards.json. The in-memory
// `store` mirrors the file; edits commit live and "Save" persists the whole store.
let store = { autofill: true, default: "", cards: {} };
let currentId = null;

const $ = (id) => document.getElementById(id);
const BILLING = {
  f_b_line1: "address_line1", f_b_line2: "address_line2", f_b_city: "city",
  f_b_zip: "zip", f_b_state: "state", f_b_country: "country",
};

function cardIds() { return Object.keys(store.cards || {}); }

function renderSelect() {
  const sel = $("cardSel");
  sel.replaceChildren();
  for (const id of cardIds()) {
    const o = document.createElement("option");
    o.value = id; o.textContent = id + (store.default === id ? "  (default)" : "");
    sel.appendChild(o);
  }
  if (currentId) sel.value = currentId;
  const none = cardIds().length === 0;
  $("empty").hidden = !none;
  $("form").style.display = none ? "none" : "flex";
  $("delCard").disabled = none;
}

function loadCardIntoForm(id) {
  currentId = id;
  const c = (store.cards || {})[id] || {};
  $("f_id").value = id || "";
  $("f_holder").value = c.holder || "";
  $("f_number").value = c.number || "";
  $("f_cvv").value = c.cvv || "";
  $("f_month").value = c.exp_month || "";
  $("f_year").value = c.exp_year || "";
  const b = c.billing || {};
  for (const [el, key] of Object.entries(BILLING)) $(el).value = b[key] || "";
  $("f_default").checked = store.default === id;
}

// Read the form into the in-memory store (handles rename via the id field).
function commitForm() {
  if (currentId == null) return;
  let newId = ($("f_id").value || "").trim() || currentId;
  const billing = {};
  for (const [el, key] of Object.entries(BILLING)) billing[key] = $(el).value;
  const card = {
    holder: $("f_holder").value,
    number: $("f_number").value,
    cvv: $("f_cvv").value,
    exp_month: $("f_month").value,
    exp_year: $("f_year").value,
    billing,
  };
  if (newId !== currentId) {
    delete store.cards[currentId];
    if (store.default === currentId) store.default = newId;
    currentId = newId;
  }
  store.cards[currentId] = card;
  if ($("f_default").checked) store.default = currentId;
  else if (store.default === currentId) store.default = "";
}

function uniqueId() {
  let n = 1, id = "card";
  while (store.cards[id]) { n += 1; id = "card" + n; }
  return id;
}

function setStatus(msg, kind) {
  const s = $("status");
  s.textContent = msg; s.className = kind || "";
}

// ---- wiring ----
for (const el of document.querySelectorAll("#form input")) {
  el.addEventListener("input", () => { commitForm(); renderSelect(); setStatus("Unsaved changes"); });
}
$("autofill").addEventListener("change", () => { store.autofill = $("autofill").checked; setStatus("Unsaved changes"); });

$("cardSel").addEventListener("change", () => {
  commitForm();
  loadCardIntoForm($("cardSel").value);
  renderSelect();
});
$("newCard").addEventListener("click", () => {
  commitForm();
  const id = uniqueId();
  store.cards[id] = { billing: {} };
  if (!store.default) store.default = id;
  currentId = id;
  renderSelect();
  loadCardIntoForm(id);
  $("f_id").focus();
  setStatus("Unsaved changes");
});
$("delCard").addEventListener("click", () => {
  if (!currentId) return;
  delete store.cards[currentId];
  if (store.default === currentId) store.default = cardIds()[0] || "";
  currentId = cardIds()[0] || null;
  renderSelect();
  if (currentId) loadCardIntoForm(currentId);
  setStatus("Unsaved changes");
});
$("save").addEventListener("click", async () => {
  commitForm();
  try {
    const r = await window.keeperCards.save(store);
    if (r && r.ok) setStatus("Saved ✓", "ok");
    else setStatus("Error: " + ((r && r.error) || "save failed"), "err");
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  }
});
for (const btn of document.querySelectorAll(".reveal")) {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.for);
    input.type = input.type === "password" ? "text" : "password";
    input.focus();
  });
}

(async function init() {
  try {
    const loaded = await window.keeperCards.load();
    store = loaded && typeof loaded === "object" ? loaded : {};
  } catch { store = {}; }
  if (typeof store.autofill !== "boolean") store.autofill = true;
  if (!store.cards || typeof store.cards !== "object") store.cards = {};
  if (typeof store.default !== "string") store.default = "";
  $("autofill").checked = store.autofill !== false;
  currentId = store.default && store.cards[store.default] ? store.default : (cardIds()[0] || null);
  renderSelect();
  if (currentId) loadCardIntoForm(currentId);
})();
