// The fill-request deadline: src/deadline.js (reading it off the frame) and the
// countdown helpers in ui/lib/format.js (turning it into what the prompt shows).
//
// Issue #12: a pending request showed no time left, and the naive fix — start a 5:00 timer
// when the frame arrives — is a lie, because the service replays the SAME frame to a keeper
// that reconnects. These tests pin both halves of the rule: the remaining time comes from
// an ABSOLUTE deadline, and a frame without one gets no countdown rather than an invented
// one.
import test from "node:test";
import assert from "node:assert/strict";
import { requestDeadline } from "../src/deadline.js";
import { formatRemaining, remainingMs } from "../ui/lib/format.js";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const frame = (extra) => ({ type: "fill_request", request_id: "r1", session_id: "s1", ...extra });

test("expires_at is taken as-is, in every shape the service could send it", () => {
  const at = NOW + 300_000;
  assert.equal(requestDeadline(frame({ expires_at: new Date(at).toISOString() }), NOW), at);
  assert.equal(requestDeadline(frame({ expires_at: at }), NOW), at);              // epoch millis
  assert.equal(requestDeadline(frame({ expires_at: at / 1000 }), NOW), at);       // epoch seconds
  assert.equal(requestDeadline(frame({ deadline: at }), NOW), at);                // alias
});

test("created_at + timeout_s is an absolute deadline too (the server's own stamp)", () => {
  const created = NOW - 60_000;
  assert.equal(
    requestDeadline(frame({ created_at: created / 1000, timeout_s: 300 }), NOW),
    created + 300_000,
  );
  // …and it must not be built from a partial pair.
  assert.equal(requestDeadline(frame({ timeout_s: 300 }), NOW), null);
  assert.equal(requestDeadline(frame({ created_at: created / 1000 }), NOW), null);
});

test("a purely relative field is refused — it is stale the moment the frame is replayed", () => {
  // This is the failure the issue calls out: a phone woken by a push receives the SAME
  // frame with, say, 30s actually left. Honouring expires_in/ttl would show it 5:00.
  assert.equal(requestDeadline(frame({ expires_in: 300 }), NOW), null);
  assert.equal(requestDeadline(frame({ ttl: 300 }), NOW), null);
  assert.equal(requestDeadline(frame({ timeout: 300 }), NOW), null); // no created_at to anchor it
});

test("today's frame carries no deadline at all — that stays unknown, never guessed", () => {
  // The exact payload the service sends now (docs/keeper-protocol.md §1).
  const real = frame({
    url: "https://web.telegram.org/k/",
    message: "Logging in",
    screenshot: "data:image/jpeg;base64,AAAA",
    fields: [{ selector: "#password", label: "Password", field: "password" }],
  });
  assert.equal(requestDeadline(real, NOW), null);
});

test("a deadline already in the past is reported, not clamped away", () => {
  // "Already over" and "not known" must stay distinguishable: the first drops the request,
  // the second shows a prompt with no countdown.
  const at = NOW - 1000;
  assert.equal(requestDeadline(frame({ expires_at: at }), NOW), at);
});

test("junk and implausible values are treated as no deadline", () => {
  assert.equal(requestDeadline(null, NOW), null);
  assert.equal(requestDeadline("nope", NOW), null);
  assert.equal(requestDeadline(frame({ expires_at: "not a date" }), NOW), null);
  assert.equal(requestDeadline(frame({ expires_at: "" }), NOW), null);
  assert.equal(requestDeadline(frame({ expires_at: NOW + 48 * 3600 * 1000 }), NOW), null); // runaway
  assert.equal(requestDeadline(frame({ created_at: NOW / 1000, timeout_s: -5 }), NOW), null);
});

test("remaining time is measured from the deadline, and never goes negative", () => {
  assert.equal(remainingMs(NOW + 90_000, NOW), 90_000);
  assert.equal(remainingMs(NOW - 90_000, NOW), 0); // expired, not "-1:30"
  assert.equal(remainingMs(null, NOW), null);      // no deadline → nothing to show
  assert.equal(remainingMs(undefined, NOW), null);
});

test("the same deadline reads correctly however long the frame has been sitting around", () => {
  // The replay case, stated as arithmetic: one absolute deadline, two arrival times.
  const at = NOW + 30_000;
  assert.equal(formatRemaining(remainingMs(at, NOW)), "0:30");
  assert.equal(formatRemaining(remainingMs(at, NOW + 25_000)), "0:05"); // reconnect, 5s left
});

test("the label rounds up, so 0:00 means the time really is gone", () => {
  assert.equal(formatRemaining(300_000), "5:00");
  assert.equal(formatRemaining(59_400), "1:00");  // 59.4s is still a minute on the clock face
  assert.equal(formatRemaining(6_200), "0:07");
  assert.equal(formatRemaining(0), "0:00");
  assert.equal(formatRemaining(-5_000), "0:00");
  assert.equal(formatRemaining(3_723_000), "1:02:03");
});
