// The optional note a user may attach when DECLINING a fill request (issue #11).
//
// A bare `cancelled` tells the agent only that the prompt was dismissed — not whether to
// try the other account, wait, fix its selector, or stop because the user already did the
// job by hand. Each of those calls for a different next move, so the note travels back on
// the cancel path as `reason`, beside `cancelled: true` (the same field `keeper_ui_failed`
// already uses; a decline carries no `error`).
//
// It is ORDINARY TEXT and is meant to be read by the model. Nothing secret can reach it:
// it lives in its own unmasked input in the prompt, is never prefilled from a saved value,
// a card, or the vault, and never joins the `values` map that carries secrets. Normalizing
// happens here and is re-run in the main process on whatever the renderer sends, so the
// wire field is always short, single-line and trimmed.

export const DECLINE_REASON_MAX = 200;

// The declines seen in practice, offered as one-tap presets so the common case needs no
// typing (issue #11 lists exactly these five). Free text covers the rest.
export const DECLINE_PRESETS = [
  "Wrong account — use the other login",
  "Not now — ask me again later",
  "I already did this myself",
  "Wrong field or wrong page",
  "I don't have this credential",
];

// "" for anything that is not a usable note: a non-string, blank, or whitespace-only
// input is the same as declining without one, and the caller then omits the field
// entirely rather than sending an empty string.
export function normalizeDeclineReason(v) {
  if (typeof v !== "string") return "";
  // Control characters (newlines included) would only garble a one-line status field.
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > DECLINE_REASON_MAX ? s.slice(0, DECLINE_REASON_MAX).trim() : s;
}
