import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Message, Panel, SelectPicker, Toggle } from "rsuite";
import CreditCardIcon from "@rsuite/icons/CreditCardPlus";
import { ActionMenu, PageBody, PageHeader } from "@f-proj/ui-components";
import { Field } from "../components/Field.jsx";

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
// A hostname (dot-separated labels, TLD of 2+ letters), optionally with a
// wildcard: "*" alone = every site, "*.pge.com" = pge.com + all subdomains.
// Still rejects spaces, schemes, mid-label globs (foo.*.com) and other junk.
function isValidDomain(d) {
  if (d === "*") return true;
  const bare = d.startsWith("*.") ? d.slice(2) : d;
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(bare);
}
function normalizeDomains(text) {
  return String(text || "")
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}
// Only valid hostnames are stored on the card.
function parseDomains(text) {
  return normalizeDomains(text).filter(isValidDomain);
}
// The entries that would be dropped — surfaced to the user so a save can be blocked.
function invalidDomains(text) {
  return normalizeDomains(text).filter((d) => !isValidDomain(d));
}
function uniqueId(cards) { let n = 1, id = "card"; while (cards[id]) { n += 1; id = "card" + n; } return id; }
const last4 = (num) => String(num || "").replace(/\D/g, "").slice(-4);

const BILLING = [
  ["address_line1", "Address line 1"], ["address_line2", "Address line 2"],
  ["city", "City"], ["zip", "ZIP / Postcode"], ["state", "State / Region"], ["country", "Country"],
];

