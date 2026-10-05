// One-time codes — field kind "code", the masked 2FA / SMS / e-mail code — are never
// saved and never replayed (issue #24).
//
// A code is dead the moment it is used, so a stored one is only ever wrong. Worse, the
// saved-field key (session + host + selector) matches every later code request on the
// same page, so one Send with "Save to vault" + "Don't ask again" ticked used to answer
// each following 2FA prompt silently with the dead code: the login fails, the agent
// retries, the account heads for lockout, and the user is never asked.
//
// The rule is enforced in the main process (it decides what is stored and what fills
// without a prompt); the prompt only hides the control that would offer it. The kind is
// always read from the REQUEST's fields — never from what the renderer sends back.
// Pure, so both sides share it and it is testable without Electron.

export function isOneTimeCode(field) {
  return String((field && field.field) || "").trim().toLowerCase() === "code";
}

function codeSelectors(fields) {
  return new Set((Array.isArray(fields) ? fields : [])
    .filter(isOneTimeCode)
    .map((f) => String(f.selector || "").trim()));
}

// The silent-fill decision for a request: the values to send without a prompt, or null
// when ANY field has to be asked for. `lookup(selector)` returns the stored
// `{ value, auto }` for a field, or null. A code field always needs the user, whatever
// is stored under its selector — that is how an entry saved by an earlier build stops
// replaying too.
export function autofillValues(fields, lookup) {
  if (!Array.isArray(fields) || !fields.length) return null;
  const values = [];
  for (const f of fields) {
    if (!f || isOneTimeCode(f)) return null;
    const s = lookup(f.selector);
    if (!s || !s.auto || s.value == null) return null; // not all auto-fillable → prompt
    values.push({ selector: f.selector, value: s.value });
  }
  return values;
}

// The subset of `values` ({ selector, value }) that may be written to the field store
// for this request: everything except a code field's.
export function savableValues(fields, values) {
  const codes = codeSelectors(fields);
  return (Array.isArray(values) ? values : [])
    .filter((v) => v && !codes.has(String(v.selector || "").trim()));
}
