// The window's own state from main: which page to show (app:navigate) and the connection
// and queue state the sidebar and the Approvals page show (app:status). Registered at
// module load so nothing pushed before React mounts is lost; app:state is pulled as well.
let page = null;
let status = null;
const pageSubs = new Set();
const statusSubs = new Set();
const k = typeof window !== "undefined" ? window.keeperApp : null;

function setPage(p) { if (!p) return; page = p; pageSubs.forEach((fn) => fn(p)); }
function setStatus(s) { if (!s) return; status = s; statusSubs.forEach((fn) => fn(s)); }

if (k && k.onNavigate) k.onNavigate(setPage);
if (k && k.onStatus) k.onStatus(setStatus);
if (k && k.state) {
  Promise.resolve(k.state())
    .then((s) => { if (!s) return; if (!page) setPage(s.page); if (!status) setStatus(s.status); })
    .catch(() => { /* pushed on load anyway */ });
}

export const getPage = () => page;
export const getStatus = () => status;
export function subscribePage(fn) { pageSubs.add(fn); return () => pageSubs.delete(fn); }
export function subscribeStatus(fn) { statusSubs.add(fn); if (status) fn(status); return () => statusSubs.delete(fn); }
export function reportPage(p) { try { k && k.page && k.page(p); } catch { /* ignore */ } }
export function dismiss(what) { try { k && k.dismiss && k.dismiss(what); } catch { /* ignore */ } }