export default function CardsPage() {
  const [store, setStore] = useState({ autofill: true, default: "", cards: {} });
  const [currentId, setCurrentId] = useState(null);
  const [status, setStatus] = useState({ msg: "", kind: "" });
  const [note, setNote] = useState(null); // { ok, text } — where the cards are stored
  const [domainsText, setDomainsText] = useState("");
  // A saved card's full number / CVV are never shown again — only the last 4 of the
  // number (as a hint) and a hidden CVV. These flags flip when the user types a
  // replacement; they reset on card switch and after save so the values re-hide.
  const [editNum, setEditNum] = useState(false);
  const [editCvv, setEditCvv] = useState(false);
  useEffect(() => { setEditNum(false); setEditCvv(false); }, [currentId]);

  // Load the store (again on Revert — there is no window to close any more).
  const load = async () => {
    let loaded = {};
    try { loaded = (await window.keeperCards.load()) || {}; } catch { loaded = {}; }
    if (typeof loaded.autofill !== "boolean") loaded.autofill = true;
    if (!loaded.cards || typeof loaded.cards !== "object") loaded.cards = {};
    if (typeof loaded.default !== "string") loaded.default = "";
    setStore(loaded);
    const ids = Object.keys(loaded.cards);
    setCurrentId(loaded.default && loaded.cards[loaded.default] ? loaded.default : (ids[0] || null));
    setStatus({ msg: "", kind: "" });
  };
  // Load store + storage note once.
  useEffect(() => {
    load();
    (async () => {
      let info = {};
      try { info = (await window.keeperCards.storageInfo()) || {}; } catch { /* ignore */ }
      if (info.encrypted) {
        const backend = info.platform === "darwin" ? "your macOS Keychain"
          : info.platform === "win32" ? "Windows DPAPI" : "your system keyring";
        setNote({ ok: true, text: `Encrypted at rest in ${backend}. Omit the CVV to be prompted for it instead.` });
      } else {
        setNote({ ok: false, text: "No OS secure storage available — saved in a plaintext file (chmod 600). Omit the CVV to be prompted for it instead." });
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
    const bad = invalidDomains(domainsText);
    if (bad.length) {
      setStatus({ msg: `Fix invalid auto-fill domain(s): ${bad.join(", ")}`, kind: "err" });
      return; // don't save until the domains are valid hostnames
    }
    try {
      const r = await window.keeperCards.save(store);
      if (r && r.ok) { setStatus({ msg: "Saved ✓", kind: "ok" }); setEditNum(false); setEditCvv(false); } // re-hide number/CVV
      else setStatus({ msg: "Error: " + ((r && r.error) || "save failed"), kind: "err" });
    } catch (e) {
      setStatus({ msg: "Error: " + e.message, kind: "err" });
    }
  };

  const none = ids.length === 0;
  const bad = invalidDomains(domainsText);
  // A select needs a value for "not chosen"; the card keeps "" as before.
  const pick = (v) => v || "";
  return (
    <>
      <PageHeader icon={<CreditCardIcon />} title="Cards" meta={`${ids.length} saved`}>
        <Button size="sm" onClick={newCard}>+ New</Button>
        <Button size="sm" appearance="primary" onClick={save}>Save</Button>
      </PageHeader>
      <PageBody>
        <div className="page-col">
          <p className="muted">Stored locally for unattended card fill. Card values stay on this machine and are never sent to the AI.</p>

          <Toggle checked={store.autofill !== false} onChange={(checked) => { setStore((s) => ({ ...s, autofill: checked })); dirty(); }}>
            Auto-fill card requests without prompting
          </Toggle>

          <div className="row">
            <SelectPicker
              aria-label="Select card"
              className="grow"
              searchable={false}
              cleanable={false}
              disabled={none}
              placeholder="No cards yet"
              data={ids.map((id) => {
                const l4 = last4(store.cards[id] && store.cards[id].number);
                return { value: id, label: id + (l4 ? `  ••••${l4}` : "") + (store.default === id ? "  (default)" : "") };
              })}
              value={currentId || null}
              onChange={(v) => v && setCurrentId(v)}
            />
            <ActionMenu
              actions={[{
                key: "delete", label: "Delete", color: "red", appearance: "ghost", size: "sm", disabled: none,
                confirm: { title: "Delete this card?", body: `The card "${currentId || ""}" is removed when you Save.` },
                onClick: delCard,
              }]}
            />
          </div>

          {none ? (
            <Message type="info" showIcon>No cards yet. Click <strong>+ New</strong> to add one.</Message>
          ) : (
            <Panel bordered>
              <form className="form" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
                <Field label="Name / id">
                  <Input type="text" placeholder="visa" value={currentId || ""} onChange={(v) => rename(v)} />
                </Field>
                <Checkbox checked={store.default === currentId} onChange={(_v, checked) => setDefault(checked)}>Use this card by default</Checkbox>
                <Field label="Auto-fill on these sites — one per line or comma-separated (silent, no prompt)"
                  hint="A domain also covers its subdomains (pge.com → account.pge.com). Wildcards ok: * = every site, *.amazon.com = amazon.com + subdomains.">
                  <Input as="textarea" rows={2} placeholder={"amazon.com\n*.example.com\n*"} value={domainsText}
                    onChange={(v) => { setDomainsText(v); patchCard({ domains: parseDomains(v) }); }} />
                  {bad.length > 0 && (
                    <span className="fld-hint err">Not valid: {bad.join(", ")} — won't be saved.</span>
                  )}
                </Field>
                <Field label="Cardholder">
                  <Input type="text" placeholder="JOHN Q DOE" value={card.holder || ""} onChange={(v) => patchCard({ holder: v })} />
                </Field>

                <Field label="Card number"
                  hint={!editNum && last4(card.number) ? `Saved card ending ${last4(card.number)} — type to replace` : undefined}>
                  <Input type="text" inputMode="numeric" maxLength={23} placeholder="#### #### #### ####"
                    value={editNum ? groupCardNumber(card.number) : ""}
                    onChange={(v) => { setEditNum(true); patchCard({ number: digitsOnly(v) }); }} />
                </Field>

                <div className="grid3">
                  <Field label="Exp month">
                    <SelectPicker block searchable={false} cleanable={false} placeholder="MM"
                      data={monthOpts().map((m) => ({ label: m, value: m }))}
                      value={pad2(card.exp_month) || null} onChange={(v) => patchCard({ exp_month: pick(v) })} />
                  </Field>
                  <Field label="Exp year">
                    <SelectPicker block searchable={false} cleanable={false} placeholder="YYYY"
                      data={yearOpts(card.exp_year).map((y) => ({ label: y, value: y }))}
                      value={card.exp_year ? String(card.exp_year) : null} onChange={(v) => patchCard({ exp_year: pick(v) })} />
                  </Field>
                  <Field label="CVV" hint={!editCvv && card.cvv ? "Saved — hidden; type to replace" : undefined}>
                    <Input type="password" inputMode="numeric" maxLength={4} autoComplete="off" placeholder="•••"
                      value={editCvv ? (card.cvv || "") : ""}
                      onChange={(v) => { setEditCvv(true); patchCard({ cvv: v }); }} />
                  </Field>
                </div>

                <fieldset className="billing">
                  <legend>Billing address</legend>
                  {BILLING.slice(0, 2).map(([key, label]) => (
                    <Field label={label} key={key}>
                      <Input type="text" value={billing[key] || ""} onChange={(v) => patchBilling(key, v)} />
                    </Field>
                  ))}
                  <div className="grid2">
                    {BILLING.slice(2, 4).map(([key, label]) => (
                      <Field label={label} key={key}>
                        <Input type="text" value={billing[key] || ""} onChange={(v) => patchBilling(key, v)} />
                      </Field>
                    ))}
                  </div>
                  <div className="grid2">
                    {BILLING.slice(4, 6).map(([key, label]) => (
                      <Field label={label} key={key}>
                        <Input type="text" placeholder={key === "country" ? "US" : undefined} value={billing[key] || ""} onChange={(v) => patchBilling(key, v)} />
                      </Field>
                    ))}
                  </div>
                </fieldset>
              </form>
            </Panel>
          )}

          {note && <Message type={note.ok ? "success" : "warning"} showIcon>{note.text}</Message>}

          <div className="actions">
            {status.msg && <span className={"status " + status.kind}>{status.msg}</span>}
            <Button onClick={load}>Revert</Button>
            <Button appearance="primary" onClick={save}>Save</Button>
          </div>
        </div>
      </PageBody>
    </>
  );
}
