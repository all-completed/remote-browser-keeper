import { useEffect, useMemo, useState } from "react";
import { Button, Message, Table, Tag } from "rsuite";
import HistoryIcon from "@rsuite/icons/History";
import ReloadIcon from "@rsuite/icons/Reload";
import { PageBody, PageHeader, ResponsiveTable } from "@f-proj/ui-components";
import { shortUrl, relTime } from "../lib/format.js";
import { getLatest, subscribe } from "../lib/historyBridge.js";
import { distinctValues, filterByQuery } from "../lib/search.js";
import { useImageViewer } from "../components/ImageViewer.jsx";
import { FilterCount, pickerFilter, searchFilter } from "../components/ListFilters.jsx";

const { Column, HeaderCell, Cell } = Table;

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return ""; }
}

// Colour for a status word from EITHER vocabulary — local outcomes
// (submitted/cancelled/autofilled/ui_failed/expired/undelivered) and server statuses
// (pending/filled/cancelled/timeout/no_keeper/error) share one scale. A word in neither set
// reads red, which is right for the two that mean "this device failed you": `ui_failed`
// and `undelivered`.
const OK = new Set(["submitted", "autofilled", "filled"]);
const WARN = new Set(["pending", "timeout", "expired", "no_keeper"]);
const badgeColor = (v) => (OK.has(v) ? "green" : WARN.has(v) ? "orange" : "red");

// Where the record is known from. Derived purely from which list(s) it was found in
// (see src/historymerge.js) — never guessed from a status. While the server list is
// missing we can only claim "client", not "client only": the request may well be on the
// server too, we just couldn't ask.
//
// The labels name the two sides — "server + client" rather than "both" — because "both"
// only means something once you already know what the two lists are.
function provenance(source, serverKnown) {
  if (source === "both") return { label: "server + client", title: "Recorded on this device and by the service" };
  if (source === "server") return { label: "server only", title: "The service has this request; this device has no record of it (answered on another device, or never delivered here)" };
  if (serverKnown) return { label: "client only", title: "This device has this request; the service's list does not" };
  return { label: "client", title: "From this device's log. The service's list could not be loaded, so this request may exist there too." };
}

// A session / host chip in a row: narrows the list to it (the same filter as the picker in
// the filter row), and clears that filter when it is the active one.
function FilterChip({ active, title, onClick, children, mono }) {
  return (
    <Button size="xs" appearance={active ? "primary" : "ghost"} title={title} onClick={onClick} className={mono ? "mono" : undefined}>
      {children}
    </Button>
  );
}

// When the two sides disagree on the same request_id, both are shown, labelled — picking one
// would hide either what the service did or what this device did.
function StatusTags({ it, serverKnown }) {
  const prov = provenance(it.source, serverKnown);
  const badges = it.disagree
    ? [{ src: "client", v: it.outcome }, { src: "server", v: it.status }]
    : [{ src: null, v: it.effective || "unknown" }];
  return (
    <div className="chips">
      {badges.map(({ src, v }) => (
        <Tag key={src || "only"} size="sm" color={badgeColor(v)}>
          {src ? <span className="badge-src">{src}: </span> : null}{v}
        </Tag>
      ))}
      <Tag size="sm" title={prov.title}>{prov.label}</Tag>
    </div>
  );
}

const fieldNames = (it) => (Array.isArray(it.fields) ? it.fields : []).map((f) => f.label || f.field || f.selector || "field");
const statusWords = (it) => (it.disagree ? [it.outcome, it.status] : [it.effective || "unknown"]);
const timeOf = (it) => {
  const t = new Date(it.resolved_at || it.requested_at || 0).getTime();
  return isNaN(t) ? null : t;
};

