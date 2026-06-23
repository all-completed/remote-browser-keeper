// Register keeperHistory.onData at module load so the first payload isn't missed.
let latest = null;
const subs = new Set();
if (typeof window !== "undefined" && window.keeperHistory && window.keeperHistory.onData) {
  window.keeperHistory.onData((items) => { latest = items; subs.forEach((fn) => fn(items)); });
}
export const getLatest = () => latest;
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
