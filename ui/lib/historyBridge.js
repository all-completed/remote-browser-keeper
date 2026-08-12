// Register keeperHistory.onData at module load so the first payload isn't missed.
// Payload shape: { items, server } — `items` is the merged local+server list
// (src/historymerge.js), `server` is { state: "loading" | "ok" | "error", ... } so the
// window can say so when the service list is missing instead of silently showing half
// the history. Main pushes twice per refresh: local-only first, then the union.
let latest = null;
const subs = new Set();
if (typeof window !== "undefined" && window.keeperHistory && window.keeperHistory.onData) {
  window.keeperHistory.onData((payload) => { latest = payload; subs.forEach((fn) => fn(payload)); });
}
export const getLatest = () => latest;
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
