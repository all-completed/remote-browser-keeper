// Register the keeper onRequest listener at module-load time (before React mounts)
// so a fill_request that arrives during/after window show is never missed.
let latest = null;
const subs = new Set();

if (typeof window !== "undefined" && window.keeper && window.keeper.onRequest) {
  window.keeper.onRequest((req) => {
    latest = req;
    subs.forEach((fn) => fn(req));
  });
}

export function getLatest() { return latest; }
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
