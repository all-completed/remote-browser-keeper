// The answer outbox: src/outbox.js.
//
// Issue #19: a fill/secret answer went out through a send that silently no-ops on a socket
// that is not OPEN, so a password typed during a reconnect vanished and the agent was told
// the user never answered. These tests pin the replacement rule: an answer is held and
// re-sent when the link returns, and one that can never be delivered is REPORTED to the
// caller — the one thing it is never allowed to be is silent.
import test from "node:test";
import assert from "node:assert/strict";
import { createOutbox, DEFAULT_MAX_AGE_MS } from "../src/outbox.js";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const answer = (id, extra) => ({ type: "fill_response", request_id: id, values: [{ selector: "#pw", value: "s3cret" }], ...extra });

// A socket whose state the test drives: `up` decides whether a frame leaves, `budget` how
// many more it will take (so a link can die mid-flush), and every frame that does leave is
// recorded so "what actually reached the service" can be asserted.
function fakeLink({ up = true } = {}) {
  const link = { up, wire: [], budget: Infinity };
  link.send = (frame) => {
    if (!link.up || link.budget <= 0) return false;
    link.budget -= 1;
    link.wire.push(frame);
    return true;
  };
  return link;
}

// A clock the test moves by hand — the outbox never calls Date.now() itself.
function fakeClock(t = NOW) {
  const clock = { t, now: () => clock.t, advance: (ms) => (clock.t += ms) };
  return clock;
}

test("connected: the answer goes straight out and nothing is held", () => {
  const link = fakeLink();
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });

  const frame = answer("r1");
  const r = box.deliver(frame, { expiresAt: NOW + 300_000 });

  assert.equal(r.sent, true);
  assert.deepEqual(r.evicted, []);
  assert.deepEqual(link.wire, [frame], "the frame goes on the wire byte-for-byte");
  assert.equal(box.size(), 0, "nothing to hold once it is delivered");
});

test("link down: the answer is held, and delivered on reconnect", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });

  const frame = answer("r1");
  const r = box.deliver(frame, { expiresAt: NOW + 300_000 });
  assert.equal(r.sent, false, "it did not go out...");
  assert.deepEqual(r.evicted, [], "...but it was NOT dropped either");
  assert.deepEqual(link.wire, []);
  assert.equal(box.size(), 1);

  clock.advance(8000); // a reconnect backoff step later
  link.up = true;
  const f = box.flush();

  assert.deepEqual(link.wire, [frame], "the value the user typed reaches the service");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.evicted, []);
  assert.equal(box.size(), 0);
});

test("held answers keep their order, and a link that dies mid-flush keeps the rest", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  for (const id of ["r1", "r2", "r3"]) box.deliver(answer(id), { expiresAt: NOW + 300_000 });

  // The link comes back just long enough for one frame, then dies again.
  link.up = true;
  link.budget = 1;
  const f = box.flush();

  assert.deepEqual(link.wire.map((x) => x.request_id), ["r1"], "oldest answer first");
  assert.equal(f.sent.length, 1);
  assert.equal(box.size(), 2, "the rest stay queued rather than being skipped past");

  link.budget = Infinity;
  box.flush();
  assert.deepEqual(link.wire.map((x) => x.request_id), ["r1", "r2", "r3"], "in the order they were given");
});

test("the request's own deadline passes while down: reported, and never put on the wire", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  const req = { request_id: "r1" };
  box.deliver(answer("r1"), { expiresAt: NOW + 60_000, meta: req });

  clock.advance(59_000);
  assert.deepEqual(box.flush().evicted, [], "still answerable — keep holding it");

  clock.advance(2000); // deadline passed: the service has already called it a timeout
  link.up = true;      // even with the link back...
  const f = box.flush();

  assert.equal(f.sent.length, 0);
  assert.deepEqual(link.wire, [], "no secret goes out for a request nobody is waiting on");
  assert.equal(f.evicted.length, 1);
  assert.equal(f.evicted[0].why, "expired");
  assert.equal(f.evicted[0].requestId, "r1");
  assert.equal(f.evicted[0].meta, req, "the caller gets what it needs to record the failure");
  assert.equal(box.size(), 0, "and the values stop being held");
});

