// The pages of the one window (issue #28) — the keys are the ones main navigates to
// (src/main.js PAGES); the order is the sidebar's.
export const PAGE_KEYS = ["approvals", "history", "cards", "savedfields", "headless", "pair", "vaultpw", "settings"];

export const PAGE_TITLES = {
  approvals: "Approvals",
  history: "History",
  cards: "Cards",
  savedfields: "Saved fields",
  headless: "Headless Keepers",
  pair: "Pair phone",
  vaultpw: "Vault password",
  settings: "Settings",
};

export const isPage = (k) => PAGE_KEYS.includes(k);

// What the Approvals entry says: how many things are waiting for the user right now.
export function approvalsLabel(status) {
  const n = ((status && status.waiting) || 0) + ((status && status.unlocks) || 0);
  return n ? `${PAGE_TITLES.approvals} (${n})` : PAGE_TITLES.approvals;
}
