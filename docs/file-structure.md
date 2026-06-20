# File structure

How the Keeper is laid out — both the **source tree** and the **runtime data** it
writes on your machine.

## Source tree

Repository: **https://github.com/all-completed/remote-browser-keeper** (public).

```
remote-browser-keeper/
├── package.json            # Electron app manifest + scripts (start, dist) + electron-builder config
├── README.md
├── .github/
│   └── workflows/
│       └── build.yml       # CI: build desktop artifacts for every OS + arch
├── docs/
│   └── file-structure.md   # this file
├── src/                    # Electron main process + preload bridges (Node side)
│   ├── main.js
│   ├── config.js
│   ├── preload.cjs
│   ├── history-preload.cjs
│   └── image-preload.cjs
└── renderer/               # window UIs (sandboxed browser side, no Node access)
    ├── prompt.{html,css,js}
    ├── history.{html,css,js}
    └── image.{html,js}
```

### `src/` — main process (Node)

| File | Responsibility |
| --- | --- |
| `main.js` | The whole main process: tray-only lifecycle (dock hidden), the **Keeper WebSocket client** (connect/reconnect, `hello`/`ping`/`pong`, receive `fill_request`, send `fill_response`), the **prompt-window queue**, the **History window**, the **full-size image viewer**, the **tray menu** (service host + connection state, History…, Quit), and **local history + screenshot storage** (see below). |
| `config.js` | Resolves `{ baseUrl, apiKey }` — `RBS_URL` / default `https://rb.example.com`, and the API key from `AC_API_KEY` / `RBS_API_KEY` / `AC_API_KEY_FILE` / `~/.ac-api-key`. Also derives `keeperWsUrl`. |
| `preload.cjs` | `contextBridge` for the **prompt** renderer: `onRequest`, `submit`, `cancel`, `viewImage`. |
| `history-preload.cjs` | `contextBridge` for the **History** window: `onData`, `refresh`, `screenshot(id)`, `viewImage`. |
| `image-preload.cjs` | `contextBridge` for the **image viewer**: `onData`, `sized(w,h)`. |

Preloads are `.cjs` because the app is ESM (`"type": "module"`) and Electron
preload scripts must be CommonJS.

### `renderer/` — window UIs (sandboxed)

Each window runs with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, a strict CSP, and all navigation / `window.open` denied. They talk
to the main process only through their preload bridge.

| Files | Window |
| --- | --- |
| `prompt.{html,css,js}` | The **fill prompt**: one proof screenshot (tap to enlarge), session/url chips, the agent's message, and one masked input per field (reveal toggle, `length` cap, `format` constraint). Send / Cancel. |
| `history.{html,css,js}` | The **History** window: list of past requests (status, session, url, fields, time) with a *View screenshot* toggle. |
| `image.{html,js}` | The **full-size screenshot viewer** (opened from the prompt or History; the window fits the image's natural size). |

### Windows & IPC

The main process owns the WebSocket and three `BrowserWindow`s — **prompt**,
**history**, **image** — created on demand. Data flows main → renderer over the
preload bridge (e.g. `keeper:request`, `history:data`, `image:data`) and back via
IPC (`keeper:submit`, `history:screenshot`, `keeper:view-image`). The typed value
travels renderer → main → WebSocket only; it is never written to disk or logged.

## Runtime data (on your machine)

History and proof screenshots are stored **per service base URL**, so a dev and a
prod Keeper keep separate stores automatically:

```
~/.remote-browser-keeper/
└── <base-url>/                         # e.g. rb.example.com, rb.dev.example.com
    ├── history.jsonl                   # value-free request log (newest appended)
    ├── cards.json                      # OPTIONAL saved cards for card auto-fill
    ├── screenshots/
    │   └── <request_id>.jpg            # proof image for that request
    └── logs/
        └── keeper.log                  # stdout/stderr, only when launched detached (nohup)
```

- `<base-url>` is the service URL with the scheme stripped and unsafe characters
  replaced (`https://rb.dev.example.com` → `rb.dev.example.com`).
- **`history.jsonl`** — one JSON object per line, **never containing values**:
  `request_id`, `session_id`, `url`, `requested_at`, `resolved_at`,
  `outcome` (`submitted` | `cancelled` | `autofilled`), a `screenshot` path, and
  per-field metadata (`selector`, `label`, `field`, `length`, `format`). Eviction
  runs on every write: keep the most recent **2000** entries and drop anything
  older than **~6 months**.
- **`screenshots/<request_id>.jpg`** — the same proof image the prompt showed.
  Evicted together with its history entry (orphans are reconciled on each write).

### `cards.json` — saved cards for unattended auto-fill (optional)

Per-env (like history/logs), so dev test cards and prod cards stay separate:
`~/.remote-browser-keeper/<base-url>/cards.json`. When the service sends a `request_fill`
whose fields are **all** `card-*` kinds, the Keeper auto-fills **silently — no
prompt — only on a site the card is approved for** (per-domain permission). On any
other site the prompt shows with a **"Use a saved card"** picker and a **"Auto-fill
on this site next time"** checkbox; ticking it records the domain on that card.
The proof screenshot + field metadata are still recorded in history (outcome
`autofilled`); card **values are never logged**. Copy [`cards.example.json`](../cards.example.json)
and edit, or manage cards (and their approved sites) from the tray **Cards…** window.
Shape: `{ autofill, default, cards: { <id>: { holder, number, cvv, exp_month,
exp_year, domains: ["amazon.com"], billing: { address_line1, address_line2, city,
zip, state, country } } } }`.

- **`domains`** — sites this card auto-fills on without a prompt. Matched against
  the request URL's host (`www.` stripped; a parent domain like `shop.com` also
  covers its subdomains). Empty/absent → the card is never silent; it's only
  offered in the picker.
