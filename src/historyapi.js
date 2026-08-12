// Client for the service's copy of the request history.
//
// The service keeps its own log of the same requests, keyed on the same server-minted
// request_id: `GET /api/sessions/fill-history` (newest first, `limit` clamped to
// [1, 1000]) and `GET /api/sessions/fill-history/{request_id}/screenshot` (the proof
// JPEG, 404 when it never existed or has expired).
//
// This lives in the main process, not the renderer: the History window is sandboxed
// under a `default-src 'self'` CSP and must never hold the API key.
//
// Neither call throws. A Keeper with no network is the normal case — losing the service
// has to degrade the window to local-only with a stated reason, not empty it or hang it.

const HISTORY_LIMIT = 1000;    // the endpoint's maximum
const TIMEOUT_MS = 8000;       // an unreachable service must not hang the History window

function apiUrl(baseUrl, p) {
  return String(baseUrl).replace(/\/+$/, "") + p;
}
function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * @returns {{ok: boolean, requests: object[], error?: string}} — `ok: false` means the
 *          list is UNKNOWN (offline / no key / HTTP error), which is not the same as
 *          "the service has no such request", so callers must not tag anything
 *          "local only" off the back of it.
 */
export async function fetchServerHistory({ baseUrl, apiKey }, { fetchImpl = fetch, limit = HISTORY_LIMIT } = {}) {
  if (!apiKey) return { ok: false, requests: [], error: "no API key" };
  try {
    const res = await fetchImpl(apiUrl(baseUrl, `/api/sessions/fill-history?limit=${limit}`), {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, requests: [], error: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, requests: Array.isArray(body && body.requests) ? body.requests : [] };
  } catch (e) {
    return { ok: false, requests: [], error: (e && e.message) || "unreachable" };
  }
}

/** The service's proof image for one request, as a data URL — or null if it has none. */
export async function fetchServerScreenshot({ baseUrl, apiKey }, id, { fetchImpl = fetch } = {}) {
  if (!apiKey || !id) return null;
  try {
    const res = await fetchImpl(apiUrl(baseUrl, `/api/sessions/fill-history/${encodeURIComponent(id)}/screenshot`), {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? "data:image/jpeg;base64," + buf.toString("base64") : null;
  } catch { return null; }
}
