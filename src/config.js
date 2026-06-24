// Resolve the service base URL + API key.
// Key precedence: AC_API_KEY / RBS_API_KEY env → AC_API_KEY_FILE → macOS Keychain
// → ~/.ac-api-key file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const KEYCHAIN_SERVICE = "remote-browser-keeper";

function readKeyFile(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function keychainAccount(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// Read the API token from the macOS login Keychain (a generic-password item with
// service "remote-browser-keeper" and account = the service host). The secret never
// touches the environment or process args. No-op off macOS / when the item is absent.
// Store it with:
//   security add-generic-password -U -s remote-browser-keeper -a <host> -w
function readKeychain(baseUrl) {
  if (process.platform !== "darwin") return "";
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(baseUrl), "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return (out || "").trim();
  } catch {
    return "";
  }
}

export function loadConfig() {
  const baseUrl = String(process.env.RBS_URL || "https://rb.example.com").replace(/\/+$/, "");
  // Key precedence: AC_API_KEY / RBS_API_KEY env, then AC_API_KEY_FILE (a path to
  // read the key from — keeps the secret out of the environment/process args), then
  // the macOS Keychain (encrypted at rest), then the legacy ~/.ac-api-key file.
  const apiKey =
    process.env.AC_API_KEY ||
    process.env.RBS_API_KEY ||
    (process.env.AC_API_KEY_FILE ? readKeyFile(process.env.AC_API_KEY_FILE) : "") ||
    readKeychain(baseUrl) ||
    readKeyFile(path.join(os.homedir(), ".ac-api-key"));
  return { baseUrl, apiKey };
}

// ws(s)://host/api/keeper/ws — the token is sent as an Authorization header
// (see main.js), never in the URL, so it can't leak into proxy/access logs.
export function keeperWsUrl({ baseUrl }) {
  const wsBase = baseUrl.replace(/^http/, "ws");
  return `${wsBase}/api/keeper/ws`;
}
