import { useEffect, useState } from "react";

// Shows a QR code of this Keeper's connection config (base URL + API token) so the
// mobile app can scan it and pair instantly. The QR image is produced in the main
// process — the renderer only ever receives the image and the host name, never the
// raw token. The QR is shown only on this local screen, never sent anywhere.
export default function PairApp() {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let r;
      try { r = await window.keeperPair.qr(); } catch (e) { r = { error: e.message }; }
      if (!cancelled) setState({ loading: false, ...r });
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div id="glow" />
      <main id="wrap">
        <header id="head">
          <div id="title">Pair your phone</div>
          <div id="sub">Scan this code from the Remote Browser Keeper app → Settings → Scan QR.</div>
        </header>

        {state.loading ? (
          <p id="empty">Generating…</p>
        ) : state.error ? (
          <p id="empty">{state.error}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "8px 0 4px" }}>
            <img
              src={state.dataUrl}
              alt="Pairing QR code"
              width={260}
              height={260}
              style={{ borderRadius: 12, background: "#fff", padding: 10, boxShadow: "0 6px 24px rgba(0,0,0,.4)" }}
            />
            <span className="chip url">{state.host}</span>
            <p style={{ textAlign: "center", maxWidth: 320, fontSize: 11.5, color: "var(--muted2)", lineHeight: 1.5 }}>
              This code contains your service URL and API token. Anyone who scans it can connect as you — show it only to
              your own device.
            </p>
          </div>
        )}
      </main>
    </>
  );
}
