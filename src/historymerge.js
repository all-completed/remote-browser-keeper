// Merge the two request histories into the one list the History window shows.
//
// The Keeper writes a local log (`history.jsonl`, see recordHistory in main.js) and the
// service keeps its own (`rb/{user_id}/keeper-history.jsonl`, `GET /api/sessions/fill-history`).
// Both key on the same server-minted `request_id`, but either side can hold a request the
// other never saw:
//   server-only — `no_keeper` and `timeout` (no fill_request was ever answered here), and
//                 any request a DIFFERENT paired device answered: the service fans the
//                 fill_request out to every connected keeper, and the ones that lose the
//                 race only get a `request_resolved` dismissal, which records nothing.
//   local-only  — an offline submit (recordHistory runs before safeSend, and safeSend
//                 no-ops on a closed socket), and anything the service has since dropped.
// So the union — not either list on its own — is what actually happened on the account.
//
// PRECEDENCE (also documented in docs/file-structure.md):
//  1. `source` is derived ONLY from which list(s) the request_id was found in. It is never
//     inferred from a status: "this looks like a timeout" is a guess, "the server had it and
//     we didn't" is a fact.
//  2. Status — the server's `status` is authoritative for what happened TO THE REQUEST: it
//     is the only side that sees the outcome after the values leave this device (the fill
//     succeeding or erroring, the request expiring, another device answering). The local
//     `outcome` is authoritative for what THIS DEVICE did. Neither overwrites the other:
//     both are kept, and when they disagree (`disagree: true`) the screen shows both,
//     labelled by source. `effective` exposes the single value a non-UI consumer should
//     use — the server status when there is one, else the local outcome.
//  3. Time — the server's clock wins whenever the request is server-known, so one clock
//     orders most of the list; local-only records necessarily use the local clock.
//
// Pure functions only (no fs, no electron): the main process merges, the renderer just
// draws. See test/historymerge.test.mjs.

// Timestamps arrive as ISO strings (local log) or epoch seconds as a float
// (server: python time.time()). Normalise both to millis.
const SECONDS_CUTOFF = 1e11;
export function toMillis(ts) {
  if (ts == null || ts === "") return null;
  const n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isNaN(n) && String(ts).trim() !== "") return n < SECONDS_CUTOFF ? n * 1000 : n;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}
function toIso(ts) {
  const ms = toMillis(ts);
  return ms == null ? null : new Date(ms).toISOString();
}

// The local outcome vocabulary and the server's status vocabulary are different words for
// (sometimes) the same event. Only these pairs mean the same thing; everything else is a
// genuine disagreement and both values are surfaced. `ui_failed` is deliberately NOT paired
// with `cancelled`: the keeper can only report a generic cancel over the wire, so the local
// value is strictly more informative and must not be collapsed away.
const SAME_EVENT = { submitted: ["filled"], autofilled: ["filled"], cancelled: ["cancelled"] };
export function statusesAgree(outcome, status) {
  if (!outcome || !status) return true; // only one side knows — nothing to disagree about
  const same = SAME_EVENT[outcome];
  return same ? same.includes(status) : outcome === status;
}

function fromLocal(r) {
  return {
    request_id: typeof r.request_id === "string" ? r.request_id : null,
    source: "local",
    outcome: r.outcome || null,   // what this device did
    status: null,                 // what the service recorded
    effective: r.outcome || null,
    disagree: false,
    reason: typeof r.reason === "string" ? r.reason : null, // the user's note on a decline

    session_id: r.session_id || null,
    url: r.url || null,
    requested_at: toIso(r.requested_at),
    resolved_at: toIso(r.resolved_at),
    fields: Array.isArray(r.fields) ? r.fields : [],
    local_screenshot: !!r.screenshot,
    server_screenshot: false,
    at: toMillis(r.resolved_at) ?? toMillis(r.requested_at),
  };
}

function fromServer(r) {
  return {
    request_id: typeof r.request_id === "string" ? r.request_id : null,
    source: "server",
    outcome: null,
    status: r.status || null,
    effective: r.status || null,
    disagree: false,
    reason: null,                 // only this device records why the user declined

    session_id: r.session_id || null,
    url: r.url || null,
    requested_at: toIso(r.created_at),
    resolved_at: toIso(r.completed_at),
    fields: Array.isArray(r.fields) ? r.fields : [],
    local_screenshot: false,
    server_screenshot: !!r.has_screenshot,
    at: toMillis(r.completed_at) ?? toMillis(r.created_at),
  };
}

// Fold a server record into the local record for the same request_id.
function foldServer(e, r) {
  e.source = "both";
  e.status = r.status || null;
  e.effective = e.status || e.outcome;
  e.disagree = !statusesAgree(e.outcome, e.status);
  e.session_id = e.session_id || r.session_id || null;
  e.url = e.url || r.url || null;
  if (!e.fields.length && Array.isArray(r.fields)) e.fields = r.fields;
  e.server_screenshot = !!r.has_screenshot;
  // Rule 3: the server's clock orders the merged list wherever it exists.
  const at = toMillis(r.completed_at) ?? toMillis(r.created_at);
  if (at != null) {
    e.at = at;
    e.resolved_at = toIso(r.completed_at) || e.resolved_at;
  }
  return e;
}

/**
 * Union the two lists on `request_id`, newest first.
 *
 * @param local  records parsed from history.jsonl (see readHistory)
 * @param server the `requests` array of GET /api/sessions/fill-history
 * @returns merged records — one per request_id, tagged `source: local|server|both`
 */
export function mergeHistory(local, server) {
  const byId = new Map();
  const out = [];
  const add = (e) => { out.push(e); if (e.request_id) byId.set(e.request_id, e); };

  for (const r of Array.isArray(local) ? local : []) {
    if (!r || typeof r !== "object") continue;
    // The log is newest-first, so a repeated id keeps the newest line.
    if (typeof r.request_id === "string" && byId.has(r.request_id)) continue;
    add(fromLocal(r));
  }
  for (const r of Array.isArray(server) ? server : []) {
    if (!r || typeof r !== "object") continue;
    const e = typeof r.request_id === "string" ? byId.get(r.request_id) : null;
    if (e) { if (e.source === "local") foldServer(e, r); continue; } // else: already merged
    add(fromServer(r));
  }
  // Records with no usable timestamp sort last rather than jumping to the top.
  out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return out;
}
