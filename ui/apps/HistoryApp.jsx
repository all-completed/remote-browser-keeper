import { useEffect, useState } from "react";
import { shortUrl, relTime } from "../lib/format.js";
import { getLatest, subscribe } from "../lib/historyBridge.js";

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return ""; }
}

// Colour for a status word from EITHER vocabulary — local outcomes
// (submitted/cancelled/autofilled/ui_failed) and server statuses
// (pending/filled/cancelled/timeout/no_keeper/error) share one scale.
const OK = new Set(["submitted", "autofilled", "filled"]);
const WARN = new Set(["pending", "timeout", "no_keeper"]);
const badgeClass = (v) => (OK.has(v) ? "ok" : WARN.has(v) ? "warn" : "no");

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

function HistoryEntry({ it, filter, onFilter, serverKnown }) {
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
    <div className="entry">
      <div className="top">
        {badges.map(({ src, v }) => (
          <span key={src || "only"} className={"badge " + badgeClass(v)}>
            {src ? <span className="badge-src">{src}: </span> : null}{v}
          </span>
        ))}
        <span className={"chip source " + it.source} title={prov.title}>{prov.label}</span>
        <span className="time" title={`requested: ${fmtTime(it.requested_at)}\nresolved: ${fmtTime(it.resolved_at)}`}>
          {relTime(it.resolved_at || it.requested_at)}
        </span>
      </div>
      {(it.session_id || it.url) && (
        <div className="meta">
          {it.session_id && (
            <button
              type="button"
              className={"chip chip-filter" + (filter.session === it.session_id ? " active" : "")}
              title={filter.session === it.session_id ? "Clear this filter" : `Show only session ${it.session_id}`}
              onClick={() => onFilter("session", filter.session === it.session_id ? null : it.session_id)}
            >session: {it.session_id}</button>
          )}
          {it.url && (
            <button
              type="button"
              className={"chip url chip-filter" + (filter.host === hostOf(it.url) ? " active" : "")}
              title={filter.host === hostOf(it.url) ? "Clear this filter" : `Show only ${hostOf(it.url)}`}
              onClick={() => onFilter("host", filter.host === hostOf(it.url) ? null : hostOf(it.url))}
            >{shortUrl(it.url)}</button>
          )}
        </div>
      )}
      {names.length > 0 && (
        <div className="fields">
          <span className="k">{names.length === 1 ? "field: " : `${names.length} fields: `}</span>
          {names.join(", ")}
        </div>
      )}
      {hasShot && (
        <>
          <button type="button" className="shot-btn" disabled={unavailable} onClick={toggle}>
            {unavailable ? "Screenshot unavailable" : shown ? "Hide screenshot" : "View screenshot"}
          </button>
          {shown && data && (
            <figure className="shot">
              <img
                src={data}
                title="Click to enlarge"
                onClick={() => { if (/^data:image\//.test(data)) window.keeperHistory.viewImage(data); }}
              />
            </figure>
          )}
        </>
      )}
    </div>
  );
}

export default function HistoryApp() {
  const [payload, setPayload] = useState(getLatest());
  useEffect(() => subscribe(setPayload), []);
  const list = Array.isArray(payload && payload.items) ? payload.items : [];
  const server = (payload && payload.server) || { state: "loading" };
  const serverKnown = server.state === "ok";
  // Click a session/host chip to narrow the list. Purely local to this window —
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
      <div id="glow" />
      <main id="wrap">
        <header id="head">
          <div id="title">Request history</div>
          <div id="sub">Everything on this account — this device and the service — values are never stored.</div>
          <div id="actions">
            <button id="refresh" type="button" onClick={() => window.keeperHistory.refresh()}>Refresh</button>
          </div>
        </header>
        {server.state === "loading" && <div className="notice">Loading the service's list…</div>}
        {server.state === "error" && (
          <div className="notice warn">
            The service's list is unavailable ({server.error || "unreachable"}) — showing this device's records only.
          </div>
        )}
        {active && (
          <div className="filterbar">
            <span>Filtered by</span>
            {filter.session && <span className="chip active">session: {filter.session}</span>}
            {filter.host && <span className="chip active">{filter.host}</span>}
            <button type="button" className="chip clear" onClick={() => setFilter({ session: null, host: null })}>Clear</button>
            <span className="count">{shown.length} of {list.length}</span>
          </div>
        )}
        {list.length === 0 ? (
          <p id="empty">No requests yet.</p>
        ) : shown.length === 0 ? (
          <p id="empty">No requests match this filter.</p>
        ) : (
          <div id="list">
            {shown.map((it, i) => (
              <HistoryEntry key={it.request_id || i} it={it} filter={filter} onFilter={onFilter} serverKnown={serverKnown} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
