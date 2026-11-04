import { useEffect, useState } from "react";
import { Loader, Message, Panel, Tag } from "rsuite";
import QrcodeIcon from "@rsuite/icons/Qrcode";
import { PageBody, PageHeader } from "@f-proj/ui-components";

// Shows a QR code of this Keeper's connection config (base URL + API token) so the
// mobile app can scan it and pair instantly. The QR image is produced in the main
// process — the renderer only ever receives the image and the host name, never the
// raw token. The QR is shown only on this local screen, never sent anywhere. It is asked
// for when the page opens and dropped when the page closes (the page unmounts).
export default function PairPage() {
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
      <PageHeader icon={<QrcodeIcon />} title="Pair phone" />
      <PageBody>
        <div className="page-col narrow">
          <p className="muted">Scan this code from the Remote Browser Keeper app → Settings → Scan QR.</p>
          {state.loading ? (
            <Loader content="Generating…" />
          ) : state.error ? (
            <Message type="error" showIcon>{state.error}</Message>
          ) : (
            <Panel bordered className="center">
              <img src={state.dataUrl} alt="Pairing QR code" width={260} height={260} className="qr" />
              <div><Tag size="sm">{state.host}</Tag></div>
              <p className="muted small">
                This code contains your service URL and API token. Anyone who scans it can connect as you — show it only to
                your own device.
              </p>
            </Panel>
          )}
        </div>
      </PageBody>
    </>
  );
}
