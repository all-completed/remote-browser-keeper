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
├── scripts/
│   └── ui-components-credential.sh  # CI: read access to the private @f-proj/ui-components
├── src/                    # Electron main process + the one preload (Node side)
│   ├── main.js
│   ├── config.js
│   ├── windowstate.js
│   ├── preload.cjs         # the main window's preload
│   ├── approval-preload.cjs # the approval window's (request channels only)
│   └── assets/             # tray template PNGs (unchanged) + the window's app icon
├── ui/                     # the windows' UI (sandboxed, no Node access) → renderer-dist/
│   ├── app.html, main.jsx, App.jsx, brand.js            # the main window
│   ├── approval.html, approval.jsx, ApprovalApp.jsx     # the approval window (issue #34)
│   ├── pages/              # Approvals, History, Cards, Saved fields, Headless, Pair, Vault password, Settings
│   ├── components/, lib/, styles/app.css
└── test/                   # node --test; test/fake-electron/ runs main.js without Electron
```

### `src/` — main process (Node)

| File | Responsibility |
| --- | --- |
| `main.js` | The whole main process: the tray lifecycle (a dock icon only while the window is open), the **Keeper WebSocket client** (connect/reconnect, `hello`/`ping`/`pong`, receive `fill_request`, send `fill_response`), the **main window** (its pages) and the **approval window** (the approval queue on screen and its render supervision — see [Windows & IPC](#windows--ipc)), the **tray menu** (service host + connection state, a page per entry, Quit), and **local history + screenshot storage** (see below). |
| `config.js` | Resolves `{ baseUrl, apiKey }` — `RBS_URL` / default `https://rb.example.com`, and the API key from `AC_API_KEY` / `RBS_API_KEY` / `AC_API_KEY_FILE` / `~/.ac-api-key`. Also derives `keeperWsUrl`. |
| `device.js` | This device's identity (`device.json` id, machine name, platform, app version) and the inert vault-state report sent on connect / shown in Settings — see [`device.json`](#devicejson--who-this-device-is). |
| `enroll.js` | Trading the shared account key for a token of this device's own (issue #15): when to ask, what a service's answer means, and when a token has been revoked. Electron-free so the decision table is unit-tested. |
| `devicetoken.js` | Where that token lives — `device-token.json`, OS-encrypted like the card store, per base URL. Never touches the account key. |
| `historyapi.js` | Client for the **service's** copy of the request history: `GET /api/sessions/fill-history` and `.../{request_id}/screenshot`. Never throws — an unreachable service returns `{ ok: false, error }`. |
| `deadline.js` | Reads a request's **absolute deadline** off the `fill_request` frame (`expires_at`/`deadline`, or `created_at` + `timeout_s`); `null` when the frame carries none. Pure — the countdown and the expiry timer in `main.js` both hang off it. |
| `outbox.js` | Holds a `fill_response` / `secret_response` the socket could not take and re-sends it when the link is back, so an answer given during an outage is not silently lost (issue #19). In memory only (it holds values), bounded by the request's own deadline, and the record of what has already been answered — a replayed `fill_request` must not prompt twice. Pure — the socket is injected. |
| `historymerge.js` | Unions the local log with the service's list on `request_id` and tags each row `local` / `server` / `both`. Pure; see [Request history — one list from two](#request-history--one-list-from-two). |
| `declinereason.js` | The optional note a user attaches when **declining** (`DECLINE_PRESETS`, `DECLINE_REASON_MAX`, `normalizeDeclineReason`). Shared by the prompt UI and the main process, which re-normalizes whatever the renderer sends. Plain text meant for the agent — never a value. |
| `onetimecode.js` | **One-time codes (field kind `code`) are never saved and never replayed** (issue #24): `isOneTimeCode`, `autofillValues` (the silent-fill decision — any code field sends the request to the prompt, even if an earlier build stored one) and `savableValues` (what `keeper:save-fields` may store — never a code, judged by the pending request's kinds). Pure; shared by the main process and the prompt, which hides the save control for a codes-only request. |
| `ipcsender.js` | **Who may send a given IPC message.** `rendererUrl(page, …)` is the single definition of "one of our own documents" — used both to load a window and to check that a message really came from it; `refuseSender(sender, allowed)` is the decision. Pure; see [Windows & IPC](#windows--ipc). |
| `headless.js` | **Headless Keepers** (rbkeeper-unlock-v1, issue #26): the `hk1_` id and `rbk1-` fingerprint of a daemon key, vault pins (`headless_keepers`), Ed25519 verification of an `unlock_request`, the replay guard, the comparison code, the HPKE seal of the unlock payload, and the service calls (register / delete a headless Keeper, revoke older boot tokens, enroll the new one with `secret_bound: false`). Pure apart from the injected `fetch`; see [`rbkeeper-unlock-v1.md`](rbkeeper-unlock-v1.md). |
| `windowstate.js` | The window's remembered size, position and maximized state (`window.json` in Electron's userData), and the fallback to a centred default when the monitor it was on is gone. Ported from Getway Chat desktop. Pure. Opens **maximized** unless the saved state says `maximized: false` (issue #31) — so a first launch fills the screen; `main.js` applies it when the window is first shown, since Electron's `maximize()` would show a hidden window. |
| `preload.cjs` | The main window's `contextBridge` preload (issue #28): `keeperApp` (page navigation + status, and *Show approval window*), `keeperHistory`, `keeperCards`, `savedFields`, `keeperPair`, `keeperVault`, `keeperHeadless`, `keeperSettings` — the same bridge names the separate windows' preloads used. No request bridge: nothing is answered from the main window (issue #34). |
| `approval-preload.cjs` | The approval window's preload (issue #34): `keeper` (fill requests), `keeperUnlock`, and a read-only `keeperApp` (`state` / `onStatus`, for "N more waiting"). Nothing else — no history, cards, saved fields, pair QR or settings. |

Preloads are `.cjs` because the app is ESM (`"type": "module"`) and Electron
preload scripts must be CommonJS.

### `ui/` — the main window and the approval window (sandboxed)

Since issue #28 the Keeper has **one** main `BrowserWindow`, and since issue #34 a small
**approval window** beside it for the request waiting for the user. Both run with
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a strict CSP, and
all navigation / `window.open` denied. The main window's UI is one vite entry (`ui/app.html` →
`renderer-dist/app.html`) built on rsuite and the shared
[`@f-proj/ui-components`](https://github.com/vasyaod/ui-components): an `AppShell`
(sidebar, brand block, collapsible rail, phone drawer under 768 px) whose nav entries are
the pages below, each a `PageHeader` + `PageBody`. The tray opens the window on a page;
the sidebar moves between them in place.

| Page | What used to be |
| --- | --- |
| `pages/ApprovalsPage.jsx` | what is waiting (*N fill requests and M headless Keepers waiting* + **Show approval window**) and the tray's warnings. Requests themselves are answered in the approval window, below. |
| `pages/HistoryPage.jsx` | the **History** window — one list from this device's log **and** the service's ([details](#request-history--one-list-from-two)). |
| `pages/CardsPage.jsx`, `SavedFieldsPage.jsx`, `HeadlessPage.jsx`, `PairPage.jsx`, `VaultPasswordPage.jsx`, `SettingsPage.jsx` | the windows of the same names. |
| `components/ImageViewer.jsx` | the **full-size screenshot** window — now an in-app full-size modal. |
| `components/ListFilters.jsx`, `lib/search.js` | the **search box and filter pickers** of every long list (History, Saved fields, Cards, Headless Keepers — issue #31): `PageHeader`'s filter row, filtering client-side what the page already holds (every word of the query must appear; pinned by `test/search.test.mjs`). |

`ui/brand.js` is the brand the shell wears: the name, the app icon and the service colour
(the accent and rsuite's primary palette). Both are the icons registry's
(vasyaod/icons#11): the flat browser-window-and-key icon and emerald `#2BA673`.

Layout (issue #31, `styles/app.css`): the sidebar's brand block and the title bar are one
56 px band with one divider under it; each page is a `.page-wrap` column that fills the
content area up to 1680 px (a maximized 1920 px screen) and is centred beyond it. Lists are
ui-components `ResponsiveTable`s (stacked cards on a phone), forms and details are bordered
cards in `.card-grid` / `.split` grids that follow the column's width (container queries),
and a single request or form (Approvals, Pair phone, Vault password) is a centred 880 px
column.

#### The approval window (issue #34)

`ui/approval.html` → `renderer-dist/approval.html`, `ui/ApprovalApp.jsx`: a compact
window (520 × 680, resizable) that holds what the **fill prompt** and the **Headless Keeper
restarted** windows held before issue #28 — `components/FillRequest.jsx` (proof screenshot —
click to enlarge — session/url chips, the agent's message, one masked input per field,
Send / Cancel with a **▾** for [decline reasons](#declining-with-a-reason)) and
`components/UnlockRequest.jsx` (code, Approve / Deny). It wears the main window's `AppShell`
— the same dark theme and the brand's emerald palette on every rsuite control — with no
navigation; the shell's empty drawer and burger are hidden (`.approval-shell` in
`styles/app.css`) and the app icon is the title bar's icon. One fill request at a time,
with "N more waiting after this one" under it.

### Headless Keepers (rbkeeper-unlock-v1)

A page of the main window and a prompt of the approval window:

- **Headless Keepers** (tray → *Headless Keepers…*) — `ui/pages/HeadlessPage.jsx`: the
  pinned headless Keepers, and **Add headless Keeper** (a name + the daemon's Ed25519
  public key). The page shows the key's `rbk1-…` fingerprint, and *Add* stays disabled
  until the owner confirms it matches the daemon's. Add registers the key with the service,
  checks that the service's `headless_id` equals the local one, then pins it in the vault
  blob (`headless_keepers`) and syncs.
- **Headless Keeper restarted** — `ui/components/UnlockRequest.jsx`, in the approval
  window: when a verified `unlock_request` arrives the approval window comes up (always on
  top; the main window is not touched). It shows the pinned name, the restart time and the
  comparison code, and offers **Deny** / **Approve**. Nothing is ever approved without a
  click, and closing the window is not an answer; the request stays in the tray and goes
  on `unlock_resolved` or after about 5 minutes.

The protocol, the pins and the failure behaviour are in
[`rbkeeper-unlock-v1.md`](rbkeeper-unlock-v1.md).

### Windows & IPC

The main process owns the WebSocket and two kinds of `BrowserWindow`:

- the **main window** (issue #28), created on demand — by a tray entry or the dock icon,
  **never by a request** — and hidden, never destroyed, when the user closes it. Main tells
  its renderer which page to show (`app:navigate`) and what the tray knows (`app:status`:
  connection, queue sizes, warnings); the renderer reports the page the user moved to
  (`app:page`) and asks for the approval window back (`app:show-approval`). History data
  flows over `history:data`.
- the **approval window** (issue #34), created when a request arrives and destroyed once
  nothing waits. Request data flows main → it over its preload bridge (`keeper:request`,
  `keeper:request-gone`, `keeper:expired`, `unlock:changed`, plus `app:status` for the
  queue size) and back via IPC (`keeper:submit`, `keeper:cancel`, `unlock:approve`, …).
  The typed value travels renderer → main → WebSocket only; it is never written to disk or
  logged.

**The main window is left alone.** A request never shows, raises, restores, focuses or
navigates it — whether it is closed, minimized, behind other apps or full screen — and
never shows the dock icon. On macOS the approval window is a **non-activating panel**
(Electron `type: "panel"`): showing and focusing it gives it the keyboard without
activating the app, which would bring the main window forward with it (or switch to the
main window's Space when that is full screen); a panel also floats over full-screen apps on
every Space. On Windows and Linux focusing one window does not raise another. The approval
window is `alwaysOnTop` (`screen-saver` level), not minimizable, and has no taskbar entry —
the tray lists what waits.

**A request on screen** keeps every rule the prompt window had (issue #3): the approval
window stays hidden until the renderer reports the request painted
(`keeper:prompt-rendered`); the request is both pushed and pullable
(`keeper:pending-request`); and if it is not on screen within `KEEPER_RENDER_TIMEOUT_MS`
it is answered `keeper_ui_failed` (a hidden window whose document never came up is thrown
away). An unlock request, which is not render-supervised, shows the window on its first
paint.

**Several requests** are one queue: one fill request on screen at a time, the next one
handed to the same window as soon as the current one is answered, dismissed or expired,
and every one listed in the tray (*Approve: <site>* brings the window back with that
request next). Closing the approval window while a fill request is on screen declines it,
as closing the prompt window did; the next one in the queue then comes up in a fresh
window. A headless-Keeper request is not answered by a close. Closing the main window
answers nothing.

**Every handler validates its sender** (`src/ipcsender.js`, issue #18). `ipcMain` has
no notion of which renderer a channel belongs to, so a handler that answers whoever asked
serves *every* renderer and frame — and the ones that carry a secret (`pair:qr`,
`fields:reveal`, `keeper:card-values`, `keeper:saved-values`, `cards:load`) or answer a
pending request (`keeper:submit`) would serve it to whichever asks first. So each handler
starts with `fromWindow(event, channel, …windows)`, naming the window(s) it serves, which
requires all three of:

1. the sender **is** one of those windows (identity, by `webContents.id`);
2. the message came from its **top frame**, not an embedded one;
3. that frame is still showing **our own document** — `rendererUrl("app")` /
   `rendererUrl("approval")`, the very URL `loadWindow` put there.

The request channels (`keeper:*` for the fill request on screen, `unlock:*`) serve the
approval window only; every other channel serves the main window only; `app:state` and
`keeper:vault-status` serve both.

The preload bridge is the first layer; this is the layer under it, for anything that gets
past isolation. A refusal is logged (`[keeper] refused IPC "<channel>": <reason>`) and the
handler returns its ordinary "nothing" — `null` / `[]` / `{ ok: false }` — never an error
that would confirm the channel exists.

What one main window gives up: with ten windows, a page could only reach its own channels, so
History (which renders the service's data and screenshots) could not have asked for the
pair QR even with its renderer compromised. In one renderer every page's bridge is there.
The approval window takes some of that back: the renderer that shows the agent's message
and proof screenshot reaches only the request channels, and the main window's renderer can
no longer read or answer a request.
What stays: the renderer is still sandboxed and context-isolated under a CSP of
`script-src 'self'` with no remote content, every string from the service is rendered as
React text, images only as `data:` URLs, navigation and popups are denied, and the
values that matter most never enter the renderer at all (the pair QR's token is inside an
image main draws; the unlock key is sealed in main).

### Declining with a reason

A bare `cancelled` looks the same to the agent whether the user meant *"wrong account"*,
*"not now"*, or *"I already did this myself"* — three answers that call for three different
next moves. So a decline may carry the user's own short note:

- the prompt's **▾** (right of Cancel) opens a panel **in place**: five one-tap presets for
  the common declines, plus a free-text input for anything else;
- **Cancel alone is untouched** — one tap, no note, byte-for-byte the frame it always sent;
- the note goes out as `reason` beside `cancelled: true` (the field `keeper_ui_failed`
  already uses; a user decline carries no `error`), is written to `history.jsonl`, and is
  shown under that request in **History…** (`declined: …`) — only this device records it,
  so the merge carries it onto the row even when the service knows the request too;
- it is normalized in `src/declinereason.js` — trimmed, collapsed to one line, capped at
  `DECLINE_REASON_MAX` (200), and **omitted entirely** when blank — first in the renderer
  and again in main, which is the authority on what reaches the wire;
- it is **ordinary text the model is meant to read**: its input is unmasked, never
  prefilled from a saved value / card / vault, and never joins the `values` map.

The agent only sees it once the service carries `reason` through the cancel path into
`get_fill_status` (see the note in the README's WS protocol section).

`history:data` carries `{ items, server }` — the merged rows plus
`server: { state: "loading" | "ok" | "error", … }` — and main pushes it **twice** per
refresh: the local log at once, then the union when the service's list settles.

## Runtime data (on your machine)

History and proof screenshots are stored **per service base URL**, so a dev and a
prod Keeper keep separate stores automatically:

```
~/.remote-browser-keeper/
└── <base-url>/                         # e.g. rb.example.com, rb.dev.example.com
    ├── history.jsonl                   # value-free request log (newest appended)
    ├── secrets.enc.json                # session-unlock secrets (by secret_id), OS-encrypted
    ├── secrets.json                    # plaintext provisioning inbox — absorbed into
    │                                   # secrets.enc.json and removed on the next read
    │                                   # (no cards.json — saved cards live only in the synced vault)
    ├── device.json                     # this device's stable id (non-secret label)
    ├── device-token.json               # 🔒 this device's OWN service token, if enrolled
    ├── fields.json                     # "forever" saved field values (this device only)
    ├── vault.json                      # "vault" saved fields — local cache of the synced vault
    ├── screenshots/
    │   └── <request_id>.jpg            # proof image for that request
    └── logs/
        └── keeper.log                  # stdout/stderr, only when launched detached (nohup)
```

- `<base-url>` is the service URL with the scheme stripped and unsafe characters
  replaced (`https://rb.dev.example.com` → `rb.dev.example.com`).
- **`history.jsonl`** — one JSON object per line, **never containing values**:
  `request_id`, `session_id`, `url`, `requested_at`, `resolved_at`,
  `outcome` (`submitted` | `cancelled` | `autofilled` | `ui_failed`), a `screenshot`
  path, per-field metadata (`selector`, `label`, `field`, `length`, `format`), and —
  only on a decline the user explained — a `reason` (their own words, never a value).
  Eviction runs on every write: keep the most recent **2000** entries and drop
  anything older than **~6 months**. Eviction no longer *hides* a request: an evicted
  entry the service still knows about comes back in the History window as
  **server only** (next section).
- **`screenshots/<request_id>.jpg`** — the same proof image the prompt showed.
  Evicted together with its history entry (orphans are reconciled on each write).
  The service keeps its own copy, so *View screenshot* still works afterwards.

## Request history — one list from two

There are **two** histories of the same requests, and either can hold one the other
never saw:

| | this device — `history.jsonl` | the service — `GET /api/sessions/fill-history` |
| --- | --- | --- |
| written when | the prompt is answered here (`recordHistory`) | the request reaches a terminal state (`server/keeper.py` `_finish`) |
| calls the outcome | `outcome`: `submitted` \| `cancelled` \| `autofilled` \| `ui_failed` | `status`: `pending` \| `filled` \| `cancelled` \| `timeout` \| `no_keeper` \| `error` |
| times | ISO strings | epoch seconds |
| **only here** | an **offline submit** (history is written before the send, and the send no-ops on a closed socket); **`ui_failed`**, which reaches the service only as a generic `cancelled` | **`no_keeper`** and **`timeout`** (nothing was ever answered here); anything a **different paired device** answered — the service fans a `fill_request` out to *every* connected keeper, and the ones that lose the race only get a dismissal, which records nothing |

The History window shows the **union**, so "not in the list" means "it did not happen
on this account" rather than "this laptop didn't see it". Both sides key on the same
server-minted `request_id`, so a request is matched, never duplicated.

**Precedence** (implemented in `src/historymerge.js`, pinned by `test/history.test.mjs`):

1. **Provenance** — each row is tagged **client only** / **server only** /
   **server + client**, derived *only* from which list(s) the `request_id` was found
   in. Never inferred from a status. While the service's list is unavailable the tag
   reads just **client**: the request may well exist there too, we simply couldn't ask.
   (The tags name the two sides rather than saying "both", which only means something
   once you already know what the two lists are. The `source` field underneath keeps
   its `local` / `server` / `both` values — that is data, not wording.)
2. **Status** — the service's `status` is authoritative for *what happened to the
   request* (it alone sees the fill succeed or error, the expiry, another device
   answering); the local `outcome` is authoritative for *what this device did*.
   **Neither overwrites the other.** When they disagree the row shows both values,
   labelled by source (`client: ui_failed` · `server: cancelled`). `submitted`/`autofilled`
   ↔ `filled` and `cancelled` ↔ `cancelled` are the same event and collapse to one badge;
   everything else — including `ui_failed` vs `cancelled` — is shown as a disagreement,
   because the local word is the more specific one and exists nowhere else.
3. **Time** — the service's clock orders any request it knows about; local-only rows
   necessarily use the local clock.
4. **Screenshots** — *View screenshot* asks main, which reads the local JPEG first and
   falls back to the service's proof (`/fill-history/{request_id}/screenshot`). A row
   whose image lives only on the other side still shows it; the button appears only when
   at least one side reports having one.
5. **Degradation** — the window paints the local log immediately and repaints when the
   service's list lands, so it never blocks on the network. No key / offline / HTTP error
   ⇒ local-only **with the reason shown in the window**; the list is never emptied, and
   the 8 s timeout means it can never hang.

The API key stays in the main process: the History window is sandboxed under a
`default-src 'self'` CSP and does no networking of its own.

## Sensitive data — secrets & cards

The Keeper holds two kinds of sensitive data, both **per service base URL** (so dev
and prod are isolated) under `~/.remote-browser-keeper/<base-url>/`:

| | `secrets.enc.json` | `cards.json` |
|---|---|---|
| **What** | session-encryption secrets, keyed by `secret_id` (`= sha256(secret)`) | saved payment cards for auto-fill |
| **Used for** | answering the service's `secret_request` to unlock encrypted sessions (zero-knowledge) | unattended/assisted card `request_fill` |
| **Written by** | the Keeper, absorbing the `secrets.json` inbox the external `scripts/export_session_secret.py` (service repo) writes | the tray **Cards…** window (or hand-edit) |
| **At rest** | **OS-encrypted** via `safeStorage`, `chmod 600`; where no backend exists the plaintext inbox is kept instead (`chmod 600`) and that is logged | **OS-encrypted** via `safeStorage` where a backend exists, else plaintext `chmod 600` |
| **Leaves the machine?** | only the secret value, over the authenticated Keeper WS, when the service asks for that `secret_id` | only field values, over the same WS, into the page; never logged |

### `secrets.enc.json` — session-unlock secrets

`~/.remote-browser-keeper/<base-url>/secrets.enc.json`, OS-encrypted, `chmod 600`. Shape
(inside the envelope):
`{ base_url, secrets: { <secret_id>: { secret, label, user_id, source } } }` where
`secret_id = sha256(secret)`. When the service sends a `secret_request` for a
`secret_id` (reopening an encrypted session without the API-key secret), the Keeper
looks it up here, verifies `sha256(secret) == secret_id`, and returns the secret
over the WS. The service holds it **in memory only** for the session and never logs it.

Provisioned by the service repo's `scripts/export_session_secret.py` (it extracts the
secret from an API key and writes it out). Because that external writer can't use
Electron `safeStorage`, it still writes plaintext — but to `secrets.json`, which is an
**inbox, not the store**: the first Keeper read folds its entries into the encrypted
`secrets.enc.json` and **removes it**, so no plaintext copy stands. The fold **merges**,
so the external writer's fresh file can never drop a secret already held (dropping one
would leave an encrypted session permanently unopenable). Nothing else changes for the
script — keep writing `secrets.json` exactly as before.

Where there is **no OS backend at all** (headless Linux, or running outside Electron)
nothing is silently written in the clear: the inbox is left as the single copy, held to
`chmod 600`, and the reason is logged once. Likewise a `secrets.enc.json` that exists but
cannot be read (corrupt, or an envelope this machine holds no key for) is logged as such
rather than read as "no secrets held" — see `readJsonState` in `src/securestore.js`.

An unreadable store is also never **written over**. A reset login keyring (or a reset
Windows profile, or a store copied from another machine) leaves the old envelope
undecryptable while encryption itself still works — those bytes come back if the key
does, so before absorbing an inbox on top of them the Keeper moves them aside to
`secrets.enc.json.unreadable` (`-2`, `-3`… when one is already parked there) and logs
where they went. To recover: restore the OS key they were encrypted with, then **merge**
them back rather than renaming the file over the newer store.

### Saved cards for unattended auto-fill — stored **only in the synced vault**

> **Cards live only in the synced vault now (no local `cards.json`).** At runtime the
> Keeper holds cards in memory, hydrated from the vault on each sync and pushed back on
> change (see the service repo `docs/vault-format.md`, `cards` collection). An existing
> legacy `cards.json` is migrated into the vault on first sync and then removed. Trade-off:
> card auto-fill needs the vault to have synced (on connect), so a cold start with no
> network has no cards until the first sync, and a card saved while offline isn't persisted
> until it reaches the vault. Cards are per-service (dev and prod vaults are separate).

When the service sends a `request_fill`
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

> 🔒 **At rest:** `cards.json` is **OS-encrypted** wherever a secure backend exists
> (Electron `safeStorage`): **macOS Keychain** (prompts once, "Always Allow" → silent
> thereafter), **Windows DPAPI** (per-user, no prompt), **Linux libsecret** (gnome-keyring
> / kwallet). The contents become an encrypted envelope, so the CVV/number aren't
> readable on disk. Only where there's **no backend** (e.g. headless Linux) does it
> fall back to a `chmod 600` plaintext file. Reads handle both, so an existing plaintext
> file **auto-migrates** to encrypted on the next save. If you'd still rather not keep
> the CVV at rest, omit it and the Keeper prompts for it. (Session secrets get the same
> OS encryption — `secrets.enc.json`; the plaintext `secrets.json` an external script
> writes is absorbed into it and removed on the next read.)

### `device-token.json` — this device's own service token (issue #15)

`~/.remote-browser-keeper/<base-url>/device-token.json`, OS-encrypted at rest exactly
like `cards.json`, holding `{token, device_id, secret_bound, enrolled_at}`.

Before per-device tokens, every Keeper on an account presented the *same* key, so a
device's identity was whatever it claimed in `hello`, and cutting one device off meant
rotating the account key — cutting off every other device and every script too. The
service now mints one token per device (service repo issue #33); on connect the Keeper
asks for one (`POST /api/keeper/devices/enroll`) and uses it from then on.

Three properties are deliberate and load-bearing:

- **Additive, never a cut.** The account key keeps working forever. A service that
  predates the feature answers 404/503, which is capability negotiation, not an error —
  the Keeper says so once and stays on the account key. Any doubt about the device token
  (revoked, unreadable, service can't see the record) falls back to the account key.
- **Per base URL**, like the vault key: a dev Keeper and a prod Keeper on one machine are
  two devices with two tokens.
- **Header only.** The service refuses device tokens presented as `?api_key=` precisely
  so they cannot leak through access logs; the Keeper sends it as `Authorization: Bearer`
  on the WS handshake, never in a URL.

> ⚠️ **Plaintext gap:** `securestore` falls back to a chmod-600 plaintext file where no OS
> secret backend exists (headless Linux without libsecret). That is the same exposure the
> card store already has, and it is not solved by this ticket — on such a host the device
> token is no worse protected than the account key in `~/.ac-api-key`, but no better.

Revoked from the Devices page, the service hangs up the socket (close 1008) or refuses
the upgrade (401). The Keeper drops the token, reconnects on the account key, and
re-enrolls once; if the replacement is refused too it stops trying for the run rather
than looping. The **Auth** row in Settings names which credential is live.

### `vault.json` — the synced vault (saved fields across devices)

`~/.remote-browser-keeper/<base-url>/vault.json`, OS-encrypted at rest exactly like
`cards.json`. When the fill prompt saves a value with the **"Save to vault (synced
across devices)"** scope (beside *"Until the Keeper restarts"* and *"Save securely on
this device"*), it lands here **and** is end-to-end encrypted and synced to every
paired Keeper through the service's `/api/vault` endpoint.

- **Zero-knowledge (key model v2, `src/vault.js` + `src/vaultkey.js`):** the value is
  encrypted client-side with a **dedicated vault password**, independent of the session
  secret and stored OS-encrypted in `vault-key.json` (see below). Two values are derived
  with **domain separation** so the identifier can never equal the key:
  `master = sha256(password)` (generated key) or `pbkdf2_sha256(password, salt)` (a
  user-set password); `encKey = master`; `secret_id = sha256("rbvault-id-v2" ‖ master)`.
  **AES-256-GCM**, envelope `iv(12)‖ct‖tag` (or `salt(16)‖iv‖ct‖tag` for pbkdf2),
  `format` = `aesgcm-sha256-v2` / `aesgcm-pbkdf2-v2`. The service stores only opaque
  ciphertext + the (non-key) `secret_id` — see the service repo `docs/vault-sync.md`.
  Plain-WebCrypto layout, so the mobile Keeper shares the same blob.
  > **v1 → v2 fix:** v1 set `secret_id = sha256(secret) === the AES key`, which the
  > service stored in plaintext (the key leaked). v2 domain-separates them. An existing
  > v1 vault is auto-migrated on first run (decrypt with the session secret → re-encrypt
  > under a fresh generated password → re-upload).
- **Sync (`src/vault.js`):** on connect and after each vault save/forget the Keeper
  pulls the remote blob, merges it into the local cache (per-entry **last-write-wins**
  by `updated_at`, deletes leave a tombstone so they propagate), and pushes the union
  back — retrying on the service's optimistic-`version` 409s. A `secret_id` mismatch on
  pull means the vault password changed elsewhere → the tray shows "re-pair to update".
- Provisioning: the pair QR (**Pair phone…**) carries the dedicated **vault password**
  (and the session `secret`) inside the image only — never as renderer text — so the
  mobile Keeper can decrypt the shared vault.

### `vault-key.json` — the vault's dedicated password

`~/.remote-browser-keeper/<base-url>/vault-key.json`, **OS-encrypted at rest** (Electron
`safeStorage` → macOS Keychain / Windows DPAPI / libsecret), holds `{ password, format,
salt? }`. The Keeper generates a high-entropy password on first use; the user may replace
it with their own via **Set vault password…** (which re-encrypts + re-uploads the vault,
after which other devices must re-pair). This file never leaves the machine except as the
vault password inside a pair QR.

### `device.json` — who this device is

`~/.remote-browser-keeper/<base-url>/device.json`, **plain JSON** (`{ "id": "<uuid>" }`) —
a label, not a credential. Minted on first use and reused forever after; per base URL, so
a dev and a prod Keeper on one machine are two distinct devices, as they already are for
every other file here.

`src/device.js` turns it into the report the Keeper sends in `hello` (and again as
`device_state` when it changes) and shows under **Settings… → This device**: the id, the
machine name, the platform, the app version, and the vault's `schema` / `key_format` /
last synced `version` / `state` (`ok` · `no_key` · `needs_repair` · `legacy_v1`). That
answers "which devices hold a vault, and is any of them on the legacy key model?" — the
last one being a security question, since v1's stored `secret_id` **is** the AES key.
Which is why the report of a v1 device carries its format and **no** `secret_id`
(`vaultKeyReport`, `src/vault.js`). Nothing in the report is a secret: no vault password,
no derived key, no field or card values.

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
| `KEEPER_TEST_TIMEOUT_S` | Deadline of that test prompt, in seconds (default 300) — set it low to watch the countdown run out. |

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
| `macos-15` | `dmg`, `zip` | x64 (Intel), arm64 (Apple Silicon) |
| `ubuntu-latest` | `AppImage`, `tar.gz` | x64, arm64 |
| `windows-latest` | `nsis` installer, `portable` | x64, arm64 |

Each job uploads a `remote-browser-keeper-<platform>` artifact. The build runs on
every branch push and via **workflow_dispatch**. Locally: `npm run dist` (current
OS). electron-builder config lives in `package.json` under `build`.

Before `npm ci` every job runs `scripts/ui-components-credential.sh`: the window's UI
depends on the **private** `vasyaod/ui-components` (a git dependency pinned to a SHA), so
the repo needs the `UI_COMPONENTS_DEPLOY_KEY` (or `UI_COMPONENTS_TOKEN`) secret — see
README → *Building it*. The Linux job also runs `npm test`, and every job checks that the
built CSS really carries the library's rules. rsuite and the library are
devDependencies: vite bundles them into `renderer-dist/`, and the packaged app carries no
copy of either package.

### Icons

The tray icon and the app icon have different sources, and **every raster is derived —
a stale one is what actually ships**.

| Source | Derived (committed) | Used by |
| --- | --- | --- |
| `src/assets/tray.svg` | `trayTemplate.png` (16×16), `trayTemplate@2x.png` (32×32) | `createTray()` in `main.js` — loaded by name, `@2x` picked up automatically |
| [vasyaod/icons](https://github.com/vasyaod/icons) `desktop/remote-browser-keeper/` (drawn by its `tools/gen_icons.py --desktop remote-browser-keeper`, issue #11) | `build/icon.icns`, `build/icon.ico`, `build/icon.png` (1024×1024); `src/assets/icon.png` (a copy of `build/icon.png`) | electron-builder (`package.json` → `build.mac/win/linux.icon`); the window/taskbar icon (`APP_ICON` in `main.js`) and the sidebar brand (`ui/brand.js`) |

The app icon is **not drawn here**: it is the service's icon on icons.f-proj.com, white
browser window + key on the service colour `#2BA673` (which `ui/brand.js` also uses as
the accent). To change it, change it in vasyaod/icons, then copy its files back:

```sh
# tray template — rasterise at exactly 16 and 32 px, black-on-transparent
rsvg-convert -w 16 -h 16 src/assets/tray.svg -o src/assets/trayTemplate.png
rsvg-convert -w 32 -h 32 src/assets/tray.svg -o 'src/assets/trayTemplate@2x.png'

# app icon — from a vasyaod/icons checkout
cp ../icons/desktop/remote-browser-keeper/icon.{icns,ico,png} build/
cp build/icon.png src/assets/icon.png
```

Two rules the rasters have to keep holding:

- **`trayTemplate*.png` stay black-on-transparent.** `setTemplateImage(true)` makes
  macOS discard the colour and use the alpha as a mask, tinting it for the current
  menu bar; a white PNG would be invisible in light mode.
- **The app icon stays the registry's.** Don't redraw or re-rasterise it here; a local
  edit drifts from icons.f-proj.com and from the colour in `ui/brand.js`.

`src/assets/tray.svg` is also **the same drawing** as the Android status-bar icon in
[all-completed/remote-browser-mobile](https://github.com/all-completed/remote-browser-mobile)
(`drawable/ic_stat_keeper.xml`): same 24×24 viewBox, same path data. One glyph,
rendered twice — black-on-transparent here, white-on-transparent there. **Mobile's
`branding/glyph-shield-keeper.svg` is the canonical drawing** — retouch it there,
then copy the `d` string back into `tray.svg` and regenerate the two PNGs.

The glyph is a **solid** shield with the keyhole punched out by an even-odd fill.
An outlined version shipped briefly (issue #5) and was rejected on sight: at 16 px
the shield edge and the keyhole ring are two thin concentric strokes that fight each
other, whereas the silhouette reads instantly. The mass is the mark — don't
re-outline it.

## Related

- Wire protocol + field `length`/`format`: documented in the project README.
