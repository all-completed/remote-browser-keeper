import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Message, Panel, Table } from "rsuite";
import AdminIcon from "@rsuite/icons/Admin";
import ReloadIcon from "@rsuite/icons/Reload";
import { ActionMenu, PageBody, PageHeader, ResponsiveTable } from "@f-proj/ui-components";
import { filterByQuery } from "../lib/search.js";
import { FilterCount, searchFilter } from "../components/ListFilters.jsx";

const { Column, HeaderCell, Cell } = Table;

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

  // Search the pinned list — local, no refetch (issue #31).
  const [q, setQ] = useState("");
  const keepers = list.ok ? list.keepers : [];
  const visible = filterByQuery(keepers, q, (k) => [k.name, k.fingerprint, k.id]);

  return (
    <>
      <PageHeader
        icon={<AdminIcon />}
        title="Headless Keepers"
        meta={list.ok ? `${list.keepers.length} pinned` : undefined}
        actions={[{ key: "refresh", label: "Refresh", icon: <ReloadIcon />, onClick: refresh }]}
        filters={[searchFilter({ value: q, onChange: setQ, placeholder: "Search name, fingerprint, id…", width: 280 })]}
      />
      <PageBody>
        <div className="page-wrap">
          <p className="page-intro">Keepers on servers that ask you for the vault key each time they restart.</p>
          {msg && <Message type={msg.ok ? "success" : "error"} showIcon closable onClose={() => setMsg(null)}>{msg.text}</Message>}
          <div className="split">
            <div className="stack">
              {!list.loading && !list.ok ? <Message type="error" showIcon>{list.error || "Unavailable."}</Message> : (
                <>
                  <FilterCount shown={visible.length} total={keepers.length} onClear={() => setQ("")} />
                  <div className="table-card">
                    <ResponsiveTable
                      data={visible}
                      rowKey="id"
                      autoHeight
                      wordWrap="break-word"
                      loading={list.loading}
                      renderEmpty={() => <div className="table-empty muted">{keepers.length === 0 ? "None added yet." : "No Keepers match this search."}</div>}
                    >
                      <Column flexGrow={1} minWidth={140} sortable dataKey="name">
                        <HeaderCell>Name</HeaderCell>
                        <Cell>{(k) => <span className="strong">{k.name}</span>}</Cell>
                      </Column>
                      <Column flexGrow={2} minWidth={220} mobileFull>
                        <HeaderCell>Fingerprint · id</HeaderCell>
                        <Cell>{(k) => (
                          <div className="cell-stack">
                            <span className="mono small">{k.fingerprint || "—"}</span>
                            <span className="mono small muted wrap">{k.id}</span>
                          </div>
                        )}</Cell>
                      </Column>
                      <Column width={120} mobileLabel="Actions">
                        <HeaderCell>{""}</HeaderCell>
                        <Cell>{(k) => (
                          <ActionMenu actions={[{
                            key: "remove", label: "Remove", size: "xs", color: "red", appearance: "ghost", disabled: busy,
                            confirm: { title: `Remove ${k.name}?`, body: "It can no longer ask this Keeper for the vault key until you add it again." },
                            onClick: () => remove(k),
                          }]} />
                        )}</Cell>
                      </Column>
                    </ResponsiveTable>
                  </div>
                </>
              )}
            </div>

            <Panel bordered className="card" header={
              <div>
                <div className="card-title">Add headless Keeper</div>
                <div className="card-sub">Paste the public key <code>rb-keeperd enroll</code> printed.</div>
              </div>
            }>
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
                <p className="muted small">
                  Only add a key whose fingerprint (rbk1-…) matches what the Keeper printed. Each restart then shows an Approve / Deny
                  request on the Approvals page; nothing is approved automatically.
                </p>
              </form>
            </Panel>
          </div>
        </div>
      </PageBody>
    </>
  );
}
