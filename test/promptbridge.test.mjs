// The prompt renderer's delivery bridge (ui/lib/promptBridge.js).
//
// Issue #3: the approval window opened blank because the request payload reached the
// renderer over exactly ONE path (a single push from main). These tests pin the fix —
// the request is delivered whether it is PUSHED or PULLED, and a push that already
// landed is never clobbered by the late pull.
//
// No DOM needed: the bridge only touches `window.keeper`, so a stub global is enough.
import test from "node:test";
import assert from "node:assert/strict";

const REQ = { request_id: "r1", fields: [{ selector: "#pw" }] };

// Fresh module instance per case (the bridge registers at module-load time).
async function loadBridge(keeper, tag) {
  globalThis.window = { keeper };
  try {
    return await import(`../ui/lib/promptBridge.js?case=${tag}`);
  } finally {
    delete globalThis.window;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("push path: onRequest delivers to subscribers", async () => {
  let push = null;
  const bridge = await loadBridge({ onRequest: (cb) => { push = cb; } }, "push");
  const seen = [];
  bridge.subscribe((r) => seen.push(r));
  push(REQ);
  assert.deepEqual(seen, [REQ]);
  assert.equal(bridge.getLatest(), REQ);
});

test("pull path: the request still arrives when the push never comes", async () => {
  const bridge = await loadBridge({
    onRequest: () => { /* main never pushes — the failure mode from issue #3 */ },
    pendingRequest: async () => REQ,
  }, "pull");
  const seen = [];
  bridge.subscribe((r) => seen.push(r));
  await tick();
  assert.deepEqual(seen, [REQ], "renderer must be able to fetch the request itself");
  assert.equal(bridge.getLatest(), REQ);
});

test("both paths: a push always wins over the pull, whichever order they land in", async () => {
  let push = null;
  const older = { request_id: "older" };
  const bridge = await loadBridge({
    onRequest: (cb) => { push = cb; },
    pendingRequest: async () => older,
  }, "both");
  const seen = [];
  bridge.subscribe((r) => seen.push(r));
  push(REQ);
  await tick();
  assert.equal(bridge.getLatest(), REQ, "the pull must not overwrite a pushed request");
  assert.equal(seen[seen.length - 1], REQ);
});

test("no pull bridge (older preload): push still works, nothing throws", async () => {
  let push = null;
  const bridge = await loadBridge({ onRequest: (cb) => { push = cb; } }, "nopull");
  const seen = [];
  bridge.subscribe((r) => seen.push(r));
  push(REQ);
  await tick();
  assert.deepEqual(seen, [REQ]);
});

test("a request that landed before the subscriber exists is replayed on subscribe", async () => {
  let push = null;
  const bridge = await loadBridge({ onRequest: (cb) => { push = cb; } }, "replay");
  push(REQ); // arrives before React mounts and subscribes
  const seen = [];
  bridge.subscribe((r) => seen.push(r));
  assert.deepEqual(seen, [REQ], "a late subscriber must still see the pending request");
});

test("a rejected pull is swallowed (main reports the failure instead)", async () => {
  const bridge = await loadBridge({
    onRequest: () => {},
    pendingRequest: async () => { throw new Error("ipc gone"); },
  }, "reject");
  await tick();
  assert.equal(bridge.getLatest(), null);
});

// Issue #28: the one window outlives every request, so the bridge must forget one that is
// over — a page that mounts later must not replay an answered request.
test("clear: an answered or dropped request is not replayed to a later subscriber", async () => {
  let push = null;
  let gone = null;
  const bridge = await loadBridge({
    onRequest: (cb) => { push = cb; },
    onRequestGone: (cb) => { gone = cb; },
  }, "clear");
  const seen = [];
  bridge.subscribe((r) => seen.push(r));
  push(REQ);
  bridge.clear("someone-else");            // a late "gone" for another request…
  assert.equal(bridge.getLatest(), REQ);   // …does not clear this one
  gone({ request_id: REQ.request_id });    // main dropped it (answered elsewhere / failed)
  assert.equal(bridge.getLatest(), null);
  assert.deepEqual(seen, [REQ, null], "subscribers hear it go");
  const late = [];
  bridge.subscribe((r) => late.push(r));
  assert.deepEqual(late, [], "nothing replayed");
});

test("expired: either side retiring a request is remembered per request_id", async () => {
  let expire = null;
  const bridge = await loadBridge({ onRequest: () => {}, onExpired: (cb) => { expire = cb; } }, "expired");
  const heard = [];
  bridge.subscribeExpired((id) => heard.push(id));
  expire({ request_id: "r1" });
  bridge.markExpired("r1");                // the countdown noticing too is not a second event
  assert.deepEqual(heard, ["r1"]);
  assert.equal(bridge.isExpired("r1"), true);
  assert.equal(bridge.isExpired("r2"), false);
});
