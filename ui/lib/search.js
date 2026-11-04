// Client-side search for the long lists (issue #31): History, Saved fields, Cards and
// Headless Keepers each filter what they already hold in memory — nothing is refetched.
//
// A query is split on whitespace and EVERY word has to appear, case-insensitively,
// somewhere in the row's text (any of the values handed in), so "amazon sess-2" narrows to
// that site's rows in that session. An empty query matches everything.

const norm = (v) => String(v == null ? "" : v).toLowerCase();

export function searchWords(query) {
  return norm(query).split(/\s+/).filter(Boolean);
}

/** Does a row whose searchable text is `values` (strings, numbers, arrays of them) match? */
export function matchesQuery(query, values) {
  const words = Array.isArray(query) ? query : searchWords(query);
  if (!words.length) return true;
  const hay = [values].flat(Infinity).map(norm).join("\n");
  return words.every((w) => hay.includes(w));
}

/** `list` narrowed to the rows matching `query`; `text(row)` gives a row's searchable values. */
export function filterByQuery(list, query, text) {
  const words = searchWords(query);
  if (!words.length) return list;
  return list.filter((row) => matchesQuery(words, text(row)));
}

/** The distinct non-empty values of `pick(row)`, sorted — the options of a filter picker. */
export function distinctValues(list, pick) {
  return [...new Set(list.map(pick).filter((v) => v != null && v !== ""))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}
