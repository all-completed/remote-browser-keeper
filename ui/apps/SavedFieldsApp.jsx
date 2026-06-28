import { useEffect, useState } from "react";

// Management window: lists field values the user saved on this machine and lets
// them forget any (or all). Only metadata is shown — the value itself is encrypted
// at rest and never displayed here, and never sent to the AI.
export default function SavedFieldsApp() {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type: "all" } | { type: "one", entry }

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
          <div id="sub">Values you chose to keep on this machine. They are encrypted at rest, never shown here, and never sent to the AI.</div>
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

        {loaded && items.length === 0 ? (
          <p id="empty">No saved fields.</p>
        ) : (
          <div id="list">
            {items.map((e, i) => (
              <div className="entry" key={(e.session || "") + "|" + e.host + "|" + e.selector + "|" + i}>
                <div className="top">
                  <span className={"badge " + (e.scope === "forever" ? "ok" : "warn")}>
                    {e.scope === "forever" ? "saved securely" : "until restart"}
                  </span>
                  {e.auto && <span className="badge">auto-fill</span>}
                  <button type="button" className="sf-btn" style={{ marginLeft: "auto" }} onClick={() => setConfirm({ type: "one", entry: e })}>Forget</button>
                </div>
                <div className="meta">
                  <span className="chip url" title={e.host}>{e.host}</span>
                  <span className="chip">session: {e.session || "—"}</span>
                </div>
                <div className="fields">
                  <span className="k">selector: </span>
                  {e.selector}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
