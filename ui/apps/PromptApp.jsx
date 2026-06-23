import { useEffect, useState } from "react";
import { shortUrl, submitVal, transformValue } from "../lib/format.js";
import { getLatest, subscribe } from "../lib/promptBridge.js";
import FieldRow from "../components/FieldRow.jsx";
import CardPicker from "../components/CardPicker.jsx";
import ProofImage from "../components/ProofImage.jsx";

export default function PromptApp() {
  const [req, setReq] = useState(getLatest());
  const [values, setValues] = useState({}); // selector -> display value
  const [reveal, setReveal] = useState({}); // index -> bool
  const [pickedCardId, setPickedCardId] = useState(null);
  const [scope, setScope] = useState("");

  useEffect(() => subscribe(setReq), []);
  // Reset per request.
  useEffect(() => {
    setValues({});
    setReveal({});
    setPickedCardId(null);
    setScope("");
  }, [req && req.request_id]);

  if (!req) return <div id="glow" />;

  const fields = Array.isArray(req.fields) ? req.fields : [];
  const hasCard = fields.some((f) => String((f && f.field) || "").toLowerCase().startsWith("card-"));
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

  const send = () => {
    if (pickedCardId && scope === "all") { try { window.keeper.rememberCardAllSites(req.request_id, pickedCardId); } catch {} }
    else if (pickedCardId && scope === "site") { try { window.keeper.rememberCardDomain(req.request_id, pickedCardId); } catch {} }
    const out = fields.map((f) => ({ selector: f.selector, value: submitVal(f.field, values[f.selector] || "") }));
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
              revealed={!!reveal[i]}
              onToggleReveal={() => setReveal((r) => ({ ...r, [i]: !r[i] }))}
              onChange={(raw) => setValue(f, raw)}
              onSubmit={send}
              onCancel={cancel}
            />
          ))}
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
