import { useEffect, useState } from "react";
import { Button, ButtonGroup, Checkbox, Input, Message, Panel, SelectPicker, Tag } from "rsuite";
import NoticeIcon from "@rsuite/icons/Notice";
import { PageBody, PageHeader } from "@f-proj/ui-components";
import { shortUrl, submitVal, transformValue, generateSharedPasswords } from "../lib/format.js";
import { clear, getLatest, isExpired, subscribe, subscribeExpired } from "../lib/promptBridge.js";
import { subscribeUnlock } from "../lib/unlockBridge.js";
import { dismiss } from "../lib/statusBridge.js";
import FieldRow from "../components/FieldRow.jsx";
import CardPicker from "../components/CardPicker.jsx";
import ProofImage from "../components/ProofImage.jsx";
import Countdown from "../components/Countdown.jsx";
import { Field } from "../components/Field.jsx";
import { DECLINE_PRESETS, DECLINE_REASON_MAX, normalizeDeclineReason } from "../../src/declinereason.js";
import { isOneTimeCode } from "../../src/onetimecode.js";

const isCardField = (f) => String((f && f.field) || "").toLowerCase().startsWith("card-");
// Card fields belong in the vault's cards; one-time codes are never saved (issue #24).
const isSavableField = (f) => !isCardField(f) && !isOneTimeCode(f);
const NO_SAVE = "none"; // SelectPicker has no "empty" option of its own; "" in state

// ---------- A fill request (the former prompt window) ----------
function FillRequest({ req, active }) {
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

  // Tell main the request is actually on screen. Main shows a window the request brought
  // up only on this report and treats its absence as a render failure, so a prompt that
  // cannot paint can never masquerade as one waiting for the user (issue #3). Two
  // animation frames = a frame was committed; the timer is a fallback where rAF is
  // throttled. Only while this page is the one shown. Idempotent in main.
  useEffect(() => {
    if (!active) return;
    const ack = () => { try { window.keeper.rendered?.(req.request_id); } catch { /* ignore */ } };
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(ack); });
    const t = setTimeout(ack, 500);
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(t); };
  }, [req.request_id, active]);

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

  // The answer is on its way: take the request off the page. (Main moves the queue on and,
  // if a request is what brought the window up, puts the window away again.)
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
  // window does too: main declines the request on screen). Normalized here so a
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

// ---------- A headless Keeper asking for the vault key (the former unlock window) ----------
// A headless Keeper the user pinned has booted and asks for the vault key
// (rbkeeper-unlock-v1). Approve seals the key to that boot only; Deny refuses. Nothing is
// ever approved automatically. The code lets the user compare against what the daemon
// printed on its console for this boot.
const fmtTime = (ms) => new Date(ms).toLocaleString();

function UnlockRequest({ req, busy, msg, onAnswer, now }) {
  const left = Math.max(0, Math.round((req.expires_at - now) / 1000));
  return (
    <Panel bordered className="request" header={
      <div className="request-head">
        <div className="request-title">{req.name} Keeper restarted</div>
        <div className="request-sub">at {fmtTime(req.restarted_at)} — it is asking for the vault key.</div>
      </div>
    }>
      <div className="unlock-code">
        <div className="muted small">Code — it must match the one the Keeper printed</div>
        <div className="unlock-code-value mono">{req.code}</div>
        <div className="muted small mono wrap">{req.headless_id} · boot {req.boot_id}</div>
      </div>
      <div className="actions">
        <Button color="red" appearance="primary" onClick={() => onAnswer(false)} disabled={busy}>Deny</Button>
        <Button appearance="primary" onClick={() => onAnswer(true)} disabled={busy} loading={busy}>Approve</Button>
      </div>
      {msg && <Message type="error" showIcon className="request-note">{msg}</Message>}
      <p className="request-note muted small">
        Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
        {req.waiting > 1 ? ` · ${req.waiting - 1} more waiting` : ""}. If you didn't restart it, Deny.
      </p>
    </Panel>
  );
}

