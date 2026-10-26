import { useEffect, useState } from "react";

// Pin headless Keepers (rbkeeper-unlock-v1). A headless Keeper prints its public key on
// first start; paste it here with a name. The pin is saved in the encrypted vault, so
// every paired device trusts the same set, and only pinned Keepers can ask to unlock.
export default function HeadlessApp() {
  const [list, setList] = useState({ loading: true });
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }

  const refresh = async () => {
    let r;
    try { r = await window.keeperHeadless.list(); } catch (e) { r = { ok: false, error: e.message }; }
    setList({ loading: false, ...r });
  };
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    let r;
    try { r = await window.keeperHeadless.add(name.trim(), key.trim()); } catch (e) { r = { ok: false, error: e.message }; }
    setBusy(false);
    if (r.ok) { setName(""); setKey(""); setMsg({ ok: true, text: `Added ${r.id}.` }); }
    else setMsg({ ok: false, text: r.error || "Could not add it." });
    refresh();
  };

  const remove = async (k) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    let r;
    try { r = await window.keeperHeadless.remove(k.id); } catch (e) { r = { ok: false, error: e.message }; }
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: `Removed ${k.name}.` } : { ok: false, text: r.error || "Could not remove it." });
    refresh();
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
          <div id="title">Headless Keepers</div>
          <div id="sub">Keepers on servers that ask you for the vault key each time they restart.</div>
        </header>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "6px 2px" }}>
          {list.loading ? <p style={{ color: "var(--muted2)" }}>…</p> :
            !list.ok ? <p style={{ fontSize: 12.5, color: "var(--danger, #ef6b6b)" }}>{list.error || "Unavailable."}</p> :
            list.keepers.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--muted2)" }}>None added yet.</p> :
            list.keepers.map((k) => (
              <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8,
                border: "1px solid var(--border, #223)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{k.name}</div>
                  <div style={{ fontSize: 11, color: "var(--muted2)", fontFamily: "ui-monospace, Menlo, monospace" }}>{k.id}</div>
                </div>
                <button onClick={() => remove(k)} disabled={busy}
                  style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: "var(--danger, #ef6b6b)",
                    color: "#fff", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>Remove</button>
              </div>
            ))}

          <div style={{ fontWeight: 600, marginTop: 6 }}>Add headless Keeper</div>
          <input placeholder="Name (e.g. build-server)" value={name} maxLength={32} disabled={busy}
            onChange={(e) => setName(e.target.value)} style={inputStyle} />
          <textarea placeholder="Public key the Keeper printed on first start" value={key} rows={3} disabled={busy}
            spellCheck={false} onChange={(e) => setKey(e.target.value)}
            style={{ ...inputStyle, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, resize: "none" }} />
          <button onClick={add} disabled={busy || !name.trim() || !key.trim()}
            style={{ padding: "10px 12px", borderRadius: 8, border: "none", cursor: busy ? "default" : "pointer",
              background: "var(--accent, #3b6cf0)", color: "#fff", fontSize: 14, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Saving…" : "Add"}
          </button>

          {msg && (
            <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: "2px 0 0",
              color: msg.ok ? "var(--ok, #57d38c)" : "var(--danger, #ef6b6b)" }}>{msg.text}</p>
          )}

          <p style={{ textAlign: "center", maxWidth: 360, fontSize: 11.5, color: "var(--muted2)", lineHeight: 1.5, margin: "4px auto 0" }}>
            Check the fingerprint (rbk1-…) matches what the Keeper printed. Each restart then shows an Approve / Deny
            window here; nothing is approved automatically.
          </p>
        </div>
      </main>
    </>
  );
}
