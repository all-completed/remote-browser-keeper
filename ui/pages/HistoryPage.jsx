import { useEffect, useState } from "react";
import { Button, Message, Panel, Tag } from "rsuite";
import HistoryIcon from "@rsuite/icons/History";
import { PageBody, PageHeader } from "@f-proj/ui-components";
import { shortUrl, relTime } from "../lib/format.js";
import { getLatest, subscribe } from "../lib/historyBridge.js";
import { useImageViewer } from "../components/ImageViewer.jsx";

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

// A session / host chip that narrows the list to it (and clears the filter when active).
function FilterChip({ active, title, onClick, children, mono }) {
  return (
    <Button size="xs" appearance={active ? "primary" : "ghost"} title={title} onClick={onClick} className={mono ? "mono" : undefined}>
      {children}
    </Button>
  );
}

function HistoryEntry({ it, filter, onFilter, serverKnown }) {
  const view = useImageViewer();
  const [shown, setShown] = useState(false);
  const [data, setData] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const fields = Array.isArray(it.fields) ? it.fields : [];
  const names = fields.map((f) => f.label || f.field || f.selector || "field");
  const prov = provenance(it.source, serverKnown);
  // When the two sides disagree on the same request_id, both are shown, labelled —
  // picking one would hide either what the service did or what this device did.
  const badges = it.disagree
    ? [{ src: "client", v: it.outcome }, { src: "server", v: it.status }]
    : [{ src: null, v: it.effective || "unknown" }];
  const hasShot = it.local_screenshot || it.server_screenshot;

  const toggle = async () => {
    if (shown) { setShown(false); return; }
    let d = data;
    if (!d) {
      d = await window.keeperHistory.screenshot(it.request_id);
      if (!d) { setUnavailable(true); return; }
      setData(d);
    }
    setShown(true);
  };

  return (
    <Panel bordered className="entry">
      <div className="chips">
        {badges.map(({ src, v }) => (
          <Tag key={src || "only"} size="sm" color={badgeColor(v)}>
            {src ? <span className="badge-src">{src}: </span> : null}{v}
          </Tag>
        ))}
        <Tag size="sm" title={prov.title}>{prov.label}</Tag>
        <span className="muted small push" title={`requested: ${fmtTime(it.requested_at)}\nresolved: ${fmtTime(it.resolved_at)}`}>
          {relTime(it.resolved_at || it.requested_at)}
        </span>
      </div>
      {(it.session_id || it.url) && (
        <div className="chips">
          {it.session_id && (
            <FilterChip
              mono
              active={filter.session === it.session_id}
              title={filter.session === it.session_id ? "Clear this filter" : `Show only session ${it.session_id}`}
              onClick={() => onFilter("session", filter.session === it.session_id ? null : it.session_id)}
            >session: {it.session_id}</FilterChip>
          )}
          {it.url && (
            <FilterChip
              active={filter.host === hostOf(it.url)}
              title={filter.host === hostOf(it.url) ? "Clear this filter" : `Show only ${hostOf(it.url)}`}
              onClick={() => onFilter("host", filter.host === hostOf(it.url) ? null : hostOf(it.url))}
            >{shortUrl(it.url)}</FilterChip>
          )}
        </div>
      )}
      {names.length > 0 && (
        <div className="kv">
          <span className="muted">{names.length === 1 ? "field: " : `${names.length} fields: `}</span>
          {names.join(", ")}
        </div>
      )}
      {/* The note the user attached when declining — kept beside the request instead of
          living only in whatever chat they explained themselves in (issue #11). */}
      {it.reason && (
        <div className="kv">
          <span className="muted">declined: </span>
          {it.reason}
        </div>
      )}
      {hasShot && (
        <>
          <Button size="xs" appearance="subtle" disabled={unavailable} onClick={toggle}>
            {unavailable ? "Screenshot unavailable" : shown ? "Hide screenshot" : "View screenshot"}
          </Button>
          {shown && data && (
            <figure className="shot">
              <img src={data} title="Click to enlarge" onClick={() => view(data)} />
            </figure>
          )}
        </>
      )}
    </Panel>
  );
}

export default function HistoryPage() {
  const [payload, setPayload] = useState(getLatest());
  useEffect(() => subscribe(setPayload), []);
  // Ask for a fresh list every time the page opens: main paints the local log at once and
  // repaints with the service's when it lands (src/main.js sendHistory).
  useEffect(() => { try { window.keeperHistory.refresh(); } catch { /* ignore */ } }, []);
  const list = Array.isArray(payload && payload.items) ? payload.items : [];
  const server = (payload && payload.server) || { state: "loading" };
  const serverKnown = server.state === "ok";
  // Click a session/host chip to narrow the list. Purely local to this page —
  // no refetch, the history is already in memory.
  const [filter, setFilter] = useState({ session: null, host: null });
  const onFilter = (key, value) => setFilter((f) => ({ ...f, [key]: value }));
  const active = filter.session || filter.host;
  const shown = list.filter((it) => (
    (!filter.session || it.session_id === filter.session)
    && (!filter.host || hostOf(it.url) === filter.host)
  ));

  return (
    <>
      <PageHeader icon={<HistoryIcon />} title="History" meta={`${list.length} request${list.length === 1 ? "" : "s"}`}>
        <Button size="sm" onClick={() => window.keeperHistory.refresh()}>Refresh</Button>
      </PageHeader>
      <PageBody>
        <div className="page-col">
          <p className="muted">Everything on this account — this device and the service. Values are never stored.</p>
          {server.state === "loading" && <Message type="info">Loading the service's list…</Message>}
          {server.state === "error" && (
            <Message type="warning" showIcon>
              The service's list is unavailable ({server.error || "unreachable"}) — showing this device's records only.
            </Message>
          )}
          {active && (
            <div className="chips">
              <span className="muted">Filtered by</span>
              {filter.session && <Tag size="sm" color="blue">session: {filter.session}</Tag>}
              {filter.host && <Tag size="sm" color="blue">{filter.host}</Tag>}
              <Button size="xs" appearance="link" onClick={() => setFilter({ session: null, host: null })}>Clear</Button>
              <span className="muted small push">{shown.length} of {list.length}</span>
            </div>
          )}
          {list.length === 0 ? (
            <p className="empty-title">No requests yet.</p>
          ) : shown.length === 0 ? (
            <p className="empty-title">No requests match this filter.</p>
          ) : (
            <div className="list">
              {shown.map((it, i) => (
                <HistoryEntry key={it.request_id || i} it={it} filter={filter} onFilter={onFilter} serverKnown={serverKnown} />
              ))}
            </div>
          )}
        </div>
      </PageBody>
    </>
  );
}
