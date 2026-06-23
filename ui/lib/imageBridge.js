// Register imageView.onData at module load so the data URL isn't missed.
let latest = null;
const subs = new Set();
if (typeof window !== "undefined" && window.imageView && window.imageView.onData) {
  window.imageView.onData((d) => { latest = d; subs.forEach((fn) => fn(d)); });
}
export const getLatest = () => latest;
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
