import { useEffect, useState } from "react";

// Management window: lists field values the user saved on this machine and lets
// them forget any (or all). Only metadata is shown — the value itself is encrypted
// at rest and never displayed here, and never sent to the AI.
export default function SavedFieldsApp() {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    let list = [];
    try { list = await window.savedFields.list(); } catch { /* ignore */ }
    setItems(Array.isArray(list) ? list : []);
    setLoaded(true);
  };

  useEffect(() => { refresh(); }, []);

  const forget = async (e) => {
    try { await window.savedFields.forget({ session: e.session, host: e.host, selector: e.selector }); } catch { /* ignore */ }
    refresh();
  };

  const forgetAll = async () => {
    try { await window.savedFields.forgetAll(); } catch { /* ignore */ }
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
            <button id="refresh" type="button" onClick={refresh}>Refresh</button>
            {items.length > 0 && <button type="button" className="shot-btn" onClick={forgetAll}>Forget all</button>}
          </div>
        </header>
        {loaded && items.length === 0 ? (
          <p id="empty">No saved fields.</p>
        ) : (
          <div id="list">
            {items.map((e, i) => (
              <div className="entry" key={(e.session || "") + "|" + e.host + "|" + e.selector + "|" + i}>
                <div className="top">
                  <span className={"badge " + (e.scope === "forever" ? "ok" : "no")}>
                    {e.scope === "forever" ? "saved securely" : "until restart"}
                  </span>
                  {e.auto && <span className="badge">auto-fill</span>}
                  <button type="button" className="shot-btn" style={{ marginLeft: "auto" }} onClick={() => forget(e)}>Forget</button>
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
