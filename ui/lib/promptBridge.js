// The fill request on screen, delivered to the approval window (issue #34). Registered at module-load
// time (before React mounts) so a fill_request that arrives during/after window show is
// never missed.
//
// Since the Keeper became one window (issue #28) the same document outlives every request,
// so the bridge also forgets: main says when the request on screen is gone (answered
// elsewhere, failed, expired) and the page clears it when the user answers — a later mount
// must never replay a request that is already over.
let latest = null;
const subs = new Set();
const expired = new Set(); // request_ids main or the countdown retired (issue #12)
const expiredSubs = new Set();

function deliver(req) {
  if (!req) return;
  latest = req;
  subs.forEach((fn) => fn(req));
}

if (typeof window !== "undefined" && window.keeper && window.keeper.onRequest) {
  window.keeper.onRequest(deliver);
}
if (typeof window !== "undefined" && window.keeper && window.keeper.onRequestGone) {
  window.keeper.onRequestGone((m) => clear(m && m.request_id));
}
if (typeof window !== "undefined" && window.keeper && window.keeper.onExpired) {
  window.keeper.onExpired((m) => markExpired(m && m.request_id));
}

// …and ask for it as well. Push and pull are each sufficient on their own; together, no
// single missed event can leave the window with nothing to draw (issue #3: the approval
// window opened blank because the one push it depended on never reached the renderer).
// A push that already landed wins — the pull result is only used if nothing arrived.
if (typeof window !== "undefined" && window.keeper && window.keeper.pendingRequest) {
  Promise.resolve(window.keeper.pendingRequest())
    .then((req) => { if (req && !latest) deliver(req); })
    .catch(() => { /* main will report the failure; the watchdog covers us */ });
}

export function getLatest() { return latest; }
// Replay on subscribe: the request can land before React mounts (it is pushed at load
// time and pulled a microtask later), and a subscriber that missed it would render an
// empty window forever.
export function subscribe(fn) {
  subs.add(fn);
  if (latest) fn(latest);
  return () => subs.delete(fn);
}
// Drop the request on screen (only if it is still `requestId`, so a late "gone" for an
// older request cannot clear a newer one). Subscribers hear `null`.
export function clear(requestId) {
  if (!latest || (requestId != null && latest.request_id !== requestId)) return;
  latest = null;
  subs.forEach((fn) => fn(null));
}

export function markExpired(requestId) {
  if (!requestId || expired.has(requestId)) return;
  expired.add(requestId);
  expiredSubs.forEach((fn) => fn(requestId));
}
export function isExpired(requestId) { return expired.has(requestId); }
export function subscribeExpired(fn) {
  expiredSubs.add(fn);
  return () => expiredSubs.delete(fn);
}
