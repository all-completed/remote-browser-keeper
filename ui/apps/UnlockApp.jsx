import { useEffect, useState } from "react";

// "<name> Keeper restarted" (rbkeeper-unlock-v1). A headless Keeper the user pinned has
// booted and asks for the vault key. Approve seals the key to that boot only; Deny
// refuses. Nothing is ever approved automatically. The code lets the user compare
// against what the daemon printed on its console for this boot.
const fmtTime = (ms) => new Date(ms).toLocaleString();

export default function UnlockApp() {
  const [req, setReq] = useState(undefined); // undefined = loading, null = nothing pending
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
    window.keeperUnlock.onChanged(refresh);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const answer = async (approve) => {
    if (!req || busy) return;
    setBusy(true); setMsg(null);
    let r;
    try { r = await (approve ? window.keeperUnlock.approve(req.request_id) : window.keeperUnlock.deny(req.request_id)); }
    catch (e) { r = { ok: false, error: e.message }; }
    setBusy(false);
    if (!r || !r.ok) setMsg((r && r.error) || "Failed.");
    // On success main moves this window to the next request or closes it.
  };

  if (req === undefined) return null;
  if (req === null) {
    return (<><div id="glow" /><main id="wrap"><header id="head">
      <div id="title">No pending request</div>
      <div id="sub">It was answered elsewhere or expired.</div>
    </header></main></>);
  }

  const left = Math.max(0, Math.round((req.expires_at - now) / 1000));
  const btn = (bg) => ({ flex: 1, padding: "10px 12px", borderRadius: 8, border: "none", cursor: busy ? "default" : "pointer",
    background: bg, color: "#fff", fontSize: 14, fontWeight: 600, opacity: busy ? 0.6 : 1 });

  return (
    <>
      <div id="glow" />
      <main id="wrap">
        <header id="head">
          <div id="title">{req.name} Keeper restarted</div>
          <div id="sub">at {fmtTime(req.restarted_at)} — it is asking for the vault key.</div>
        </header>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "6px 2px" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 11.5, color: "var(--muted2)" }}>Code — it must match the one the Keeper printed</div>
            <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 28, letterSpacing: 2, margin: "4px 0" }}>{req.code}</div>
            <div style={{ fontSize: 11, color: "var(--muted2)", wordBreak: "break-all" }}>{req.headless_id} · boot {req.boot_id}</div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => answer(false)} disabled={busy} style={btn("var(--danger, #ef6b6b)")}>Deny</button>
            <button onClick={() => answer(true)} disabled={busy} style={btn("var(--accent, #3b6cf0)")}>{busy ? "Sealing…" : "Approve"}</button>
          </div>

          {msg && <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: "2px 0 0", color: "var(--danger, #ef6b6b)" }}>{msg}</p>}

          <p style={{ textAlign: "center", fontSize: 11.5, color: "var(--muted2)", lineHeight: 1.5, margin: "4px auto 0" }}>
            Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            {req.waiting > 1 ? ` · ${req.waiting - 1} more waiting` : ""}. If you didn't restart it, Deny.
          </p>
        </div>
      </main>
    </>
  );
}
