import { useEffect, useState } from "react";
import { shortUrl, submitVal, transformValue, generateSharedPasswords } from "../lib/format.js";
import { getLatest, subscribe } from "../lib/promptBridge.js";
import FieldRow from "../components/FieldRow.jsx";
import CardPicker from "../components/CardPicker.jsx";
import ProofImage from "../components/ProofImage.jsx";
import Countdown from "../components/Countdown.jsx";
import { Field } from "../components/Field.jsx";
import { DECLINE_PRESETS, DECLINE_REASON_MAX, normalizeDeclineReason } from "../../src/declinereason.js";

export default function PromptApp() {
  const [req, setReq] = useState(getLatest());
  const [values, setValues] = useState({}); // selector -> display value
  const [pickedCardId, setPickedCardId] = useState(null);
  const [scope, setScope] = useState("");
  const [saveScope, setSaveScope] = useState(""); // "" | "session" | "forever" | "forget"
  const [savedExisting, setSavedExisting] = useState(false); // a stored value was prefilled
  const [dontAsk, setDontAsk] = useState(false); // auto-fill silently next time
  const [declining, setDeclining] = useState(false); // the "why?" panel is open
  const [note, setNote] = useState(""); // free-text decline reason (plain text, never a secret)
  const [expired, setExpired] = useState(false); // the deadline passed — nothing left to answer

  useEffect(() => subscribe(setReq), []);

  // Main retires the request at its deadline too (and closes this window shortly after);
  // either side may notice first, so both flip the same state. See src/main.js expireRequest.
  useEffect(() => {
    try { window.keeper.onExpired?.(() => setExpired(true)); } catch { /* older preload */ }
  }, []);

  // Tell main the request is actually on screen. Main shows the window only on this
  // report and treats its absence as a render failure, so a prompt that cannot paint can
  // never masquerade as one waiting for the user (issue #3). Two animation frames = a
  // frame was committed; the timer is a fallback where rAF is throttled. Idempotent in main.
  useEffect(() => {
    if (!req) return;
    const ack = () => { try { window.keeper.rendered?.(req.request_id); } catch { /* ignore */ } };
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(ack); });
    const t = setTimeout(ack, 500);
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(t); };
  }, [req && req.request_id]);

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
    setDeclining(false);
    setNote("");
    setExpired(false);
    if (!req) return;
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
        // still switch to on-device or Don't save in the prompt.
        if (!hasGen) {
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
  }, [req && req.request_id]);

  // Main keeps the window hidden until a request is painted, so this state should never
  // be on screen — but if it ever is, it must SAY so rather than look like a dead window.
  if (!req) return (
    <>
      <div id="glow" />
      <p id="waiting">Waiting for the request…</p>
    </>
  );

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

  // The deadline passed while the prompt was open: tell main (it closes the window) and
  // stop offering to send — the service resolved this request as `timeout` and would drop
  // anything we sent now.
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
  // Decline. `reason` is optional plain text the agent gets to read, so it can pick its
  // next move instead of guessing between retrying and giving up (issue #11). Called with
  // nothing — the Cancel button, Escape, closing the window — it declines exactly as
  // before. Normalized here so a whitespace-only note is the same as no note at all.
  const cancel = (reason) => {
    const why = normalizeDeclineReason(reason);
    window.keeper.cancel(req.request_id, why || undefined);
    finish();
  };

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
              {/* Nothing is drawn when the frame carried no deadline — see Countdown. */}
              <Countdown expiresAt={req.expires_at} onExpire={onExpire} />
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
              // Regenerate the whole group, not just this row: a password and its
              // confirmation must stay identical or the form rejects the submit.
              onGenerate={() => setValues((m) => ({ ...m, ...generateSharedPasswords(fields) }))}
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
                  setDontAsk(v === "session" || v === "forever" || v === "vault");
                }}
              >
                {!savedExisting && <option value="">Don't save</option>}
                <option value="session">Until the Keeper restarts</option>
                <option value="forever">Save securely on this device</option>
                <option value="vault">Save to vault (synced across devices)</option>
                {savedExisting && <option value="forget">Forget saved value</option>}
              </select>
            </Field>
          )}
          {hasNonCard && (saveScope === "session" || saveScope === "forever" || saveScope === "vault") && (
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted2)", fontSize: 12.5, cursor: "pointer", marginTop: -6 }}
            >
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} style={{ width: 14, height: 14 }} />
              <span>Don't ask again — fill automatically next time</span>
            </label>
          )}
        </div>

        {expired ? (
          <p id="expired">
            This request expired — the service stopped waiting for it, so nothing was sent.
            Ask the agent to request the fill again.
          </p>
        ) : (
          <p id="note">Sent to the service and typed into the form for you. Never shown to the AI model.</p>
        )}

        {/* Why the request is being declined — opened in place from the ▾ beside Cancel, so
            saying "wrong account" costs one extra tap and no navigation. Each preset
            declines on its own click; the input is for anything the presets don't cover.
            Gone once expired: the service already resolved the request as `timeout`, so a
            reason would have nowhere to go — offering to explain a decline that cannot be
            delivered is the same dead prompt in another shape. */}
        {declining && !expired && (
          <div id="decline">
            <div id="presets">
              {DECLINE_PRESETS.map((p) => (
                <button key={p} type="button" className="preset" onClick={() => cancel(p)}>{p}</button>
              ))}
            </div>
            <span className="inrow">
              <input
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
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); cancel(note); }
                  else if (e.key === "Escape") { e.preventDefault(); setDeclining(false); }
                }}
              />
              <button id="declinesend" type="button" onClick={() => cancel(note)}>Decline</button>
            </span>
            <p className="hint">Goes to the AI as ordinary text, so it can decide what to do next — never put a password here.</p>
          </div>
        )}

        <div id="actions">
          <span id="declinegroup">
            <button id="cancel" type="button" onClick={() => cancel()}>{expired ? "Close" : "Cancel"}</button>
            {/* The ▾ goes with Send once expired: there is no decline left to explain. */}
            {!expired && (
              <button
                id="why"
                type="button"
                aria-expanded={declining}
                aria-label="Decline with a reason"
                title="Decline with a reason"
                onClick={() => setDeclining((v) => !v)}
              >
                ▾
              </button>
            )}
          </span>
          {/* Removed rather than disabled once expired: a Send that quietly does nothing is
              exactly the dead prompt this is meant to get rid of. */}
          {!expired && <button id="send" type="button" onClick={send}>Send</button>}
        </div>
      </main>
    </>
  );
}
