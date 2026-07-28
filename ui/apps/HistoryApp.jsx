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

function HistoryEntry({ it, filter, onFilter }) {
  const [shown, setShown] = useState(false);
  const [data, setData] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const outcome = it.outcome || "unknown";
  const fields = Array.isArray(it.fields) ? it.fields : [];
  const names = fields.map((f) => f.label || f.field || f.selector || "field");

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
        <span className={"badge " + (outcome === "submitted" || outcome === "autofilled" ? "ok" : "no")}>{outcome}</span>
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
      {it.screenshot && (
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
  const [items, setItems] = useState(getLatest());
  useEffect(() => subscribe(setItems), []);
  const list = Array.isArray(items) ? items : [];
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
          <div id="sub">What was requested and when — values are never stored.</div>
          <div id="actions">
            <button id="refresh" type="button" onClick={() => window.keeperHistory.refresh()}>Refresh</button>
          </div>
        </header>
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
              <HistoryEntry key={it.request_id || i} it={it} filter={filter} onFilter={onFilter} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
