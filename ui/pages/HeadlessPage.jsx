import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Loader, Message, Panel } from "rsuite";
import AdminIcon from "@rsuite/icons/Admin";
import { ActionMenu, PageBody, PageHeader } from "@f-proj/ui-components";

// Pin headless Keepers (rbkeeper-unlock-v1). `rb-keeperd enroll` prints a public key and
// its rbk1-… fingerprint; paste the key here with a name, and confirm the fingerprint shown
// matches before adding (spec §3). The pin is saved in the encrypted vault, so
// every paired device trusts the same set, and only pinned Keepers can ask to unlock.
export default function HeadlessPage() {
  const [list, setList] = useState({ loading: true });
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [preview, setPreview] = useState(null); // { ok, fingerprint } | { ok:false, error }
  const [confirmed, setConfirmed] = useState(false);

  // Recompute the fingerprint whenever the pasted key changes; a new key needs a new confirm.
  useEffect(() => {
    setConfirmed(false);
    const k = key.trim();
    if (!k) { setPreview(null); return; }
    let live = true;
    window.keeperHeadless.preview(k)
      .then((r) => { if (live) setPreview(r); })
      .catch((e) => { if (live) setPreview({ ok: false, error: e.message }); });
    return () => { live = false; };
  }, [key]);

  const refresh = async () => {
    let r;
    try { r = await window.keeperHeadless.list(); } catch (e) { r = { ok: false, error: e.message }; }
    setList({ loading: false, ...r });
  };
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    if (busy || !confirmed || !preview?.ok) return;
    setBusy(true); setMsg(null);
    let r;
    try { r = await window.keeperHeadless.add(name.trim(), key.trim()); } catch (e) { r = { ok: false, error: e.message }; }
    setBusy(false);
    if (r.ok) { setName(""); setKey(""); setMsg({ ok: true, text: `Added ${r.fingerprint}.` }); }
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

  return (
    <>
      <PageHeader icon={<AdminIcon />} title="Headless Keepers" meta={list.ok ? `${list.keepers.length} pinned` : undefined} />
      <PageBody>
        <div className="page-col">
          <p className="muted">Keepers on servers that ask you for the vault key each time they restart.</p>

          {list.loading ? <Loader /> :
            !list.ok ? <Message type="error" showIcon>{list.error || "Unavailable."}</Message> :
            list.keepers.length === 0 ? <p className="muted">None added yet.</p> :
            <div className="list">
              {list.keepers.map((k) => (
                <Panel bordered className="entry" key={k.id}>
                  <div className="row">
                    <div className="grow">
                      <div className="strong">{k.name}</div>
                      <div className="mono small">{k.fingerprint || "—"}</div>
                      <div className="mono small muted wrap">{k.id}</div>
                    </div>
                    <ActionMenu actions={[{
                      key: "remove", label: "Remove", size: "sm", color: "red", appearance: "ghost", disabled: busy,
                      confirm: { title: `Remove ${k.name}?`, body: "It can no longer ask this Keeper for the vault key until you add it again." },
                      onClick: () => remove(k),
                    }]} />
                  </div>
                </Panel>
              ))}
            </div>}

          <Panel bordered header="Add headless Keeper">
            <form className="form" onSubmit={(e) => { e.preventDefault(); add(); }}>
              <Input placeholder="Name (e.g. build-server)" value={name} maxLength={32} disabled={busy} onChange={setName} />
              <Input as="textarea" className="mono" placeholder="Public key the Keeper printed on first start" value={key} rows={3}
                disabled={busy} spellCheck={false} onChange={setKey} />
              {preview && (preview.ok ? (
                <>
                  <div>Fingerprint: <span className="mono strong">{preview.fingerprint}</span></div>
                  <Checkbox checked={confirmed} disabled={busy} onChange={(_v, checked) => setConfirmed(checked)}>
                    It matches the fingerprint <code>rb-keeperd enroll</code> printed
                  </Checkbox>
                </>
              ) : <Message type="error">{preview.error || "Not a public key."}</Message>)}
              <Button type="submit" appearance="primary" loading={busy} disabled={busy || !name.trim() || !preview?.ok || !confirmed}>Add</Button>
            </form>
          </Panel>

          {msg && <Message type={msg.ok ? "success" : "error"} showIcon>{msg.text}</Message>}

          <p className="muted small">
            Only add a key whose fingerprint (rbk1-…) matches what the Keeper printed. Each restart then shows an Approve / Deny
            request on the Approvals page; nothing is approved automatically.
          </p>
        </div>
      </PageBody>
    </>
  );
}
