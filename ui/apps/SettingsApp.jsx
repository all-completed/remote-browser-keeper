import { useEffect, useState } from "react";

// Per-device Keeper preferences. Currently a single toggle for how password generation
// behaves: by default the Keeper generates + fills a new password with no prompt; turning
// this on makes it open the password window instead, so you can review/edit or regenerate
// the value before it's filled. Non-secret and local to this device.
export default function SettingsApp() {
  const [loading, setLoading] = useState(true);
  const [showWindow, setShowWindow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.keeperSettings.get();
        if (r && r.ok) setShowWindow(!!r.settings.generateShowWindow);
        else setErr((r && r.error) || "Could not load settings.");
      } catch (e) { setErr(e.message); }
      setLoading(false);
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
