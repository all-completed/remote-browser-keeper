import { useEffect, useState } from "react";
import { Button, Table, Tag } from "rsuite";
import StorageIcon from "@rsuite/icons/Storage";
import ReloadIcon from "@rsuite/icons/Reload";
import { ActionMenu, CopyButton, PageBody, PageHeader, ResponsiveTable } from "@f-proj/ui-components";
import { relTime, absTime } from "../lib/format.js";
import { distinctValues, filterByQuery } from "../lib/search.js";
import { FilterCount, pickerFilter, searchFilter } from "../components/ListFilters.jsx";

const { Column, HeaderCell, Cell } = Table;

const scopeLabel = (e) => (e.scope === "vault" ? "vault · synced" : e.scope === "forever" ? "saved securely" : "until restart");
const SESSIONLESS = "—"; // a value saved for the site, not for one session

// Lists field values the user saved on this machine and lets them forget any (or all).
// Only metadata is shown — the value itself is encrypted at rest and shown only when the
// user presses Reveal, and never sent to the AI.
export default function SavedFieldsPage() {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState({}); // entryKey -> revealed value (in-memory only)
  // Search and site/session filters — local to this page, no refetch (issue #31). A row's
  // site/session chip sets the same filter as the picker.
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState({ session: null, host: null });
  const onFilter = (key, value) => setFilter((f) => ({ ...f, [key]: value }));
  const clearAll = () => { setQ(""); setFilter({ session: null, host: null }); };

  const keyOf = (e) => (e.session || "") + "|" + e.host + "|" + e.selector;
  const rows = items.map((e, i) => ({ ...e, _key: keyOf(e) + "|" + i }));
  const narrowed = rows.filter((e) => (
    (filter.session === null || (e.session || SESSIONLESS) === filter.session)
    && (filter.host === null || e.host === filter.host)
  ));
  // Never the revealed value: search covers metadata only.
  const visible = filterByQuery(narrowed, q, (e) => [e.host, e.session, e.selector, scopeLabel(e), e.auto ? "auto-fill" : ""]);

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
      <PageHeader
        icon={<StorageIcon />}
        title="Saved fields"
        meta={`${items.length} saved`}
        actions={[{ key: "refresh", label: "Refresh", icon: <ReloadIcon />, onClick: refresh }]}
        filters={[
          searchFilter({ value: q, onChange: setQ, placeholder: "Search site, session, selector…", width: 280 }),
          pickerFilter({ key: "host", label: "Site", value: filter.host, onChange: (v) => onFilter("host", v),
            options: distinctValues(items, (e) => e.host), placeholder: "All sites", width: 220 }),
          pickerFilter({ key: "session", label: "Session", value: filter.session, onChange: (v) => onFilter("session", v),
            options: distinctValues(items, (e) => e.session || SESSIONLESS), placeholder: "All sessions", width: 180, mono: true }),
        ]}
      >
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
        <div className="page-wrap">
          <p className="page-intro">Values you chose to keep. Encrypted at rest and never sent to the AI; shown only when you press <b>Reveal</b>.</p>
          <FilterCount shown={visible.length} total={items.length} onClear={clearAll} />
          <div className="table-card">
            <ResponsiveTable
              data={visible}
              rowKey="_key"
              autoHeight
              wordWrap="break-word"
              loading={!loaded}
              renderEmpty={() => <div className="table-empty muted">{items.length === 0 ? "No saved fields." : "No saved fields match this search."}</div>}
            >
              <Column flexGrow={2} minWidth={200} sortable dataKey="host">
                <HeaderCell>Site</HeaderCell>
                <Cell>{(e) => (
                  <Button
                    size="xs"
                    appearance={filter.host === e.host ? "primary" : "ghost"}
                    title={filter.host === e.host ? "Clear this filter" : `Show only ${e.host}`}
                    onClick={() => onFilter("host", filter.host === e.host ? null : e.host)}
                  >{e.host}</Button>
                )}</Cell>
              </Column>
              <Column width={160} sortable dataKey="session" sortValue={(e) => e.session || null}>
                <HeaderCell>Session</HeaderCell>
                <Cell>{(e) => {
                  const s = e.session || SESSIONLESS;
                  return (
                    <Button
                      size="xs"
                      className="mono"
                      appearance={filter.session === s ? "primary" : "ghost"}
                      title={filter.session === s ? "Clear this filter" : `Show only session ${s}`}
                      onClick={() => onFilter("session", filter.session === s ? null : s)}
                    >{s}</Button>
                  );
                }}</Cell>
              </Column>
              <Column flexGrow={2} minWidth={180} mobileFull>
                <HeaderCell>Field</HeaderCell>
                <Cell>{(e) => (
                  <div className="cell-stack">
                    <span className="mono small wrap">{e.selector}</span>
                    {shown[keyOf(e)] != null && (
                      <span className="revealed">
                        <code className="mono">{shown[keyOf(e)]}</code>
                        <CopyButton text={shown[keyOf(e)]} label="Copy value" />
                      </span>
                    )}
                  </div>
                )}</Cell>
              </Column>
              <Column width={190}>
                <HeaderCell>Stored</HeaderCell>
                <Cell>{(e) => (
                  <div className="chips">
                    <Tag size="sm" color={e.scope === "session" ? "orange" : "green"}>{scopeLabel(e)}</Tag>
                    {e.auto && <Tag size="sm">auto-fill</Tag>}
                  </div>
                )}</Cell>
              </Column>
              <Column width={110} sortable dataKey="updated_at" sortValue={(e) => (e.updated_at ? new Date(e.updated_at).getTime() : null)}>
                <HeaderCell>Updated</HeaderCell>
                <Cell>{(e) => (e.updated_at ? <span className="muted small" title={absTime(e.updated_at)}>{relTime(e.updated_at)}</span> : <span className="muted">—</span>)}</Cell>
              </Column>
              <Column width={170} mobileLabel="Actions">
                <HeaderCell>{""}</HeaderCell>
                <Cell>{(e) => (
                  <div className="cell-actions">
                    <Button size="xs" onClick={() => toggleReveal(e)}>{shown[keyOf(e)] != null ? "Hide" : "Reveal"}</Button>
                    <ActionMenu actions={[{
                      key: "forget", label: "Forget", size: "xs", color: "red", appearance: "ghost",
                      confirm: { title: "Forget this value?", body: `Forget the saved value for ${e.host}? This can't be undone.` },
                      onClick: () => forgetOne(e),
                    }]} />
                  </div>
                )}</Cell>
              </Column>
            </ResponsiveTable>
          </div>
        </div>
      </PageBody>
    </>
  );
}
