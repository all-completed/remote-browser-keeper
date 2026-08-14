// The merged request history: src/historymerge.js (the union) and src/historyapi.js
// (the service's list + proof images).
//
// Issue #7: the History window showed only what THIS machine recorded, so a request
// answered on another laptop, a `no_keeper` and a `timeout` were all invisible — and
// indistinguishable from "it never happened". These tests pin the union: one row per
// request_id, tagged by which side(s) actually hold it, with neither side's status
// overwriting the other's — and that losing the service degrades to local-only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mergeHistory, statusesAgree, toMillis } from "../src/historymerge.js";
import { fetchServerHistory, fetchServerScreenshot } from "../src/historyapi.js";

// A local history.jsonl record (recordHistory in main.js) — ISO times, `outcome`.
const local = (id, outcome, resolved_at, extra = {}) => ({
  request_id: id,
  session_id: "s1",
  url: "https://shop.example.com/login",
  requested_at: resolved_at,
  resolved_at,
  outcome,
  screenshot: null,
  fields: [{ selector: "#pw", label: "Password", field: "password", length: null, format: null }],
  ...extra,
});
// A service record (server/keeper.py _finish) — epoch SECONDS, `status`.
const server = (id, status, completed_at, extra = {}) => ({
  request_id: id,
  session_id: "s1",
  status,
  url: "https://shop.example.com/login",
  message: "",
  fields: [{ selector: "#pw", label: "Password", field: "password", length: null, format: null }],
  created_at: completed_at - 5,
  completed_at,
  ...extra,
});
const T = 1770000000; // epoch seconds
const iso = (secs) => new Date(secs * 1000).toISOString();
const byId = (list) => Object.fromEntries(list.map((e) => [e.request_id, e]));