export default function HistoryPage() {
  const view = useImageViewer();
  const [payload, setPayload] = useState(getLatest());
  useEffect(() => subscribe(setPayload), []);
  // Ask for a fresh list every time the page opens: main paints the local log at once and
  // repaints with the service's when it lands (src/main.js sendHistory).
  useEffect(() => { try { window.keeperHistory.refresh(); } catch { /* ignore */ } }, []);
  const list = Array.isArray(payload && payload.items) ? payload.items : [];
  const server = (payload && payload.server) || { state: "loading" };
  const serverKnown = server.state === "ok";

  // Search and filters — purely local to this page, no refetch: the history is already in
  // memory (issue #31). The row chips set the same site/session filters as the pickers.
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState({ session: null, host: null, status: null });
  const onFilter = (key, value) => setFilter((f) => ({ ...f, [key]: value }));
  const clearAll = () => { setQ(""); setFilter({ session: null, host: null, status: null }); };
  const rows = useMemo(() => list.map((it, i) => ({ ...it, _key: it.request_id || `row-${i}`, _host: hostOf(it.url) })), [list]);
  const narrowed = rows.filter((it) => (
    (!filter.session || it.session_id === filter.session)
    && (!filter.host || it._host === filter.host)
    && (!filter.status || statusWords(it).includes(filter.status))
  ));
  const shown = filterByQuery(narrowed, q, (it) => [
    statusWords(it), provenance(it.source, serverKnown).label, it.url, it.session_id, fieldNames(it), it.reason, it.request_id,
  ]);

  // A proof screenshot opens straight in the full-size viewer; it is fetched on demand.
  const [unavailable, setUnavailable] = useState(() => new Set());
  const openShot = async (it) => {
    let d = null;
    try { d = await window.keeperHistory.screenshot(it.request_id); } catch { d = null; }
    if (d) view(d);
    else setUnavailable((s) => new Set(s).add(it._key));
  };

  return (
    <>
      <PageHeader
        icon={<HistoryIcon />}
        title="History"
        meta={`${list.length} request${list.length === 1 ? "" : "s"}`}
        actions={[{ key: "refresh", label: "Refresh", icon: <ReloadIcon />, onClick: () => window.keeperHistory.refresh() }]}
        filters={[
          searchFilter({ value: q, onChange: setQ, placeholder: "Search site, session, field, status…", width: 280 }),
          pickerFilter({ key: "status", label: "Status", value: filter.status, onChange: (v) => onFilter("status", v),
            options: distinctValues(rows.flatMap((it) => statusWords(it).map((w) => ({ w }))), (o) => o.w), placeholder: "Any status", width: 160 }),
          pickerFilter({ key: "host", label: "Site", value: filter.host, onChange: (v) => onFilter("host", v),
            options: distinctValues(rows, (it) => it._host), placeholder: "All sites", width: 220 }),
          pickerFilter({ key: "session", label: "Session", value: filter.session, onChange: (v) => onFilter("session", v),
            options: distinctValues(rows, (it) => it.session_id), placeholder: "All sessions", width: 180, mono: true }),
        ]}
      />
      <PageBody>
        <div className="page-wrap">
          <p className="page-intro">Everything on this account — this device and the service. Values are never stored.</p>
          {server.state === "loading" && <Message type="info">Loading the service's list…</Message>}
          {server.state === "error" && (
            <Message type="warning" showIcon>
              The service's list is unavailable ({server.error || "unreachable"}) — showing this device's records only.
            </Message>
          )}
          <FilterCount shown={shown.length} total={list.length} onClear={clearAll} />
          <div className="table-card">
            <ResponsiveTable
              data={shown}
              rowKey="_key"
              autoHeight
              wordWrap="break-word"
              defaultSortColumn="when"
              defaultSortType="desc"
              renderEmpty={() => <div className="table-empty muted">{list.length === 0 ? "No requests yet." : "No requests match this search."}</div>}
            >
              <Column width={120} sortable dataKey="when" sortValue={timeOf}>
                <HeaderCell>When</HeaderCell>
                <Cell>{(it) => (
                  <span className="muted small" title={`requested: ${fmtTime(it.requested_at)}\nresolved: ${fmtTime(it.resolved_at)}`}>
                    {relTime(it.resolved_at || it.requested_at)}
                  </span>
                )}</Cell>
              </Column>
              <Column width={230}>
                <HeaderCell>Status</HeaderCell>
                <Cell>{(it) => <StatusTags it={it} serverKnown={serverKnown} />}</Cell>
              </Column>
              <Column flexGrow={2} minWidth={220} sortable dataKey="site" sortValue={(it) => it._host || null}>
                <HeaderCell>Site</HeaderCell>
                <Cell>{(it) => (it.url ? (
                  <FilterChip
                    active={filter.host === it._host}
                    title={filter.host === it._host ? "Clear this filter" : `Show only ${it._host}`}
                    onClick={() => onFilter("host", filter.host === it._host ? null : it._host)}
                  >{shortUrl(it.url)}</FilterChip>
                ) : <span className="muted">—</span>)}</Cell>
              </Column>
              <Column width={170} sortable dataKey="session_id">
                <HeaderCell>Session</HeaderCell>
                <Cell>{(it) => (it.session_id ? (
                  <FilterChip
                    mono
                    active={filter.session === it.session_id}
                    title={filter.session === it.session_id ? "Clear this filter" : `Show only session ${it.session_id}`}
                    onClick={() => onFilter("session", filter.session === it.session_id ? null : it.session_id)}
                  >{it.session_id}</FilterChip>
                ) : <span className="muted">—</span>)}</Cell>
              </Column>
              <Column flexGrow={2} minWidth={200} mobileFull>
                <HeaderCell>Fields</HeaderCell>
                <Cell>{(it) => {
                  const names = fieldNames(it);
                  return (
                    <div className="cell-stack">
                      <span className="kv">{names.length ? names.join(", ") : <span className="muted">—</span>}</span>
                      {/* The note the user attached when declining — kept beside the request
                          instead of living only in whatever chat they explained themselves
                          in (issue #11). */}
                      {it.reason && <span className="kv"><span className="muted">declined: </span>{it.reason}</span>}
                    </div>
                  );
                }}</Cell>
              </Column>
              <Column width={130}>
                <HeaderCell>Screenshot</HeaderCell>
                <Cell>{(it) => ((it.local_screenshot || it.server_screenshot) ? (
                  <Button size="xs" appearance="subtle" disabled={unavailable.has(it._key)} onClick={() => openShot(it)}>
                    {unavailable.has(it._key) ? "Unavailable" : "View"}
                  </Button>
                ) : <span className="muted">—</span>)}</Cell>
              </Column>
            </ResponsiveTable>
          </div>
        </div>
      </PageBody>
    </>
  );
}