function useUnlock() {
  const [req, setReq] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [now, setNow] = useState(Date.now());
  const refresh = async () => {
    let r = null;
    try { r = await window.keeperUnlock.get(); } catch { r = null; }
    setReq((prev) => {
      if (!prev || !r || prev.request_id !== r.request_id) setMsg(null);
      return r;
    });
  };
  useEffect(() => {
    refresh();
    const off = subscribeUnlock(refresh);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { off(); clearInterval(t); };
  }, []);
  const answer = async (approve) => {
    if (!req || busy) return;
    setBusy(true); setMsg(null);
    let r;
    try { r = await (approve ? window.keeperUnlock.approve(req.request_id) : window.keeperUnlock.deny(req.request_id)); }
    catch (e) { r = { ok: false, error: e.message }; }
    setBusy(false);
    if (!r || !r.ok) setMsg((r && r.error) || "Failed.");
    // On success main moves on to the next request (unlock:changed).
  };
  return { req, busy, msg, now, answer };
}

// The warnings the tray shows, here as well — the Approvals page is where the user looks
// when something they answered did not go through.
function Warnings({ status, go }) {
  if (!status) return null;
  return (
    <>
      {status.promptFailure && (
        <Message type="error" showIcon closable onClose={() => dismiss("promptFailure")} header="An approval failed to show">
          A request could not be put on screen ({status.promptFailure.reason}), so the service was told the Keeper's
          approval UI failed. Ask the agent to try again.
        </Message>
      )}
      {status.undelivered && (
        <Message type="error" showIcon closable onClose={() => dismiss("undelivered")} header="An answer never reached the service">
          {status.undelivered.why}
        </Message>
      )}
      {status.outbox > 0 && (
        <Message type="info" showIcon>
          {status.outbox} answer{status.outbox === 1 ? " is" : "s are"} waiting for the connection and will be sent when it is back.
        </Message>
      )}
      {status.vaultNeedsRepair && (
        <Message type="warning" showIcon>Vault: this device can't decrypt the synced vault — re-pair it to update the password.</Message>
      )}
      {status.vaultLegacyKey && (
        <Message type="warning" showIcon>
          Vault: legacy v1 key — <Button appearance="link" size="sm" onClick={() => go("vaultpw")}>set a vault password</Button> to migrate.
        </Message>
      )}
    </>
  );
}

// Everything waiting for the user: the fill request on screen (one at a time, as main's
// queue hands them over) and any headless Keeper asking to be unlocked.
export default function ApprovalsPage({ active, status, go }) {
  const [req, setReq] = useState(getLatest());
  useEffect(() => subscribe(setReq), []);
  const unlock = useUnlock();
  const waiting = ((status && status.waiting) || 0) + ((status && status.unlocks) || 0);
  const moreFills = Math.max(0, ((status && status.waiting) || 0) - (req ? 1 : 0));

  return (
    <>
      <PageHeader icon={<NoticeIcon />} title="Approvals" meta={waiting ? `${waiting} waiting` : "nothing waiting"} />
      <PageBody>
        <div className="page-col">
          <Warnings status={status} go={go} />
          {unlock.req && <UnlockRequest {...unlock} req={unlock.req} onAnswer={unlock.answer} />}
          {req && <FillRequest key={req.request_id} req={req} active={active} />}
          {req && moreFills > 0 && (
            <p className="muted small">{moreFills} more request{moreFills === 1 ? "" : "s"} waiting after this one.</p>
          )}
          {!req && !unlock.req && (
            <div className="empty">
              <p className="empty-title">Nothing is waiting for you.</p>
              <p className="muted">
                When a remote browser session needs a password, a code or a card, it appears here and this window comes
                up on its own. The value goes straight to the service — never to the AI model.
              </p>
            </div>
          )}
        </div>
      </PageBody>
    </>
  );
}
