import { useEffect, useState } from "react";
import { shortUrl } from "../lib/format.js";
import { getLatest, subscribe } from "../lib/historyBridge.js";

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function HistoryEntry({ it }) {
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
        <span className={"badge " + (outcome === "submitted" ? "ok" : "no")}>{outcome}</span>
        <span className="time" title={`requested: ${fmtTime(it.requested_at)}\nresolved: ${fmtTime(it.resolved_at)}`}>
          {fmtTime(it.resolved_at || it.requested_at)}
        </span>
      </div>
      {(it.session_id || it.url) && (
        <div className="meta">
          {it.session_id && <span className="chip">session: {it.session_id}</span>}
          {it.url && <span className="chip url" title={it.url}>{shortUrl(it.url)}</span>}
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
        {list.length === 0 ? (
          <p id="empty">No requests yet.</p>
        ) : (
          <div id="list">{list.map((it, i) => <HistoryEntry key={it.request_id || i} it={it} />)}</div>
        )}
      </main>
    </>
  );
}
