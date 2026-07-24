import { useEffect, useState } from "react";

// Set (or replace) the vault's dedicated password (item 3). By default the Keeper uses
// a high-entropy password it generated and stored in the OS keychain; here the user can
// substitute their own. On save, the main process reads the current vault, re-encrypts
// it under the new password (PBKDF2), and re-uploads — no data is lost. Every OTHER
// paired device then sees a mismatch and must re-pair to resync. The password is sent
// only to the local main process, never to the service in the clear.
export default function VaultPwApp() {
  const [status, setStatus] = useState({ loading: true });
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }

  const refresh = async () => {
    let s;
    try { s = await window.keeperVault.status(); } catch (e) { s = { ok: false, error: e.message }; }
    setStatus({ loading: false, ...s });
  };
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    setMsg(null);
    if (pw.length < 8) { setMsg({ ok: false, text: "Use at least 8 characters." }); return; }
    if (pw !== pw2) { setMsg({ ok: false, text: "Passwords don't match." }); return; }
    setBusy(true);
    let r;
    try { r = await window.keeperVault.setPassword(pw); } catch (e) { r = { ok: false, error: e.message }; }
    setBusy(false);
    if (r.ok) {
      setPw(""); setPw2("");
      setMsg({ ok: true, text: "Vault re-encrypted under your new password. Re-pair your other devices to resync." });
      refresh();
    } else {
      setMsg({ ok: false, text: r.error || "Could not set the password." });
    }
  };

  const inputStyle = {
    width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8,
    border: "1px solid var(--border, #223)", background: "var(--field, #0c1120)",
    color: "var(--text, #e8eefc)", fontSize: 14, outline: "none",
  };

  return (
    <>
      <div id="glow" />
      <main id="wrap">
        <header id="head">
          <div id="title">Vault password</div>
          <div id="sub">
            {status.loading ? "…" :
              status.needsRepair ? "This device is out of sync — re-pair it before changing the password." :
              status.custom ? "A custom password is currently set." :
              "The vault currently uses an auto-generated key stored in your keychain."}
          </div>
        </header>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "6px 2px" }}>
          <input type="password" placeholder="New vault password" value={pw} autoFocus
            disabled={busy || status.needsRepair}
            onChange={(e) => setPw(e.target.value)} style={inputStyle} />
          <input type="password" placeholder="Confirm password" value={pw2}
            disabled={busy || status.needsRepair}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            onChange={(e) => setPw2(e.target.value)} style={inputStyle} />

          <button onClick={save} disabled={busy || status.needsRepair}
            style={{ padding: "10px 12px", borderRadius: 8, border: "none", cursor: busy ? "default" : "pointer",
              background: "var(--accent, #3b6cf0)", color: "#fff", fontSize: 14, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Re-encrypting…" : "Set vault password"}
          </button>

          {msg && (
            <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: "2px 0 0",
              color: msg.ok ? "var(--ok, #57d38c)" : "var(--danger, #ef6b6b)" }}>{msg.text}</p>
          )}

          <p style={{ textAlign: "center", maxWidth: 340, fontSize: 11.5, color: "var(--muted2)", lineHeight: 1.5, margin: "4px auto 0" }}>
            The service never learns this password — the vault stays end-to-end encrypted. If you forget it, the vault
            cannot be recovered.
          </p>
        </div>
      </main>
    </>
  );
}
