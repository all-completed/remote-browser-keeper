// Answers that could not be put on the wire (issue #19).
//
// Every fill/secret answer used to leave through one fire-and-forget send that no-ops when
// the socket is not OPEN (`safeSend` in main.js). The socket is not OPEN nearly as rarely as
// that suggests: a prompt may sit on screen for the whole 300s the service waits, and a
// laptop sleeping, a wifi change or a service restart closes the link underneath it, with a
// reconnect backoff of up to 30s behind that. The user then types the password, clicks
// Approve, watches the window close — and the value goes nowhere. The agent waits out the
// full timeout and is told nobody answered, which is the opposite of what happened.
// (`historymerge.js` already names this: "an offline submit — recordHistory runs before
// safeSend, and safeSend no-ops on a closed socket".)
//
// So an answer is HELD instead of dropped, and re-sent the moment the link is back; for an
// outage shorter than the request's own deadline the user never learns there was one. What
// still cannot be delivered when the request stops being answerable is REPORTED to the
// caller so it can be named in the log, the tray and History — never silently forgotten.
//
// Two rules the shape follows from:
//
//  1. In memory only, and bounded. These frames carry the user's plaintext values, so the
//     outbox never touches the disk, and an entry is dropped — values with it — as soon as
//     nobody can still be waiting for it: at the request's own absolute deadline (the same
//     one the prompt counted down to, see deadline.js), and in no case more than
//     DEFAULT_MAX_AGE_MS after it was queued. Retrying exists to bridge a reconnect, which
//     backs off to at most 30s; holding a secret in memory beyond that buys nothing and
//     risks something.
//
//  2. One queued answer per request_id. A later answer for the same request replaces an
//     older queued one (it is a correction, not a lost message), and `has()` is what lets
//     main.js recognise a replayed `fill_request` as one it has ALREADY answered — without
//     that, every reconnect asks the user for the same password a second time.
//
// Pure: no electron, no ws, no fs, no timers — the socket is injected as `send` (returns
// true only if the frame actually went out) and the clock as `now`. See test/outbox.test.mjs.

// How long an answer may be held when the frame carried no deadline, and the hard cap on
// any hold. 300s is the service's own default fill timeout: past it the request is
// `timeout` server-side and the answer is worthless.
export const DEFAULT_MAX_AGE_MS = 300_000;
// A queue this long already means something is very wrong (one prompt is shown at a time).
// The cap exists so a pathological run cannot pin an unbounded number of secrets in memory.
export const DEFAULT_MAX_ENTRIES = 32;

/**
 * @param send      (frame) => boolean — true only when the frame actually left
 * @param now       () => epoch ms
 * @param maxAgeMs  hard cap on how long an answer is held
 * @param max       most entries held at once; the oldest are evicted past it
 */
export function createOutbox({ send, now = () => Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, max = DEFAULT_MAX_ENTRIES } = {}) {
  const queue = []; // oldest first — answers go out in the order they were given

  const idOf = (frame) => (frame && typeof frame.request_id === "string" ? frame.request_id : null);
  const remove = (entry) => {
    const i = queue.indexOf(entry);
    if (i !== -1) queue.splice(i, 1);
  };

  // Queue an answer. Returns the entries this displaced for lack of room — they were never
  // delivered, so the caller must report them.
  function push(frame, { expiresAt = null, meta = null } = {}, t) {
    const requestId = idOf(frame);
    // Supersede our own older answer for the same request. Not a delivery failure: nothing
    // was lost, the user (or an expiry path) simply said something newer about it.
    if (requestId) {
      const prev = queue.find((e) => e.requestId === requestId);
      if (prev) remove(prev);
    }
    const deadline = Number.isFinite(expiresAt) ? expiresAt : Infinity;
    queue.push({ requestId, frame, meta, queuedAt: t, expiresAt: Math.min(deadline, t + maxAgeMs) });
    const evicted = [];
    while (queue.length > max) evicted.push({ ...queue.shift(), why: "overflow" });
    return evicted;
  }

  function flushAt(t) {
    const evicted = [];
    // Time out first: an answer to a request the service has already given up on must not
    // be put on the wire at all (main.js's expireRequest follows the same rule).
    for (const e of queue.slice()) {
      if (e.expiresAt <= t) { remove(e); evicted.push({ ...e, why: "expired" }); }
    }
    const sent = [];
    while (queue.length) {
      let ok = false;
      try { ok = send(queue[0].frame) === true; } catch { ok = false; }
      if (!ok) break; // the link is (still) down — everything stays queued, in order
      sent.push(queue.shift());
    }
    return { sent, evicted };
  }

  return {
    /**
     * Send an answer, or hold it until the link is back.
     * @returns {{sent: boolean, evicted: Array}} `sent` is false when it was queued;
     *          `evicted` are answers that will never be delivered — report them.
     */
    deliver(frame, opts = {}) {
      const t = now();
      const evicted = push(frame, opts, t);
      const f = flushAt(t);
      return { sent: f.sent.some((e) => e.frame === frame), evicted: evicted.concat(f.evicted) };
    },

    /**
     * Re-send everything queued (on reconnect), and surface whatever ran out of time.
     * Safe to call while still offline: nothing sends, but an entry whose request is over
     * is reported then, rather than waiting for a reconnect that may be a long way off.
     */
    flush() {
      return flushAt(now());
    },

    /** Is there an answer for this request waiting to go out? (Replay must not re-prompt.) */
    has(requestId) {
      return queue.some((e) => e.requestId === requestId);
    },

    /**
     * Forget a queued answer without reporting it — the service told us it resolved the
     * request elsewhere, so nobody is waiting and the values should stop being held.
     * @returns the dropped entry, or null.
     */
    drop(requestId) {
      const e = queue.find((x) => x.requestId === requestId);
      if (!e) return null;
      remove(e);
      return e;
    },

    /** How many answers are waiting for the connection (shown in the tray). */
    size() {
      return queue.length;
    },
  };
}
