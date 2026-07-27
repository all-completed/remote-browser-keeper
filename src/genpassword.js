// Password generation policy for the Keeper's UNATTENDED generate path (main process,
// node:crypto). Mirrors ui/lib/format.js generatePassword (renderer/WebCrypto) so the
// unattended fill and a prompt's prefill produce the same policy.
//
// Policy for a generated password (non-numeric):
//   - length >= 14 (the agent may raise it, never lower it), capped at 128;
//   - ALWAYS at least one lowercase (a-z), one uppercase (A-Z), one digit (0-9);
//   - symbols included unless the field sets `symbols: false` (e.g. a site that rejects
//     them). The mandatory set is exactly a-z / A-Z / 0-9.
// A numeric field (format numeric/digits/number) generates digits only at the requested
// length (for PINs/codes — the >=14 minimum does not apply).
import crypto from "node:crypto";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*-_=+";
export const MIN_PASSWORD_LEN = 14;

// Unbiased index in [0, n) from crypto bytes (rejection sampling).
function randInt(n) {
  const limit = Math.floor(0xffffffff / n) * n;
  let x;
  do { x = crypto.randomBytes(4).readUInt32BE(0); } while (x >= limit);
  return x % n;
}
const pick = (s) => s[randInt(s.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function generateValue(field) {
  const f = field || {};
  const numeric = ["numeric", "digits", "number"].includes(String(f.format || "").toLowerCase());
  if (numeric) {
    const len = Math.max(1, Math.min(Number.isInteger(f.length) && f.length > 0 ? f.length : 6, 64));
    let out = "";
    for (let i = 0; i < len; i++) out += pick(DIGITS);
    return out;
  }
  const useSymbols = f.symbols !== false; // default: include symbols
  const pools = [LOWER, UPPER, DIGITS, ...(useSymbols ? [SYMBOLS] : [])];
  const all = pools.join("");
  const len = Math.max(MIN_PASSWORD_LEN, Math.min(Number.isInteger(f.length) && f.length > 0 ? f.length : 20, 128));
  const chars = pools.map(pick); // one guaranteed from each mandatory pool
  while (chars.length < len) chars.push(pick(all));
  return shuffle(chars).join("");
}
