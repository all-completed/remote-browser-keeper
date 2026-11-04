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
        <div className="page-col narrow">
          <p className="muted">
            {status.loading ? "…" :
              status.needsRepair ? "This device is out of sync — re-pair it before changing the password." :
              status.custom ? "A custom password is currently set." :
              "The vault currently uses an auto-generated key stored in your keychain."}
          </p>
          <Panel bordered>
            <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <Input type="password" placeholder="New vault password" value={pw} autoFocus disabled={off} onChange={setPw} />
              <Input type="password" placeholder="Confirm password" value={pw2} disabled={off} onChange={setPw2} />
              <Button type="submit" appearance="primary" block disabled={off} loading={busy}>Set vault password</Button>
            </form>
          </Panel>
          {msg && <Message type={msg.ok ? "success" : "error"} showIcon>{msg.text}</Message>}
          <p className="muted small">
            The service never learns this password — the vault stays end-to-end encrypted. If you forget it, the vault
            cannot be recovered.
          </p>
        </div>
      </PageBody>
    </>
  );
}
