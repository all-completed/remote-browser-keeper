import { useEffect, useState } from "react";
import { Button, Input, Message, Panel } from "rsuite";
import LockIcon from "@rsuite/icons/Lock";
import { PageBody, PageHeader } from "@f-proj/ui-components";

// Set (or replace) the vault's dedicated password (item 3). By default the Keeper uses
// a high-entropy password it generated and stored in the OS keychain; here the user can
// substitute their own. On save, the main process reads the current vault, re-encrypts
// it under the new password (PBKDF2), and re-uploads — no data is lost. Every OTHER
// paired device then sees a mismatch and must re-pair to resync. The password is sent
// only to the local main process, never to the service in the clear.
export default function VaultPasswordPage() {
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

  const off = busy || status.needsRepair;
  return (
    <>
      <PageHeader icon={<LockIcon />} title="Vault password" />
      <PageBody>
        <div className="page-wrap narrow">
          <div className="split even">
            <Panel bordered className="card" header={
              <div>
                <div className="card-title">Set vault password</div>
                <div className="card-sub">
                  {status.loading ? "…" :
                    status.needsRepair ? "This device is out of sync — re-pair it before changing the password." :
                    status.custom ? "A custom password is currently set." :
                    "The vault currently uses an auto-generated key stored in your keychain."}
                </div>
              </div>
            }>
              <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
                <Input type="password" placeholder="New vault password" value={pw} autoFocus disabled={off} onChange={setPw} />
                <Input type="password" placeholder="Confirm password" value={pw2} disabled={off} onChange={setPw2} />
                <Button type="submit" appearance="primary" block disabled={off} loading={busy}>Set vault password</Button>
              </form>
              {msg && <Message type={msg.ok ? "success" : "error"} showIcon className="dl-note">{msg.text}</Message>}
            </Panel>
            <Panel bordered className="card" header={<div className="card-title">What changes</div>}>
              <ul className="steps">
                <li>The vault is re-encrypted under the new password and re-uploaded — nothing in it is lost.</li>
                <li>Every <b>other</b> paired device then has to be re-paired to resync.</li>
                <li>The service never learns this password — the vault stays end-to-end encrypted.</li>
                <li>If you forget it, the vault cannot be recovered.</li>
              </ul>
            </Panel>
          </div>
        </div>
      </PageBody>
    </>
  );
}