test("a still-offline flush is what reports the expiry (not some later reconnect)", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  box.deliver(answer("r1"), { expiresAt: NOW + 1000 });

  clock.advance(1000); // exactly at the deadline: it is over
  const f = box.flush();
  assert.equal(f.evicted.length, 1, "the report does not wait for a connection that may never come");
  assert.equal(f.evicted[0].why, "expired");
});

test("no deadline on the frame: held for the default, then given up on", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  box.deliver(answer("r1"), {}); // frame carried no deadline (deadline.js returns null)

  clock.advance(DEFAULT_MAX_AGE_MS - 1);
  assert.equal(box.flush().evicted.length, 0);
  clock.advance(1);
  assert.equal(box.flush().evicted[0].why, "expired", "an unbounded hold on a secret is not a retry");
});

test("a deadline further out than the cap does not extend the hold", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  box.deliver(answer("r1"), { expiresAt: NOW + 24 * 3600 * 1000 });

  clock.advance(DEFAULT_MAX_AGE_MS);
  assert.equal(box.flush().evicted[0].why, "expired", "values are not kept in memory for hours");
});

test("one answer per request: a later answer replaces a queued one, silently", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });

  box.deliver(answer("r1"), { expiresAt: NOW + 300_000 });
  const corrected = answer("r1", { values: [{ selector: "#pw", value: "corrected" }] });
  const r = box.deliver(corrected, { expiresAt: NOW + 300_000 });

  assert.deepEqual(r.evicted, [], "superseding our own answer is not a delivery failure");
  assert.equal(box.size(), 1);
  link.up = true;
  box.flush();
  assert.deepEqual(link.wire, [corrected], "the service is told once, and told the newest thing");
});

test("has(): a replayed request is recognised as already answered, until it is delivered", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  box.deliver(answer("r1"), { expiresAt: NOW + 300_000 });

  assert.equal(box.has("r1"), true, "main.js must not prompt the user a second time for it");
  assert.equal(box.has("other"), false);
  link.up = true;
  box.flush();
  assert.equal(box.has("r1"), false);
});

test("drop(): an answer resolved elsewhere is forgotten without being reported", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  box.deliver(answer("r1"), { expiresAt: NOW + 300_000 });

  assert.equal(box.drop("r1").requestId, "r1");
  assert.equal(box.drop("r1"), null, "dropping twice is a no-op");
  assert.equal(box.size(), 0);
  link.up = true;
  assert.deepEqual(box.flush(), { sent: [], evicted: [] }, "nobody is waiting: no send, no failure");
});

test("overflow evicts the oldest — and says so rather than quietly forgetting it", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now, max: 2 });
  box.deliver(answer("r1"), { expiresAt: NOW + 300_000 });
  box.deliver(answer("r2"), { expiresAt: NOW + 300_000 });
  const r = box.deliver(answer("r3"), { expiresAt: NOW + 300_000 });

  assert.equal(r.evicted.length, 1);
  assert.equal(r.evicted[0].requestId, "r1");
  assert.equal(r.evicted[0].why, "overflow");
  assert.equal(box.size(), 2);
});

test("a send that throws is a send that did not happen", () => {
  const clock = fakeClock();
  let boom = true;
  const box = createOutbox({ send: () => { if (boom) throw new Error("socket closed"); return true; }, now: clock.now });

  const r = box.deliver(answer("r1"), { expiresAt: NOW + 300_000 });
  assert.equal(r.sent, false);
  assert.equal(box.size(), 1, "the answer survives the exception");
  boom = false;
  assert.equal(box.flush().sent.length, 1);
});

test("secret answers are held on the same terms as fill answers", () => {
  const link = fakeLink({ up: false });
  const clock = fakeClock();
  const box = createOutbox({ send: link.send, now: clock.now });
  const frame = { type: "secret_response", request_id: "s1", secret: "sess-key", grant: "once" };

  assert.equal(box.deliver(frame, {}).sent, false);
  link.up = true;
  box.flush();
  assert.deepEqual(link.wire, [frame]);
});
