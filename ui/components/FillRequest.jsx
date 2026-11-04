import { useEffect, useState } from "react";
import { Button, ButtonGroup, Checkbox, Input, Message, Panel, SelectPicker, Tag } from "rsuite";
import { shortUrl, submitVal, transformValue, generateSharedPasswords } from "../lib/format.js";
import { clear, isExpired, subscribeExpired } from "../lib/promptBridge.js";
import FieldRow from "./FieldRow.jsx";
import CardPicker from "./CardPicker.jsx";
import ProofImage from "./ProofImage.jsx";
import Countdown from "./Countdown.jsx";
import { Field } from "./Field.jsx";
import { DECLINE_PRESETS, DECLINE_REASON_MAX, normalizeDeclineReason } from "../../src/declinereason.js";
import { isOneTimeCode } from "../../src/onetimecode.js";

const isCardField = (f) => String((f && f.field) || "").toLowerCase().startsWith("card-");
// Card fields belong in the vault's cards; one-time codes are never saved (issue #24).
const isSavableField = (f) => !isCardField(f) && !isOneTimeCode(f);
const NO_SAVE = "none"; // SelectPicker has no "empty" option of its own; "" in state

// A fill request waiting for the user — the body of the approval window (issue #34), as it
// was of the prompt window before issue #28 and of the Approvals page between the two.
export default function FillRequest({ req }) {
  const [values, setValues] = useState({}); // selector -> display value
  const [pickedCardId, setPickedCardId] = useState(null);
  const [scope, setScope] = useState("");
  const [saveScope, setSaveScope] = useState(""); // "" | "session" | "forever" | "vault" | "forget"
  const [savedExisting, setSavedExisting] = useState(false); // a stored value was prefilled
  const [dontAsk, setDontAsk] = useState(false); // auto-fill silently next time
  const [declining, setDeclining] = useState(false); // the "why?" panel is open
  const [note, setNote] = useState(""); // free-text decline reason (plain text, never a secret)
  const [expired, setExpired] = useState(() => isExpired(req.request_id)); // nothing left to answer

  // Main retires the request at its deadline too (and drops it from the page shortly
  // after); either side may notice first, so both flip the same state. See expireRequest.
  useEffect(() => subscribeExpired((id) => { if (id === req.request_id) setExpired(true); }), [req.request_id]);

  // Tell main the request is actually on screen. Main shows the approval window only on
  // this report and treats its absence as a render failure, so a prompt that cannot paint
  // can never masquerade as one waiting for the user (issue #3). Two animation frames = a
  // frame was committed; the timer is a fallback where rAF is throttled. Idempotent in main.
  useEffect(() => {
    const ack = () => { try { window.keeper.rendered?.(req.request_id); } catch { /* ignore */ } };
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(ack); });
    const t = setTimeout(ack, 500);
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(t); };
  }, [req.request_id]);

  // Fresh per request (the component is keyed by request_id), then prefill any values the
  // user previously saved.
  useEffect(() => {
    const reqFields = Array.isArray(req.fields) ? req.fields : [];
    // Generate a fresh strong value for any generate-field, and default to saving it.
    // Shared per kind, so a "Confirm password" field gets the SAME value as the
    // password it confirms (otherwise the form rejects every submission).
    const genInit = generateSharedPasswords(reqFields);
    const hasGen = Object.keys(genInit).length > 0;
    if (hasGen) {
      setValues((m) => ({ ...m, ...genInit }));
      setDontAsk(true);
      // A generated password is never shown to the user, so it should be backed up and
      // available on their other devices: default to the synced vault when a vault key is
      // held, otherwise on-device ("forever").
      setSaveScope("forever");
      window.keeper.vaultStatus?.().then((s) => { if (s && s.ok && s.hasKey) setSaveScope("vault"); }).catch(() => {});
    }
    let cancelled = false;
    (async () => {
      let saved = [];
      try { saved = await window.keeper.savedValues(req.request_id); } catch { /* ignore */ }
      if (cancelled) return;
      if (!Array.isArray(saved) || !saved.length) {
        // No previously-saved value: default a (non-generate) field to the synced vault
        // when a vault key is held — generate is already defaulted above. The user can
        // still switch to on-device or Don't save. Not when nothing here can be saved (a
        // codes-only request): that stays "Don't save".
        if (!hasGen && reqFields.some(isSavableField)) {
          try { const s = await window.keeper.vaultStatus?.(); if (!cancelled && s && s.ok && s.hasKey) { setSaveScope("vault"); setDontAsk(true); } } catch { /* ignore */ }
        }
        return;
      }
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
  }, [req.request_id]);

  const fields = Array.isArray(req.fields) ? req.fields : [];
  const hasCard = fields.some(isCardField);
  // The save control is only for fields that can be saved: a request of one-time codes
  // (or cards) has none, so it gets no "Save these values" at all.
  const hasSavable = fields.some(isSavableField);
  const hasCode = fields.some(isOneTimeCode);
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

  // The answer is on its way: take the request off the window. (Main moves the queue on —
  // the next request comes up in the same window — or closes the window when nothing waits.)
  const finish = () => clear(req.request_id);

  // The deadline passed while the prompt was open: tell main and stop offering to send —
  // the service resolved this request as `timeout` and would drop anything we sent now.
  const onExpire = () => {
    setExpired(true);
    try { window.keeper.reportExpired?.(req.request_id); } catch { /* older preload */ }
  };

  const send = async () => {
    if (expired) return; // also guards Enter-to-submit from a field row
    if (pickedCardId && scope === "all") { try { window.keeper.rememberCardAllSites(req.request_id, pickedCardId); } catch {} }
    else if (pickedCardId && scope === "site") { try { window.keeper.rememberCardDomain(req.request_id, pickedCardId); } catch {} }
    const out = fields.map((f) => ({ selector: f.selector, value: submitVal(f.field, values[f.selector] || "") }));
    // Save to secure storage (until restart / forever) before responding, while
    // the pending request still exists in main. Card fields belong in the vault's cards;
    // one-time codes are never saved (main drops them too, whatever is sent).
    if (saveScope && hasSavable) {
      const saveOut = fields
        .filter(isSavableField)
        .map((f) => ({ selector: f.selector, value: submitVal(f.field, values[f.selector] || "") }));
      try { await window.keeper.saveFields(req.request_id, saveOut, saveScope, dontAsk); } catch {}
    }
    window.keeper.submit(req.request_id, out);
    finish();
  };
  // Decline. `reason` is optional plain text the agent gets to read, so it can pick its
  // next move instead of guessing between retrying and giving up (issue #11). Called with
  // nothing — the Cancel button, Escape — it declines exactly as before (closing the
  // approval window does too: main declines the request on screen). Normalized here so a
  // whitespace-only note is the same as no note at all.
  const cancel = (reason) => {
    const why = normalizeDeclineReason(reason);
    window.keeper.cancel(req.request_id, why || undefined);
    finish();
  };

  const saveData = [
    ...(!savedExisting ? [{ label: "Don't save", value: NO_SAVE }] : []),
    { label: "Until the Keeper restarts", value: "session" },
    { label: "Save securely on this device", value: "forever" },
    { label: "Save to vault (synced across devices)", value: "vault" },
    ...(savedExisting ? [{ label: "Forget saved value", value: "forget" }] : []),
  ];

  return (
    <Panel bordered className="request" header={
      <div className="request-head">
        <div className="request-title">A remote session needs a value</div>
        <div className="chips">
          <Tag size="sm" className="mono">session: {req.session_id || "?"}</Tag>
          {req.url && <Tag size="sm" title={req.url}>{shortUrl(req.url)}</Tag>}
          {/* Nothing is drawn when the frame carried no deadline — see Countdown. */}
          <Countdown expiresAt={req.expires_at} onExpire={onExpire} />
        </div>
      </div>
    }>
      {req.message && <p className="request-message">{req.message}</p>}
      <ProofImage src={req.screenshot} />

      <div className="fields">
        {showPicker && (
          <CardPicker req={req} pickedCardId={pickedCardId} onPick={pickCard} scope={scope} onScope={setScope} />
        )}
        {fields.map((f, i) => (
          <FieldRow
            key={f.selector + i}
            field={f}
            value={values[f.selector] || ""}
            onChange={(raw) => setValue(f, raw)}
            // Regenerate the whole group, not just this row: a password and its
            // confirmation must stay identical or the form rejects the submit.
            onGenerate={() => setValues((m) => ({ ...m, ...generateSharedPasswords(fields) }))}
            onSubmit={send}
            onCancel={cancel}
          />
        ))}
        {hasSavable && (
          <Field
            label={savedExisting ? "Saved value" : "Save these values"}
            hint={hasCode ? "One-time codes are never saved" : undefined}
          >
            <SelectPicker
              block
              searchable={false}
              cleanable={false}
              data={saveData}
              value={saveScope || NO_SAVE}
              onChange={(raw) => {
                const v = raw === NO_SAVE ? "" : (raw || "");
                setSaveScope(v);
                // Default "don't ask again" on when a save scope is chosen.
                setDontAsk(v === "session" || v === "forever" || v === "vault");
              }}
            />
          </Field>
        )}
        {hasSavable && (saveScope === "session" || saveScope === "forever" || saveScope === "vault") && (
          <Checkbox checked={dontAsk} onChange={(_v, checked) => setDontAsk(checked)}>
            Don't ask again — fill automatically next time
          </Checkbox>
        )}
      </div>

      {expired ? (
        <Message type="warning" showIcon className="request-note">
          This request expired — the service stopped waiting for it, so nothing was sent.
          Ask the agent to request the fill again.
        </Message>
      ) : (
        <p className="request-note muted">Sent to the service and typed into the form for you. Never shown to the AI model.</p>
      )}

      {/* Why the request is being declined — opened in place from the ▾ beside Cancel, so
          saying "wrong account" costs one extra tap and no navigation. Each preset
          declines on its own click; the input is for anything the presets don't cover.
          Gone once expired: the service already resolved the request as `timeout`, so a
          reason would have nowhere to go. */}
      {declining && !expired && (
        <div className="decline">
          <div className="presets">
            {DECLINE_PRESETS.map((p) => (
              <Button key={p} size="sm" appearance="ghost" onClick={() => cancel(p)}>{p}</Button>
            ))}
          </div>
          <div className="decline-row">
            <Input
              id="declinenote"
              type="text"
              value={note}
              maxLength={DECLINE_REASON_MAX}
              placeholder="…or say why in your own words"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="sentences"
              spellCheck={false}
              onChange={(v) => setNote(v)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); cancel(note); }
                else if (e.key === "Escape") { e.preventDefault(); setDeclining(false); }
              }}
            />
            <Button onClick={() => cancel(note)}>Decline</Button>
          </div>
          <p className="fld-hint">Goes to the AI as ordinary text, so it can decide what to do next — never put a password here.</p>
        </div>
      )}

      <div className="actions">
        <ButtonGroup>
          <Button onClick={() => cancel()}>{expired ? "Close" : "Cancel"}</Button>
          {/* The ▾ goes with Send once expired: there is no decline left to explain. */}
          {!expired && (
            <Button
              aria-expanded={declining}
              aria-label="Decline with a reason"
              title="Decline with a reason"
              onClick={() => setDeclining((v) => !v)}
            >
              ▾
            </Button>
          )}
        </ButtonGroup>
        {/* Removed rather than disabled once expired: a Send that quietly does nothing is
            exactly the dead prompt this is meant to get rid of. */}
        {!expired && <Button appearance="primary" onClick={send}>Send</Button>}
      </div>
    </Panel>
  );
}
