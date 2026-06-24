import { useEffect, useState } from "react";
import { shortUrl, submitVal, transformValue, generatePassword } from "../lib/format.js";
import { getLatest, subscribe } from "../lib/promptBridge.js";
import FieldRow from "../components/FieldRow.jsx";
import CardPicker from "../components/CardPicker.jsx";
import ProofImage from "../components/ProofImage.jsx";
import { Field } from "../components/Field.jsx";

export default function PromptApp() {
  const [req, setReq] = useState(getLatest());
  const [values, setValues] = useState({}); // selector -> display value
  const [pickedCardId, setPickedCardId] = useState(null);
  const [scope, setScope] = useState("");
  const [saveScope, setSaveScope] = useState(""); // "" | "session" | "forever" | "forget"
  const [savedExisting, setSavedExisting] = useState(false); // a stored value was prefilled
  const [dontAsk, setDontAsk] = useState(false); // auto-fill silently next time

  useEffect(() => subscribe(setReq), []);

  // Report content height to main so the window fits exactly (no empty space /
  // clipping). Re-reports as content changes (proof image loads, picker expands).
  useEffect(() => {
    const report = () => {
      try { window.keeper.resize(document.documentElement.scrollHeight); } catch { /* ignore */ }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, []);

  // Reset per request, then prefill any values the user previously saved.
  useEffect(() => {
    setValues({});
    setPickedCardId(null);
    setScope("");
    setSaveScope("");
    setSavedExisting(false);
    setDontAsk(false);
    if (!req) return;
    const reqFields = Array.isArray(req.fields) ? req.fields : [];
    // Generate a fresh strong value for any generate-field, and default to saving it.
    const genInit = {};
    let hasGen = false;
    for (const f of reqFields) {
      if (f && f.generate) { genInit[f.selector] = generatePassword(f); hasGen = true; }
    }
    if (hasGen) {
      setValues((m) => ({ ...m, ...genInit }));
      setSaveScope("forever");
      setDontAsk(true);
    }
    let cancelled = false;
    (async () => {
      let saved = [];
      try { saved = await window.keeper.savedValues(req.request_id); } catch { /* ignore */ }
      if (cancelled || !Array.isArray(saved) || !saved.length) return;
      setValues((m) => {
        const next = { ...m };
        for (const v of saved) {
          const f = reqFields.find((x) => x.selector === v.selector);
          if (f && !f.generate) next[v.selector] = transformValue(f, v.value); // keep generated values
        }
        return next;
      });
      // Reflect the saved state: default the control to the stored scope and offer
      // to forget it (rather than misleadingly showing "Don't save").
      setSavedExisting(true);
      setSaveScope(saved[0].scope || "");
      setDontAsk(!!saved[0].auto);
    })();
    return () => { cancelled = true; };
  }, [req && req.request_id]);

  if (!req) return <div id="glow" />;

  const fields = Array.isArray(req.fields) ? req.fields : [];
  const hasCard = fields.some((f) => String((f && f.field) || "").toLowerCase().startsWith("card-"));
  const hasNonCard = fields.some((f) => !String((f && f.field) || "").toLowerCase().startsWith("card-"));
  const showPicker = hasCard && Array.isArray(req.cards) && req.cards.length > 0;

  const setValue = (field, raw) => {
    const v = transformValue(field, raw);
    setValues((m) => ({ ...m, [field.selector]: v }));
  };

  const pickCard = async (cardId) => {
    setPickedCardId(cardId);
    setScope("");
    if (!cardId) return;
    let vals = [];
    try { vals = await window.keeper.cardValues(req.request_id, cardId); } catch { /* ignore */ }
    setValues((m) => {
      const next = { ...m };
      for (const v of vals || []) {
        const f = fields.find((x) => x.selector === v.selector);
        if (f) next[v.selector] = transformValue(f, v.value);
      }
      return next;
    });
  };

  const finish = () => setReq(null); // hide; main treats window-close as cancel only if no response sent

  const send = async () => {
    if (pickedCardId && scope === "all") { try { window.keeper.rememberCardAllSites(req.request_id, pickedCardId); } catch {} }
    else if (pickedCardId && scope === "site") { try { window.keeper.rememberCardDomain(req.request_id, pickedCardId); } catch {} }
    const out = fields.map((f) => ({ selector: f.selector, value: submitVal(f.field, values[f.selector] || "") }));
    // Save to secure storage (until restart / forever) before responding, while
    // the pending request still exists in main. Card fields belong in cards.json.
    if (saveScope) {
      const saveOut = fields
        .filter((f) => !String((f && f.field) || "").toLowerCase().startsWith("card-"))
        .map((f) => ({ selector: f.selector, value: submitVal(f.field, values[f.selector] || "") }));
      try { await window.keeper.saveFields(req.request_id, saveOut, saveScope, dontAsk); } catch {}
    }
    window.keeper.submit(req.request_id, out);
    finish();
  };
  const cancel = () => { window.keeper.cancel(req.request_id); finish(); };

  return (
    <>
      <div id="glow" />
      <main id="card">
        <header id="head">
          <div id="headtext">
            <div id="title">A remote session needs a value</div>
            <div id="meta">
              <span id="session" className="chip">session: {req.session_id || "?"}</span>
              {req.url && <span className="chip url" title={req.url}>{shortUrl(req.url)}</span>}
            </div>
          </div>
        </header>

        {req.message && <p id="message">{req.message}</p>}
        <ProofImage src={req.screenshot} />

        <div id="fields">
          {showPicker && (
            <CardPicker req={req} pickedCardId={pickedCardId} onPick={pickCard} scope={scope} onScope={setScope} />
          )}
          {fields.map((f, i) => (
            <FieldRow
              key={f.selector + i}
              field={f}
              value={values[f.selector] || ""}
              onChange={(raw) => setValue(f, raw)}
              onGenerate={(field) => setValues((m) => ({ ...m, [field.selector]: generatePassword(field) }))}
              onSubmit={send}
              onCancel={cancel}
            />
          ))}
          {hasNonCard && (
            <Field label={savedExisting ? "Saved value" : "Save these values"}>
              <select
                value={saveScope}
                onChange={(e) => {
                  const v = e.target.value;
                  setSaveScope(v);
                  // Default "don't ask again" on when a save scope is chosen.
                  setDontAsk(v === "session" || v === "forever");
                }}
              >
                {!savedExisting && <option value="">Don't save</option>}
                <option value="session">Until the Keeper restarts</option>
                <option value="forever">Save securely (until I remove it)</option>
                {savedExisting && <option value="forget">Forget saved value</option>}
              </select>
            </Field>
          )}
          {hasNonCard && (saveScope === "session" || saveScope === "forever") && (
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted2)", fontSize: 12.5, cursor: "pointer", marginTop: -6 }}
            >
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} style={{ width: 14, height: 14 }} />
              <span>Don't ask again — fill automatically next time</span>
            </label>
          )}
        </div>

        <p id="note">Sent to the service and typed into the form for you. Never shown to the AI model.</p>
        <div id="actions">
          <button id="cancel" type="button" onClick={cancel}>Cancel</button>
          <button id="send" type="button" onClick={send}>Send</button>
        </div>
      </main>
    </>
  );
}
