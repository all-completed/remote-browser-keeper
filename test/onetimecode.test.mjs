// One-time codes are never saved and never replayed (issue #24).
//
// Before: a `field: "code"` request saved with the prompt's defaults (vault + "don't ask
// again") was answered silently with that dead code on every later request for the same
// session/host/selector. These pin the two decisions the main process now makes: what
// fills without a prompt, and what may be stored.
import test from "node:test";
import assert from "node:assert/strict";
import { isOneTimeCode, autofillValues, savableValues } from "../src/onetimecode.js";

const store = (entries) => (selector) => entries[selector] || null;

test("kind 'code' is a one-time code, whatever its case or padding", () => {
  for (const field of ["code", "CODE", " Code "]) assert.equal(isOneTimeCode({ field }), true, field);
  for (const field of ["password", "text", "login", "email", "card-cvv", "", undefined]) {
    assert.equal(isOneTimeCode({ field }), false, String(field));
  }
  assert.equal(isOneTimeCode(null), false);
});

test("a code saved by an earlier build, auto-fill on, is NOT replayed — the user is asked", () => {
  const fields = [{ selector: "#otp", field: "code" }];
  assert.equal(autofillValues(fields, store({ "#otp": { value: "123456", auto: true } })), null);
});

test("one code field keeps the whole request on the prompt, even with every other field saved", () => {
  const fields = [{ selector: "#pw", field: "password" }, { selector: "#otp", field: "code" }];
  const saved = store({ "#pw": { value: "hunter2", auto: true }, "#otp": { value: "123456", auto: true } });
  assert.equal(autofillValues(fields, saved), null);
});

test("non-code fields still fill silently exactly as before", () => {
  const fields = [{ selector: "#user", field: "login" }, { selector: "#pw", field: "password" }];
  const saved = store({ "#user": { value: "me", auto: true }, "#pw": { value: "hunter2", auto: true } });
  assert.deepEqual(autofillValues(fields, saved), [
    { selector: "#user", value: "me" },
    { selector: "#pw", value: "hunter2" },
  ]);
});

test("unchanged: a field saved without 'don't ask again', or not saved, prompts", () => {
  const fields = [{ selector: "#pw", field: "password" }];
  assert.equal(autofillValues(fields, store({ "#pw": { value: "x", auto: false } })), null);
  assert.equal(autofillValues(fields, store({})), null);
  assert.equal(autofillValues([], store({})), null);
  assert.equal(autofillValues(undefined, store({})), null);
});

test("a submitted code is dropped before saving; the rest of the request is kept", () => {
  const fields = [{ selector: "#pw", field: "password" }, { selector: "#otp", field: "code" }];
  const values = [{ selector: "#pw", value: "hunter2" }, { selector: "#otp", value: "123456" }];
  assert.deepEqual(savableValues(fields, values), [{ selector: "#pw", value: "hunter2" }]);
});

test("the kind comes from the request, so a renderer cannot relabel a code to save it", () => {
  // The renderer only sends { selector, value }; any `field` it adds is ignored.
  const fields = [{ selector: "#otp", field: "code" }];
  const values = [{ selector: " #otp ", value: "123456", field: "password" }];
  assert.deepEqual(savableValues(fields, values), []);
});

test("a codes-only request saves nothing; junk input saves nothing and never throws", () => {
  assert.deepEqual(savableValues([{ selector: "#otp", field: "code" }], [{ selector: "#otp", value: "1" }]), []);
  assert.deepEqual(savableValues(undefined, undefined), []);
  assert.deepEqual(savableValues([{ selector: "#a", field: "text" }], [null, { selector: "#a", value: "v" }]),
    [{ selector: "#a", value: "v" }]);
});
