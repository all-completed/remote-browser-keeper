// "Something changed in the headless-Keeper requests" — main's unlock:changed, registered
// once at module load so the Approvals page can mount and unmount without stacking a new
// IPC listener every time (issue #28: the page lives in a window that outlives it).
const subs = new Set();
if (typeof window !== "undefined" && window.keeperUnlock && window.keeperUnlock.onChanged) {
  window.keeperUnlock.onChanged(() => subs.forEach((fn) => fn()));
}
export function subscribeUnlock(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
