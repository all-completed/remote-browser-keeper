// The pages of the one window (issue #28) — the keys are the ones main navigates to
// (src/main.js PAGES); the order is the sidebar's.
export const PAGE_KEYS = ["approvals", "history", "cards", "savedfields", "headless", "pair", "settings"];

export const PAGE_TITLES = {
  approvals: "Approvals",
  history: "History",
  cards: "Cards",
  savedfields: "Saved fields",
  headless: "Headless Keepers",
  pair: "Pair phone",
  settings: "Settings",
};

// A navigation target is a page key, or `page#section` for a section of a page. The
// sections a target may name — each is an element id on that page.
export const PAGE_SECTIONS = { settings: ["vault-password"] };
// Keys that were pages of their own and are now a section of another (issue #36: the
// Vault password page is a section of Settings). Main, the tray and an older caller may
// still ask for them; they land on the section.
export const PAGE_ALIASES = { vaultpw: "settings#vault-password" };
// Where the Settings page's vault-password section is.
export const VAULT_PASSWORD = PAGE_ALIASES.vaultpw;

// A target → { page, section } (section null for the top of the page), or null when it
// names no page or a section the page doesn't have.
export function resolveTarget(target) {
  if (typeof target !== "string") return null;
  const t = Object.hasOwn(PAGE_ALIASES, target) ? PAGE_ALIASES[target] : target;
  const i = t.indexOf("#");
  const page = i < 0 ? t : t.slice(0, i);
  const section = i < 0 ? null : t.slice(i + 1);
  if (!PAGE_KEYS.includes(page)) return null;
  if (section !== null && !(Object.hasOwn(PAGE_SECTIONS, page) && PAGE_SECTIONS[page].includes(section))) return null;
  return { page, section };
}

export const isPage = (k) => PAGE_KEYS.includes(k);

// What the Approvals entry says: how many things are waiting for the user right now.
export function approvalsLabel(status) {
  const n = ((status && status.waiting) || 0) + ((status && status.unlocks) || 0);
  return n ? `${PAGE_TITLES.approvals} (${n})` : PAGE_TITLES.approvals;
}
