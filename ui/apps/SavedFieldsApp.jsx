import { useEffect, useState } from "react";
import { relTime, absTime } from "../lib/format.js";

// Management window: lists field values the user saved on this machine and lets
// them forget any (or all). Only metadata is shown — the value itself is encrypted
// at rest and never displayed here, and never sent to the AI.
export default function SavedFieldsApp() {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type: "all" } | { type: "one", entry }
  const [shown, setShown] = useState({}); // entryKey -> revealed value (in-memory only)
  // Click a host/session chip to narrow the list — local to this window, no refetch.
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
  const copy = (v) => { try { navigator.clipboard.writeText(v); } catch { /* ignore */ } };

  const refresh = async () => {
    let list = [];
    try { list = await window.savedFields.list(); } catch { /* ignore */ }
    setItems(Array.isArray(list) ? list : []);
    setLoaded(true);
  };

  useEffect(() => { refresh(); }, []);

  // Forgetting is destructive, so it's confirmed first (setConfirm) and only carried
  // out here on approval.
  const doForget = async () => {
    if (!confirm) return;
    try {
      if (confirm.type === "all") await window.savedFields.forgetAll();
      else {
        const e = confirm.entry;
        await window.savedFields.forget({ session: e.session, host: e.host, selector: e.selector });
      }
    } catch { /* ignore */ }
    setConfirm(null);
    refresh();
  };

  return (
    <>
      <div id="glow" />
      <main id="wrap">
        <header id="head">
          <div id="title">Saved fields</div>
          <div id="sub">Values you chose to keep. Encrypted at rest and never sent to the AI; shown only when you tap <b>Reveal</b>.</div>
          <div id="actions">
            <button type="button" className="sf-btn" onClick={refresh}>Refresh</button>
            {items.length > 0 && (
              <button type="button" className="sf-btn" onClick={() => setConfirm({ type: "all" })}>Forget all</button>
            )}
          </div>
        </header>

        {confirm && (
          <div className="confirm">
            <span className="confirm-msg">
              {confirm.type === "all"
                ? `Forget all ${items.length} saved field${items.length === 1 ? "" : "s"}? This can't be undone.`
                : `Forget the saved value for ${confirm.entry.host}? This can't be undone.`}
            </span>
            <div className="confirm-actions">
              <button type="button" className="sf-btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="sf-btn danger" onClick={doForget}>
                {confirm.type === "all" ? "Forget all" : "Forget"}
              </button>
            </div>
          </div>
        )}

        {activeFilter && (
          <div className="filterbar">
            <span>Filtered by</span>
            {filter.host !== null && <span className="chip active">{filter.host}</span>}
            {filter.session !== null && <span className="chip active">session: {filter.session || "—"}</span>}
            <button type="button" className="chip clear" onClick={() => setFilter({ session: null, host: null })}>Clear</button>
            <span className="count">{visible.length} of {items.length}</span>
          </div>
        )}
        {loaded && items.length === 0 ? (
          <p id="empty">No saved fields.</p>
        ) : visible.length === 0 ? (
          <p id="empty">No saved fields match this filter.</p>
        ) : (
          <div id="list">
            {visible.map((e, i) => (
              <div className="entry" key={(e.session || "") + "|" + e.host + "|" + e.selector + "|" + i}>
                <div className="top">
                  <span className={"badge " + (e.scope === "warn-never" ? "warn" : e.scope === "session" ? "warn" : "ok")}>
                    {e.scope === "vault" ? "vault · synced" : e.scope === "forever" ? "saved securely" : "until restart"}
                  </span>
                  {e.auto && <span className="badge">auto-fill</span>}
                  <button type="button" className="sf-btn" style={{ marginLeft: "auto" }} onClick={() => toggleReveal(e)}>
                    {shown[keyOf(e)] != null ? "Hide" : "Reveal"}
                  </button>
                  <button type="button" className="sf-btn" onClick={() => setConfirm({ type: "one", entry: e })}>Forget</button>
                </div>
                <div className="meta">
                  <button
                    type="button"
                    className={"chip url chip-filter" + (filter.host === e.host ? " active" : "")}
                    title={filter.host === e.host ? "Clear this filter" : `Show only ${e.host}`}
                    onClick={() => onFilter("host", filter.host === e.host ? null : e.host)}
                  >{e.host}</button>
                  <button
                    type="button"
                    className={"chip chip-filter" + (filter.session === (e.session || "") ? " active" : "")}
                    title={filter.session === (e.session || "") ? "Clear this filter" : `Show only session ${e.session || "—"}`}
                    onClick={() => onFilter("session", filter.session === (e.session || "") ? null : (e.session || ""))}
                  >session: {e.session || "—"}</button>
                  {e.updated_at && (
                    <span className="chip time" title={absTime(e.updated_at)}>{relTime(e.updated_at)}</span>
                  )}
                </div>
                <div className="fields">
                  <span className="k">selector: </span>
                  {e.selector}
                </div>
                {shown[keyOf(e)] != null && (
                  <div className="fields" style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span className="k">value: </span>
                    <code style={{ userSelect: "all", wordBreak: "break-all", background: "rgba(255,255,255,.06)", padding: "2px 6px", borderRadius: 5 }}>{shown[keyOf(e)]}</code>
                    <button type="button" className="sf-btn" onClick={() => copy(shown[keyOf(e)])}>Copy</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
