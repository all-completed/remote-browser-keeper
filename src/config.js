// Resolve the service base URL + API key:
// AC_API_KEY / RBS_API_KEY env, else ~/.ac-api-key file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readKeyFile(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

export function loadConfig() {
  const baseUrl = String(process.env.RBS_URL || "https://rb.example.com").replace(/\/+$/, "");
  // Key precedence: AC_API_KEY / RBS_API_KEY env, then AC_API_KEY_FILE (a path to
  // read the key from — keeps the secret out of the environment/process args),
  // then the default ~/.ac-api-key.
  const apiKey =
    process.env.AC_API_KEY ||
    process.env.RBS_API_KEY ||
    (process.env.AC_API_KEY_FILE ? readKeyFile(process.env.AC_API_KEY_FILE) : "") ||
    readKeyFile(path.join(os.homedir(), ".ac-api-key"));
  return { baseUrl, apiKey };
}

// ws(s)://host/api/keeper/ws — the token is sent as an Authorization header
// (see main.js), never in the URL, so it can't leak into proxy/access logs.
export function keeperWsUrl({ baseUrl }) {
  const wsBase = baseUrl.replace(/^http/, "ws");
  return `${wsBase}/api/keeper/ws`;
}
