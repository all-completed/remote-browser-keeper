import { useEffect, useState } from "react";
import { Button, Panel, Tag } from "rsuite";
import StorageIcon from "@rsuite/icons/Storage";
import { ActionMenu, CopyButton, PageBody, PageHeader } from "@f-proj/ui-components";
import { relTime, absTime } from "../lib/format.js";

// Lists field values the user saved on this machine and lets them forget any (or all).
// Only metadata is shown — the value itself is encrypted at rest and shown only when the
// user presses Reveal, and never sent to the AI.
export default function SavedFieldsPage() {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState({}); // entryKey -> revealed value (in-memory only)
  // Click a host/session chip to narrow the list — local to this page, no refetch.
  const [filter, setFilter] = useState({ session: null, host: null });
  const onFilter = (key, value) => setFilter((f) => ({ ...f, [key]: value }));
  const activeFilter = filter.session !== null || filter.host !== null;
  const visible = items.filter((e) => (
    (filter.session === null || (e.session || "") === filter.session)
    && (filter.host === null || e.host === filter.host)
  ));

  const keyOf = (e) => (e.session || "") + "|" + e.host + "|" + e.selector;
  // Reveal (or hide) a single saved value on demand — useful for reading a generated
  // password you never saw. The value is fetched only when asked and kept in memory.
  const toggleReveal = async (e) => {
    const k = keyOf(e);
    if (shown[k] != null) { setShown((m) => { const n = { ...m }; delete n[k]; return n; }); return; }
    let r;
    try { r = await window.savedFields.reveal({ session: e.session, host: e.host, selector: e.selector }); } catch { r = null; }
    if (r && r.ok && r.value != null) setShown((m) => ({ ...m, [k]: r.value }));
  };

  const refresh = async () => {
    let list = [];
    try { list = await window.savedFields.list(); } catch { /* ignore */ }
    setItems(Array.isArray(list) ? list : []);
    setLoaded(true);
  };
  useEffect(() => { refresh(); }, []);

  // Forgetting is destructive, so ActionMenu confirms it first and only then calls these.
  const forgetAll = async () => { try { await window.savedFields.forgetAll(); } finally { refresh(); } };
  const forgetOne = async (e) => {
    try { await window.savedFields.forget({ session: e.session, host: e.host, selector: e.selector }); } finally { refresh(); }
  };

  return (
    <>
      <PageHeader icon={<StorageIcon />} title="Saved fields" meta={`${items.length} saved`}>
        <Button size="sm" onClick={refresh}>Refresh</Button>
        {items.length > 0 && (
          <ActionMenu actions={[{
            key: "forget-all", label: "Forget all", color: "red", appearance: "ghost", size: "sm",
            confirm: {
              title: "Forget all saved fields?",
              body: `Forget all ${items.length} saved field${items.length === 1 ? "" : "s"}? This can't be undone.`,
            },
            onClick: forgetAll,
          }]} />
        )}
      </PageHeader>
      <PageBody>
        <div className="page-col">
          <p className="muted">Values you chose to keep. Encrypted at rest and never sent to the AI; shown only when you press <b>Reveal</b>.</p>

          {activeFilter && (
            <div className="chips">
              <span className="muted">Filtered by</span>
              {filter.host !== null && <Tag size="sm" color="blue">{filter.host}</Tag>}
              {filter.session !== null && <Tag size="sm" color="blue">session: {filter.session || "—"}</Tag>}
              <Button size="xs" appearance="link" onClick={() => setFilter({ session: null, host: null })}>Clear</Button>
              <span className="muted small push">{visible.length} of {items.length}</span>
            </div>
          )}
          {loaded && items.length === 0 ? (
            <p className="empty-title">No saved fields.</p>
          ) : visible.length === 0 ? (
            <p className="empty-title">{loaded ? "No saved fields match this filter." : "…"}</p>
          ) : (
            <div className="list">
              {visible.map((e, i) => (
                <Panel bordered className="entry" key={keyOf(e) + "|" + i}>
                  <div className="chips">
                    <Tag size="sm" color={e.scope === "session" ? "orange" : "green"}>
                      {e.scope === "vault" ? "vault · synced" : e.scope === "forever" ? "saved securely" : "until restart"}
                    </Tag>
                    {e.auto && <Tag size="sm">auto-fill</Tag>}
                    <span className="push" />
                    <Button size="xs" onClick={() => toggleReveal(e)}>{shown[keyOf(e)] != null ? "Hide" : "Reveal"}</Button>
                    <ActionMenu actions={[{
                      key: "forget", label: "Forget", size: "xs", color: "red", appearance: "ghost",
                      confirm: { title: "Forget this value?", body: `Forget the saved value for ${e.host}? This can't be undone.` },
                      onClick: () => forgetOne(e),
                    }]} />
                  </div>
                  <div className="chips">
                    <Button
                      size="xs"
                      appearance={filter.host === e.host ? "primary" : "ghost"}
                      title={filter.host === e.host ? "Clear this filter" : `Show only ${e.host}`}
                      onClick={() => onFilter("host", filter.host === e.host ? null : e.host)}
                    >{e.host}</Button>
                    <Button
                      size="xs"
                      className="mono"
                      appearance={filter.session === (e.session || "") ? "primary" : "ghost"}
                      title={filter.session === (e.session || "") ? "Clear this filter" : `Show only session ${e.session || "—"}`}
                      onClick={() => onFilter("session", filter.session === (e.session || "") ? null : (e.session || ""))}
                    >session: {e.session || "—"}</Button>
                    {e.updated_at && <span className="muted small" title={absTime(e.updated_at)}>{relTime(e.updated_at)}</span>}
                  </div>
                  <div className="kv"><span className="muted">selector: </span><span className="mono">{e.selector}</span></div>
                  {shown[keyOf(e)] != null && (
                    <div className="kv revealed">
                      <span className="muted">value: </span>
                      <code className="mono">{shown[keyOf(e)]}</code>
                      <CopyButton text={shown[keyOf(e)]} label="Copy value" />
                    </div>
                  )}
                </Panel>
              ))}
            </div>
          )}
        </div>
      </PageBody>
    </>
  );
}
