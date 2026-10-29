import { useEffect, useState } from "react";

// How the vault state reported by the main process (device.js `state`) reads to a human.
// `tone` picks the color: a legacy v1 key or an undecryptable vault are problems to fix,
// not version trivia.
const VAULT_STATE = {
  ok: { tone: "ok", text: "In sync — current key model (v2)." },
  no_key: { tone: "muted", text: "No vault key on this device — pair it, or save a field to the vault to create one." },
  needs_repair: { tone: "bad", text: "A vault exists but this device can't decrypt it — re-pair this device." },
  legacy_v1: { tone: "bad", text: "Legacy key model — needs migration. Use “Set vault password…” to re-encrypt onto v2." },
};
const TONE = { ok: "var(--ok, #57d38c)", bad: "var(--danger, #ef6b6b)", muted: "var(--muted2)" };

// Which credential the live socket is using, said plainly. The distinction that matters
// to the user is "only this device can be cut off" vs "cutting this off cuts off
// everything", so lead with that rather than with the token.
function authLabel(auth) {
  if (!auth) return "account key (shared with every device)";
  if (auth.kind === "device" || auth.enrolled) {
    return "this device's own token" + (auth.secret_bound ? "" : " (no encryption secret)");
  }
  if (auth.enrollment_supported === false) {
    return "account key — this service doesn't issue per-device tokens";
  }
  return "account key (shared with every device)";
}

// One label/value line of the device panel.
function Row({ label, children, mono }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0" }}>
      <span style={{ flex: "0 0 92px", fontSize: 12, color: "var(--muted2)" }}>{label}</span>
      <span style={{ fontSize: 12.5, color: "var(--text, #e8eefc)", wordBreak: "break-all",
        fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined }}>{children}</span>
    </div>
  );
}

// Per-device Keeper preferences, plus a read-only panel naming this device and the vault
// it holds. Everything shown here is the same inert metadata the Keeper reports to the
// service on connect (no password, no key, and no `secret_id` for a legacy v1 key —
// there the id IS the key, see src/vault.js).
export default function SettingsApp() {
  const [loading, setLoading] = useState(true);
  const [showWindow, setShowWindow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null); // { device, vault } | { error }

  useEffect(() => {
    (async () => {
      try {
        const r = await window.keeperSettings.get();
        if (r && r.ok) setShowWindow(!!r.settings.generateShowWindow);
        else setErr((r && r.error) || "Could not load settings.");
      } catch (e) { setErr(e.message); }
      setLoading(false);
    })();
    (async () => {
      try {
        const r = await window.keeperSettings.deviceInfo?.();
        setInfo(r && r.ok ? r : { error: (r && r.error) || "Could not read this device's state." });
      } catch (e) { setInfo({ error: e.message }); }
    })();
  }, []);

  const toggle = async (next) => {
    setShowWindow(next); // optimistic
    setSaving(true);
    setErr(null);
    try {
      const r = await window.keeperSettings.set({ generateShowWindow: next });
      if (!r || !r.ok) { setErr((r && r.error) || "Could not save."); setShowWindow(!next); }
      else setShowWindow(!!r.settings.generateShowWindow);
    } catch (e) { setErr(e.message); setShowWindow(!next); }
    setSaving(false);
  };

  return (
    <>
      <div id="glow" />
      <main id="wrap">
        <header id="head">
          <div id="title">Settings</div>
          <div id="sub">Preferences for this device only.</div>
        </header>

        <section style={{ padding: "6px 2px" }}>
          <div style={{ fontSize: 12.5, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted2)", margin: "4px 0 10px" }}>
            This device
          </div>

          {!info ? (
            <p style={{ fontSize: 12.5, color: "var(--muted2)", margin: 0 }}>…</p>
          ) : info.error ? (
            <p style={{ fontSize: 12.5, color: "var(--danger, #ef6b6b)", margin: 0 }}>{info.error}</p>
          ) : (
            <>
              <Row label="Device">{info.device.name} · {info.device.platform} · v{info.device.app_version}</Row>
              <Row label="Device ID" mono>{info.device.id}</Row>
              {/* How this device authenticates (issue #15). "Account key" is not a fault
                  — it is how every Keeper worked before per-device tokens, and how this
                  one keeps working against a service that doesn't offer them. */}
              <Row label="Auth">{authLabel(info.auth)}</Row>
              <Row label="Vault">
                {info.vault.has_key
                  ? <>schema {info.vault.schema} · {info.vault.key_format}{info.vault.version != null ? ` · version ${info.vault.version}` : " · not synced yet"}</>
                  : <>none held</>}
              </Row>
              {/* Present only for v2 — a v1 device reports no id, because there it IS the key. */}
              {info.vault.secret_id && <Row label="Vault ID" mono>{info.vault.secret_id.slice(0, 16)}…</Row>}
              <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: "8px 0 0",
                color: TONE[(VAULT_STATE[info.vault.state] || {}).tone] || "var(--muted2)" }}>
                {(VAULT_STATE[info.vault.state] || { text: info.vault.state }).text}
              </p>
            </>
          )}

          <div style={{ fontSize: 12.5, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted2)", margin: "22px 0 10px" }}>
            Password generation
          </div>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 12, cursor: loading ? "default" : "pointer" }}>
            <input
              type="checkbox"
              checked={showWindow}
              disabled={loading || saving}
              onChange={(e) => toggle(e.target.checked)}
              style={{ width: 18, height: 18, marginTop: 2, accentColor: "var(--accent, #3b6cf0)", flex: "0 0 auto" }}
            />
            <span>
              <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--text, #e8eefc)" }}>
                Show the password window when generating
              </span>
              <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.5, color: "var(--muted2)", marginTop: 3 }}>
                Off (default): a new password is generated, filled, and saved automatically — you're never asked.
                On: the Keeper opens the prompt with the generated password so you can review, edit, or regenerate it before it fills.
              </span>
            </span>
          </label>

          {err && (
            <p style={{ fontSize: 12.5, color: "var(--danger, #ef6b6b)", marginTop: 12 }}>{err}</p>
          )}

          <p style={{ fontSize: 11.5, color: "var(--muted2)", lineHeight: 1.5, margin: "18px 0 0" }}>
            Generated passwords are always at least 14 characters with a mix of letters, digits, and symbols
            (unless a site rejects symbols). The AI never sees the value.
          </p>
        </section>
      </main>
    </>
  );
}
