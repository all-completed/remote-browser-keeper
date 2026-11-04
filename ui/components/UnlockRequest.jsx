import { useEffect, useState } from "react";
import { Button, Message, Panel } from "rsuite";
import { subscribeUnlock } from "../lib/unlockBridge.js";

// ---------- A headless Keeper asking for the vault key (in the approval window, issue #34) ----------
// A headless Keeper the user pinned has booted and asks for the vault key
// (rbkeeper-unlock-v1). Approve seals the key to that boot only; Deny refuses. Nothing is
// ever approved automatically. The code lets the user compare against what the daemon
// printed on its console for this boot.
const fmtTime = (ms) => new Date(ms).toLocaleString();

export function UnlockRequest({ req, busy, msg, onAnswer, now }) {
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

export function useUnlock() {
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
