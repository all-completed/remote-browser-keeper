// ui/lib/search.js — the client-side search every long list uses (issue #31).
import test from "node:test";
import assert from "node:assert/strict";
import { distinctValues, filterByQuery, matchesQuery, searchWords } from "../ui/lib/search.js";

const rows = [
  { host: "www.amazon.com", session: "sess-2", fields: ["Email", "Password"] },
  { host: "accounts.google.com", session: "sess-1", fields: ["Email"] },
  { host: "www.amazon.com", session: "sess-1", fields: ["Card number"] },
];
const text = (r) => [r.host, r.session, r.fields];

test("an empty or blank query matches everything", () => {
  assert.deepEqual(searchWords("   "), []);
  assert.equal(filterByQuery(rows, "", text), rows);
  assert.equal(filterByQuery(rows, "  \n ", text), rows);
  assert.equal(matchesQuery(undefined, ["x"]), true);
});

test("case-insensitive substring, every word must match, nested arrays searched", () => {
  assert.deepEqual(filterByQuery(rows, "AMAZON", text), [rows[0], rows[2]]);
  assert.deepEqual(filterByQuery(rows, "amazon sess-1", text), [rows[2]]);
  assert.deepEqual(filterByQuery(rows, "card", text), [rows[2]]);
  assert.deepEqual(filterByQuery(rows, "email google", text), [rows[1]]);
  assert.deepEqual(filterByQuery(rows, "nowhere", text), []);
});

test("null and undefined values never match the words 'null' / 'undefined'", () => {
  assert.equal(matchesQuery("null", [null, undefined, "x"]), false);
  assert.equal(matchesQuery("undefined", [undefined]), false);
  assert.equal(matchesQuery("7", [7]), true);
});

test("distinctValues: unique, non-empty, sorted", () => {
  assert.deepEqual(distinctValues(rows, (r) => r.host), ["accounts.google.com", "www.amazon.com"]);
  assert.deepEqual(distinctValues([{ a: "" }, { a: null }, { a: "b" }], (r) => r.a), ["b"]);
});
