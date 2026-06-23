import { useEffect, useState } from "react";
import { Field, RevealInput } from "../components/Field.jsx";

// ---- small helpers (ported from cards.js) ----
const digitsOnly = (v) => String(v == null ? "" : v).replace(/\D/g, "");
const groupCardNumber = (v) => digitsOnly(v).slice(0, 19).replace(/(.{4})/g, "$1 ").trim();
const pad2 = (v) => { const d = digitsOnly(v); return d ? d.padStart(2, "0").slice(-2) : ""; };
const monthOpts = () => Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
function yearOpts(selected) {
  const now = new Date().getFullYear();
  const ys = Array.from({ length: 13 }, (_, i) => String(now + i));
  if (selected && !ys.includes(String(selected))) ys.unshift(String(selected));
  return ys;
}
function parseDomains(text) {
  return String(text || "")
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}
function uniqueId(cards) { let n = 1, id = "card"; while (cards[id]) { n += 1; id = "card" + n; } return id; }

const BILLING = [
  ["address_line1", "Address line 1"], ["address_line2", "Address line 2"],
  ["city", "City"], ["zip", "ZIP / Postcode"], ["state", "State / Region"], ["country", "Country"],
];

export default function CardsApp() {
  const [store, setStore] = useState({ autofill: true, default: "", cards: {} });
  const [currentId, setCurrentId] = useState(null);
  const [status, setStatus] = useState({ msg: "", kind: "" });
  const [note, setNote] = useState("");
  const [domainsText, setDomainsText] = useState("");

  // Load store + storage note once.
  useEffect(() => {
    (async () => {
      let loaded = {};
      try { loaded = (await window.keeperCards.load()) || {}; } catch { loaded = {}; }
      if (typeof loaded.autofill !== "boolean") loaded.autofill = true;
      if (!loaded.cards || typeof loaded.cards !== "object") loaded.cards = {};
      if (typeof loaded.default !== "string") loaded.default = "";
      setStore(loaded);
      const ids = Object.keys(loaded.cards);
      setCurrentId(loaded.default && loaded.cards[loaded.default] ? loaded.default : (ids[0] || null));
    })();
    (async () => {
      let info = {};
      try { info = (await window.keeperCards.storageInfo()) || {}; } catch { /* ignore */ }
      if (info.encrypted) {
        const backend = info.platform === "darwin" ? "your macOS Keychain"
          : info.platform === "win32" ? "Windows DPAPI" : "your system keyring";
        setNote(`🔒 Encrypted at rest in ${backend}. Omit the CVV to be prompted for it instead.`);
      } else {
        setNote("⚠ No OS secure storage available — saved in a plaintext file (chmod 600). Omit the CVV to be prompted for it instead.");
      }
    })();
  }, []);

  const ids = Object.keys(store.cards || {});
  const card = (currentId && store.cards[currentId]) || {};
  const billing = card.billing || {};

  // Keep the domains text buffer in sync when switching cards.
  useEffect(() => { setDomainsText((Array.isArray(card.domains) ? card.domains : []).join("\n")); /* eslint-disable-next-line */ }, [currentId]);

  const dirty = () => setStatus({ msg: "Unsaved changes", kind: "" });
  const patchCard = (patch) => {
    setStore((s) => ({ ...s, cards: { ...s.cards, [currentId]: { ...s.cards[currentId], ...patch } } }));
    dirty();
  };
  const patchBilling = (key, v) => patchCard({ billing: { ...billing, [key]: v } });

  const rename = (raw) => {
    const newId = (raw || "").trim();
    setStore((s) => {
      if (!currentId) return s;
      const cards = { ...s.cards };
      const c = cards[currentId];
      const target = newId || currentId;
      if (target !== currentId) {
        delete cards[currentId];
        cards[target] = c;
      }
      const def = s.default === currentId ? target : s.default;
      return { ...s, cards, default: def };
    });
    if (newId && newId !== currentId) setCurrentId(newId);
    dirty();
  };

  const setDefault = (checked) => {
    setStore((s) => ({ ...s, default: checked ? currentId : (s.default === currentId ? "" : s.default) }));
    dirty();
  };

  const newCard = () => {
    setStore((s) => {
      const id = uniqueId(s.cards);
      const cards = { ...s.cards, [id]: { billing: {} } };
      const def = s.default || id;
      setTimeout(() => setCurrentId(id), 0);
      return { ...s, cards, default: def };
    });
    dirty();
  };
  const delCard = () => {
    setStore((s) => {
      const cards = { ...s.cards };
      delete cards[currentId];
      const rest = Object.keys(cards);
      const def = s.default === currentId ? (rest[0] || "") : s.default;
      setTimeout(() => setCurrentId(rest[0] || null), 0);
      return { ...s, cards, default: def };
    });
    dirty();
  };

  const save = async () => {
    try {
      const r = await window.keeperCards.save(store);
      if (r && r.ok) setStatus({ msg: "Saved ✓", kind: "ok" });
      else setStatus({ msg: "Error: " + ((r && r.error) || "save failed"), kind: "err" });
    } catch (e) {
      setStatus({ msg: "Error: " + e.message, kind: "err" });
    }
  };

  const none = ids.length === 0;
  return (
    <>
      <div id="glow" />
      <main id="wrap">
        <header id="head">
          <div id="title">Saved cards</div>
          <div id="sub">Stored locally for unattended card fill. Card values stay on this machine and are never sent to the AI.</div>
        </header>

        <label className="toggle">
          <input type="checkbox" checked={store.autofill !== false} onChange={(e) => { setStore((s) => ({ ...s, autofill: e.target.checked })); dirty(); }} />
          <span>Auto-fill card requests without prompting</span>
        </label>

        <div className="cardbar">
          <select id="cardSel" aria-label="Select card" value={currentId || ""} onChange={(e) => setCurrentId(e.target.value)}>
            {ids.map((id) => <option key={id} value={id}>{id + (store.default === id ? "  (default)" : "")}</option>)}
          </select>
          <button type="button" className="ghost" onClick={newCard}>+ New</button>
          <button type="button" className="ghost danger" disabled={none} onClick={delCard}>Delete</button>
        </div>

        {none ? (
          <p className="warn">No cards yet. Click <strong>+ New</strong> to add one.</p>
        ) : (
          <form id="form" autoComplete="off" style={{ display: "flex" }}>
            <Field label="Name / id">
              <input type="text" placeholder="visa" value={currentId || ""} onChange={(e) => rename(e.target.value)} />
            </Field>
            <label className="check"><input type="checkbox" checked={store.default === currentId} onChange={(e) => setDefault(e.target.checked)} /><span>Use this card by default</span></label>
            <Field label="Auto-fill on these sites — one per line (silent, no prompt)">
              <textarea rows={2} placeholder={"amazon.com\nshop.example.com"} value={domainsText}
                onChange={(e) => { setDomainsText(e.target.value); patchCard({ domains: parseDomains(e.target.value) }); }} />
            </Field>
            <Field label="Cardholder">
              <input type="text" placeholder="JOHN Q DOE" value={card.holder || ""} onChange={(e) => patchCard({ holder: e.target.value })} />
            </Field>

            <Field label="Card number">
              <input type="text" inputMode="numeric" maxLength={23} placeholder="#### #### #### ####"
                value={groupCardNumber(card.number)} onChange={(e) => patchCard({ number: digitsOnly(e.target.value) })} />
            </Field>

            <div className="grid3">
              <Field label="Exp month">
                <select value={pad2(card.exp_month)} onChange={(e) => patchCard({ exp_month: e.target.value })}>
                  <option value="">MM</option>
                  {monthOpts().map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
              <Field label="Exp year">
                <select value={card.exp_year || ""} onChange={(e) => patchCard({ exp_year: e.target.value })}>
                  <option value="">YYYY</option>
                  {yearOpts(card.exp_year).map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </Field>
              <Field label="CVV">
                <RevealInput secret inputMode="numeric" maxLength={4} placeholder="•••"
                  value={card.cvv || ""} onChange={(e) => patchCard({ cvv: e.target.value })} />
              </Field>
            </div>

            <fieldset className="billing">
              <legend>Billing address</legend>
              {BILLING.slice(0, 2).map(([key, label]) => (
                <Field label={label} key={key}>
                  <input type="text" value={billing[key] || ""} onChange={(e) => patchBilling(key, e.target.value)} />
                </Field>
              ))}
              <div className="grid2">
                {BILLING.slice(2, 4).map(([key, label]) => (
                  <Field label={label} key={key}>
                    <input type="text" value={billing[key] || ""} onChange={(e) => patchBilling(key, e.target.value)} />
                  </Field>
                ))}
              </div>
              <div className="grid2">
                {BILLING.slice(4, 6).map(([key, label]) => (
                  <Field label={label} key={key}>
                    <input type="text" placeholder={key === "country" ? "US" : undefined} value={billing[key] || ""} onChange={(e) => patchBilling(key, e.target.value)} />
                  </Field>
                ))}
              </div>
            </fieldset>
          </form>
        )}

        <p className="warn" id="storage-note">{note}</p>

        <footer id="foot">
          <span id="status" className={status.kind}>{status.msg}</span>
          <button type="button" className="ghost" onClick={() => window.close()}>Cancel</button>
          <button type="button" className="primary" onClick={save}>Save</button>
        </footer>
      </main>
    </>
  );
}