test("a request on both sides appears exactly once, tagged both", () => {
  const out = mergeHistory([local("a", "submitted", iso(T))], [server("a", "filled", T)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "both");
  assert.equal(out[0].outcome, "submitted");
  assert.equal(out[0].status, "filled");
  assert.equal(out[0].disagree, false); // submitted/filled are the same event
});

test("server-only cases surface: no_keeper, timeout, and another device's answer", () => {
  // "answered elsewhere": the service fanned the request out, another keeper won, this
  // one only got a request_resolved dismissal and recorded nothing.
  const out = mergeHistory([], [
    server("nk", "no_keeper", T),
    server("to", "timeout", T - 10),
    server("other", "filled", T - 20),
  ]);
  assert.deepEqual(out.map((e) => e.request_id), ["nk", "to", "other"]);
  assert.ok(out.every((e) => e.source === "server" && e.outcome === null));
  assert.equal(byId(out).nk.effective, "no_keeper");
});

test("local-only cases survive the merge: offline submit and ui_failed", () => {
  const out = mergeHistory(
    [local("off", "submitted", iso(T)), local("uf", "ui_failed", iso(T - 10))],
    [server("unrelated", "filled", T - 20)],
  );
  const m = byId(out);
  assert.equal(m.off.source, "local");
  assert.equal(m.off.effective, "submitted");
  assert.equal(m.uf.source, "local");
  assert.equal(m.uf.effective, "ui_failed");
});

test("disagreement keeps BOTH values instead of picking one", () => {
  // Offline submit the service never received, then expired: local says submitted.
  const expired = mergeHistory([local("a", "submitted", iso(T))], [server("a", "timeout", T)])[0];
  assert.equal(expired.disagree, true);
  assert.equal(expired.outcome, "submitted");
  assert.equal(expired.status, "timeout");
  assert.equal(expired.effective, "timeout"); // documented precedence: the service's status

  // ui_failed reaches the service only as a generic `cancelled` — the specific local
  // value exists nowhere else, so it must NOT be collapsed into agreement.
  const failed = mergeHistory([local("b", "ui_failed", iso(T))], [server("b", "cancelled", T)])[0];
  assert.equal(failed.disagree, true);
  assert.equal(failed.outcome, "ui_failed");
  assert.equal(failed.status, "cancelled");

  // The CDP fill erroring after the values left this device is the same shape.
  const errored = mergeHistory([local("c", "submitted", iso(T))], [server("c", "error", T)])[0];
  assert.equal(errored.disagree, true);
});

test("agreeing pairs do not raise a false disagreement", () => {
  assert.equal(statusesAgree("submitted", "filled"), true);
  assert.equal(statusesAgree("autofilled", "filled"), true);
  assert.equal(statusesAgree("cancelled", "cancelled"), true);
  // Both sides watched the same deadline pass (issue #12): different word, same event.
  assert.equal(statusesAgree("expired", "timeout"), true);
  assert.equal(statusesAgree("ui_failed", "cancelled"), false);
  assert.equal(statusesAgree("submitted", null), true); // only one side knows
  assert.equal(mergeHistory([local("a", "autofilled", iso(T))], [server("a", "filled", T)])[0].disagree, false);
  assert.equal(mergeHistory([local("b", "expired", iso(T))], [server("b", "timeout", T)])[0].disagree, false);
});

test("sorted newest first across the two clocks (ISO local, epoch-seconds server)", () => {
  const out = mergeHistory(
    [local("l1", "submitted", iso(T - 100)), local("l2", "cancelled", iso(T - 300))],
    [server("s1", "filled", T - 200), server("s2", "no_keeper", T)],
  );
  assert.deepEqual(out.map((e) => e.request_id), ["s2", "l1", "s1", "l2"]);
  assert.equal(toMillis(T), T * 1000);            // epoch seconds (float, python time.time)
  assert.equal(toMillis(iso(T)), T * 1000);       // ISO string
  assert.equal(toMillis(null), null);
});

test("screenshot availability is tracked per side", () => {
  const out = mergeHistory(
    [local("a", "submitted", iso(T), { screenshot: "screenshots/a.jpg" }),
     local("b", "submitted", iso(T - 1))],
    [server("a", "filled", T), server("b", "filled", T - 1, { has_screenshot: true }),
     server("c", "no_keeper", T - 2, { has_screenshot: true })],
  );
  const m = byId(out);
  assert.deepEqual([m.a.local_screenshot, m.a.server_screenshot], [true, false]);
  assert.deepEqual([m.b.local_screenshot, m.b.server_screenshot], [false, true]); // server's copy only
  assert.deepEqual([m.c.local_screenshot, m.c.server_screenshot], [false, true]); // server-only record
});

// Issue #11: the user's note on a decline is only ever recorded HERE, so the merge must
// carry it through — including onto a row the service also knows about.
test("a decline reason survives the merge and is never invented for a server row", () => {
  const out = mergeHistory(
    [local("why", "cancelled", iso(T), { reason: "I already did this myself" }),
     local("plain", "cancelled", iso(T - 1))],
    [server("why", "cancelled", T), server("srv", "cancelled", T - 2)],
  );
  const m = byId(out);
  assert.equal(m.why.reason, "I already did this myself");
  assert.equal(m.why.source, "both"); // folding the service's row must not drop it
  assert.equal(m.plain.reason, null); // declined without a note
  assert.equal(m.srv.reason, null);   // the service does not carry one
});

test("an entry evicted locally reappears from the service rather than vanishing", () => {
  // Local eviction (>6 months / >2000 entries) drops the line; the service still has it.
  const out = mergeHistory([], [server("old", "filled", T - 400 * 24 * 3600)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "server");
});

test("no server list (offline) leaves every record local and unchanged", () => {
  const out = mergeHistory([local("a", "submitted", iso(T))], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "local");
  assert.equal(out[0].status, null);
});

test("tolerates junk: bad lines, duplicate ids, missing ids and times", () => {
  const out = mergeHistory(
    [null, "nope", local("a", "submitted", iso(T)), local("a", "cancelled", iso(T - 999)),
     { outcome: "submitted" }],
    [server("a", "filled", T), server("a", "cancelled", T), { request_id: "z" }],
  );
  const ids = out.map((e) => e.request_id);
  assert.equal(ids.filter((i) => i === "a").length, 1);   // one row per request_id
  assert.equal(byId(out).a.outcome, "submitted");         // the newest local line wins
  assert.equal(byId(out).a.status, "filled");             // the first server record wins
  assert.equal(out.at(-1).at, null);                      // timeless records sort last
  assert.equal(out.length, 3);                            // a, the id-less local record, z
});

// ---- the service's endpoints (src/historyapi.js) ----------------------------------
// A stand-in for GET /api/sessions/fill-history + /{id}/screenshot, on a real socket,
// so the request the Keeper actually sends (path, limit, bearer header) is checked.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
async function fakeService(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}
const jsonRes = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

test("fill-history: sends the bearer token and the clamped limit, returns the records", async () => {
  const svc = await fakeService((req, res) => {
    if (req.url.startsWith("/api/sessions/fill-history?")) {
      return jsonRes(res, 200, { requests: [server("a", "no_keeper", T)], count: 1 });
    }
    jsonRes(res, 404, { detail: "no" });
  });
  try {
    const r = await fetchServerHistory({ baseUrl: svc.baseUrl + "/", apiKey: "k1" });
    assert.equal(r.ok, true);
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].status, "no_keeper");
    assert.equal(svc.seen[0].url, "/api/sessions/fill-history?limit=1000"); // the endpoint's max
    assert.equal(svc.seen[0].auth, "Bearer k1");                            // token in the header
    // The union of a local record and this one is what the window draws.
    const merged = mergeHistory([local("b", "submitted", iso(T - 1))], r.requests);
    assert.deepEqual(merged.map((e) => [e.request_id, e.source]), [["a", "server"], ["b", "local"]]);
  } finally { svc.close(); }
});

