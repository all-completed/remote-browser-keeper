// ui/lib/nav.js — the window's pages, and the targets that open one (issue #36: the Vault
// password page is a section of Settings).
import test from "node:test";
import assert from "node:assert/strict";
import { PAGE_KEYS, PAGE_TITLES, VAULT_PASSWORD, isPage, resolveTarget } from "../ui/lib/nav.js";

test("the sidebar has no Vault password page any more — Settings carries it", () => {
  assert.deepEqual(PAGE_KEYS, ["approvals", "history", "cards", "savedfields", "headless", "pair", "settings"]);
  assert.equal(isPage("vaultpw"), false);
  assert.equal(PAGE_TITLES.vaultpw, undefined);
  for (const k of PAGE_KEYS) assert.ok(PAGE_TITLES[k], `${k} has a title`);
});

test("a page key opens the page at its top", () => {
  for (const k of PAGE_KEYS) assert.deepEqual(resolveTarget(k), { page: k, section: null });
});

test("the old `vaultpw` key, and the section target, open Settings at the vault-password section", () => {
  const vault = { page: "settings", section: "vault-password" };
  assert.deepEqual(resolveTarget("vaultpw"), vault);
  assert.deepEqual(resolveTarget("settings#vault-password"), vault);
  assert.deepEqual(resolveTarget(VAULT_PASSWORD), vault);
});

test("anything else is not a target", () => {
  for (const bad of [undefined, null, 7, {}, "", "nope", "settings#nope", "pair#vault-password", "settings#",
    "#vault-password", "vaultpw#vault-password", "constructor", "toString", "settings#constructor", "__proto__"]) {
    assert.equal(resolveTarget(bad), null, String(bad));
  }
});
