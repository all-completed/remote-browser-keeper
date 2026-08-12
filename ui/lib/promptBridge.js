// Register the keeper onRequest listener at module-load time (before React mounts)
// so a fill_request that arrives during/after window show is never missed.
let latest = null;
const subs = new Set();

function deliver(req) {
  if (!req) return;
  latest = req;
  subs.forEach((fn) => fn(req));
}

if (typeof window !== "undefined" && window.keeper && window.keeper.onRequest) {
  window.keeper.onRequest(deliver);
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