test("an unreachable or erroring service is reported, never thrown, never empty", async () => {
  const svc = await fakeService((_req, res) => jsonRes(res, 500, { detail: "boom" }));
  try {
    const bad = await fetchServerHistory({ baseUrl: svc.baseUrl, apiKey: "k1" });
    assert.deepEqual(bad, { ok: false, requests: [], error: "HTTP 500" });
  } finally { svc.close(); }

  const down = await fetchServerHistory({ baseUrl: "http://127.0.0.1:1", apiKey: "k1" });
  assert.equal(down.ok, false);
  assert.ok(down.error); // a reason to show in the window
  assert.deepEqual(await fetchServerHistory({ baseUrl: "http://x", apiKey: "" }),
                   { ok: false, requests: [], error: "no API key" });

  // ok:false means "unknown", so the merge is fed nothing and the list stays local —
  // it is never emptied, and nothing gets mis-tagged.
  const merged = mergeHistory([local("a", "submitted", iso(T))], down.requests);
  assert.deepEqual(merged.map((e) => [e.request_id, e.source]), [["a", "local"]]);
});

test("proof screenshot: the service's copy comes back as a data URL, 404 as null", async () => {
  const svc = await fakeService((req, res) => {
    if (req.url === "/api/sessions/fill-history/abc/screenshot") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      return res.end(JPEG);
    }
    jsonRes(res, 404, { detail: "screenshot not found" });
  });
  try {
    const cfg = { baseUrl: svc.baseUrl, apiKey: "k1" };
    assert.equal(await fetchServerScreenshot(cfg, "abc"),
                 "data:image/jpeg;base64," + JPEG.toString("base64"));
    assert.equal(svc.seen[0].auth, "Bearer k1");
    assert.equal(await fetchServerScreenshot(cfg, "gone"), null); // expired / never captured
    assert.equal(await fetchServerScreenshot({ baseUrl: svc.baseUrl, apiKey: "" }, "abc"), null);
  } finally { svc.close(); }
});
