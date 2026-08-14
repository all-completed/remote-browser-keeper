// The decline note a user may attach when dismissing a fill request (issue #11).
//
// A bare `cancelled` made every decline look the same to the agent — "wrong account",
// "not now" and "I already did it myself" all arrived as the same word. The note is the
// difference, so what reaches the wire has to be bounded, single-line, and absent (not
// empty) whenever the user typed nothing: a plain one-tap Cancel must keep sending
// exactly what it always did.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDeclineReason, DECLINE_REASON_MAX, DECLINE_PRESETS } from "../src/declinereason.js";

test("a written reason survives verbatim", () => {
  assert.equal(normalizeDeclineReason("wrong account — use the other login"),
    "wrong account — use the other login");
});

test("nothing typed is nothing sent — a plain Cancel is unchanged", () => {
  for (const v of ["", "   ", "\t\n ", undefined, null, 0, {}, [], () => {}]) {
    assert.equal(normalizeDeclineReason(v), "", `expected no reason for ${JSON.stringify(v) ?? String(v)}`);
  }
});

test("length is bounded", () => {
  const out = normalizeDeclineReason("x".repeat(DECLINE_REASON_MAX * 3));
  assert.equal(out.length, DECLINE_REASON_MAX);
});

test("control characters and newlines collapse to spaces — the reason stays one line", () => {
  assert.equal(normalizeDeclineReason("  not now\nI'm\tdriving\r\n "), "not now I'm driving");
  assert.equal(normalizeDeclineReason("a\u0000\u007fb"), "a b");
});

test("every preset is a usable reason as-is", () => {
  assert.ok(DECLINE_PRESETS.length > 0);
  for (const p of DECLINE_PRESETS) {
    assert.equal(normalizeDeclineReason(p), p, `preset must survive normalization: ${p}`);
    assert.ok(p.length <= DECLINE_REASON_MAX);
  }
});