- **`autofill: false`** — a master kill switch: never auto-fill silently, even on
  approved domains (the picker still works).

- `card-exp` is rendered to the request's template (`MM/YY`, `MM/YYYY`, `YY`, `MM`).
- `card-billing-address` maps by `format` (`ZIP`/`STATE`/…); no format → the whole
  address joined.
- If a **core** value (number/cvv/exp/holder) is missing, the Keeper **prompts
  instead** (e.g. omit `cvv` to be asked for it each time). Disable entirely with
  `"autofill": false`.

> ⚠️ **Security:** this stores card data — including, if present, the **CVV** — in
> **plaintext** on disk (`chmod 600`). Only you use this machine; treat it like
> browser autofill. If you'd rather not store the CVV at rest, omit it and the
> Keeper will prompt for just the CVV. **Planned:** move card (and secret) data to
> the **macOS Keychain** (OS-encrypted at rest) — see the service repo `docs/TODO.md`.

### Electron user-data dir (separate)

Electron's own `userData` (Chromium cache, GPU state, etc.) is **not** where
history lives. When running two instances (dev + prod), give each its own
`--user-data-dir` so their Electron internals don't collide — the history stores
are already separated by base URL above.

## Configuration & launch

| Env | Meaning |
| --- | --- |
| `RBS_URL` | Service base URL (default `https://rb.example.com`). Also selects the history folder. |
| `AC_API_KEY` / `RBS_API_KEY` | API key inline. |
| `AC_API_KEY_FILE` | Path to a file holding the API key (e.g. `~/.ac-dev-api-key`). |
| `~/.ac-api-key` | Default key file if none of the above is set. |
| `KEEPER_TEST=1` | Force a test prompt on startup. |

Running both environments at once (detached):

```bash
# dev
mkdir -p ~/.remote-browser-keeper/rb.dev.example.com/logs
AC_API_KEY_FILE=~/.ac-dev-api-key RBS_URL=https://rb.dev.example.com \
  nohup ./node_modules/.bin/electron . --user-data-dir="$HOME/Library/Application Support/remote-browser-keeper-dev" \
  > ~/.remote-browser-keeper/rb.dev.example.com/logs/keeper.log 2>&1 < /dev/null & disown

# prod (uses ~/.ac-api-key)
mkdir -p ~/.remote-browser-keeper/rb.example.com/logs
RBS_URL=https://rb.example.com \
  nohup ./node_modules/.bin/electron . --user-data-dir="$HOME/Library/Application Support/remote-browser-keeper-prod" \
  > ~/.remote-browser-keeper/rb.example.com/logs/keeper.log 2>&1 < /dev/null & disown
```

## Builds & CI

The repo is **[all-completed/remote-browser-keeper](https://github.com/all-completed/remote-browser-keeper)**.
[`.github/workflows/build.yml`](../.github/workflows/build.yml) packages the app
with **electron-builder** on a 3-runner matrix, each producing both architectures
(artifacts are **unsigned** in CI):

| Runner | Targets | Arches |
| --- | --- | --- |
| `macos-14` | `dmg`, `zip` | x64 (Intel), arm64 (Apple Silicon) |
| `ubuntu-latest` | `AppImage`, `tar.gz` | x64, arm64 |
| `windows-latest` | `nsis` installer, `portable` | x64, arm64 |

Each job uploads a `remote-browser-keeper-<platform>` artifact. The build runs on
every branch push and via **workflow_dispatch**. Locally: `npm run dist` (current
OS). electron-builder config lives in `package.json` under `build`.

## Related

- Wire protocol + field `length`/`format`: documented in the project README.
