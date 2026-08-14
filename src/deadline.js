// When a fill request stops being answerable — read off the `fill_request` frame.
//
// A request expires on its own: the service gives the user DEFAULT_FILL_TIMEOUT_S (300s
// today) and then flips the status to `timeout`. For the Keeper to show how long is left
// (issue #12) it needs that moment, and it may NOT time from when the frame arrived:
// the service REPLAYS the same frame verbatim to a keeper that reconnects (a phone just
// woken by a push), so a local 5:00 timer started on arrival would promise five minutes
// to a device that reconnected with thirty seconds left. A countdown that lies is worse
// than none — the user trusts it and loses the request.
//
// So only an ABSOLUTE deadline counts. A purely relative field (`expires_in`, `ttl`) is
// deliberately NOT accepted: it is stale the moment the frame is replayed, which is the
// exact bug. When the frame carries no absolute deadline this returns null and the
// Keeper shows no countdown at all rather than inventing one.
//
// Pure (no electron, no fs): main.js decides what to do with the number.
import { toMillis } from "./historymerge.js";

// A deadline further out than this is a wrong unit or a bug, not a request someone is
// waiting on — ignore it instead of drawing a runaway timer.
const MAX_HORIZON_MS = 24 * 3600 * 1000;

function first(...values) {
  for (const v of values) {
    if (v == null || v === "") continue;
    const ms = toMillis(v); // ISO-8601 string, epoch seconds, or epoch millis
    if (ms != null && Number.isFinite(ms)) return ms;
  }
  return null;
}

function seconds(...values) {
  for (const v of values) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * The absolute deadline of a `fill_request`, in epoch millis — or `null` when the frame
 * carries none (which must stay "unknown", never a guess).
 *
 * Accepted, in order:
 *   1. `expires_at` / `deadline` — the moment itself (ISO-8601, epoch seconds or millis).
 *   2. `created_at` + `timeout_s` — when the service started waiting plus how long it
 *      waits. `created_at` is already the server's own absolute stamp (it is what
 *      `GET /api/sessions/fill-status/{id}` returns), so this survives a replay too.
 *
 * A deadline in the past is returned as-is: the caller must be able to tell "already
 * over" from "not known".
 */
export function requestDeadline(msg, now = Date.now()) {
  if (!msg || typeof msg !== "object") return null;
  let at = first(msg.expires_at, msg.deadline);
  if (at == null) {
    const started = first(msg.created_at);
    const budget = seconds(msg.timeout_s, msg.timeout);
    if (started == null || budget == null) return null;
    at = started + budget * 1000;
  }
  if (at - now > MAX_HORIZON_MS) return null; // implausible — treat as no deadline
  return at;
}
