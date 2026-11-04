# Remote Browser Keeper

A small **tray-resident Electron app** that supplies passwords/logins to remote
browser sessions **without the value ever reaching the AI model**.

It is **one window** (issue #28): Approvals, History, Cards, Saved fields, Headless
Keepers, Pair phone, Vault password and Settings are pages of it, in the same dark
sidebar shell as Getway Chat and the other f-proj apps — the shared
[`@f-proj/ui-components`](https://github.com/vasyaod/ui-components) `AppShell` on
rsuite. The tray / menu-bar icon opens it on any page; closing it hides it and the
Keeper keeps running in the tray.

## Documentation

- [docs/file-structure.md](docs/file-structure.md) — source tree, window/IPC
  architecture, and the on-disk data layout (`~/.remote-browser-keeper/<base-url>/`)
- The WebSocket + request-fill wire protocol is documented inline below
  ([WS protocol](#ws-protocol-apikeeperws)).

## Goal

**Passwords and other credentials must never be passed to the model.** The agent
(LLM) may decide a field needs filling, but the secret itself is entered by the
user and typed into the page by the service — the model only ever learns *whether*
a field was filled, never *what* was filled. The credential's path is
`you → Keeper → service → form`; the model's path is `agent → request-fill → "filled"`.

To make this trustworthy, when the service requests a fill it also sends a
**screenshot of the area around the target field** to the Keeper, so the user can
*see* exactly which field on which page they are filling before entering a secret.

It's effectively a messenger: the remote browser service
sends a "please fill this field" signal, the Keeper pops up and asks you for the
value, and sends it straight back to the service. The **service** fills the form
field itself — the LLM only triggers the request and learns whether it succeeded,
never the value.

## Why

When an agent automates a logged-out site it hits password/2FA/login fields. We do
**not** want the model to see or handle those secrets. The Keeper moves the secret
out of band: `you → keeper → service → form`. The model's path is only
`agent → request-fill API → "filled"`.

## How it works

```
 ┌──────────┐   request-fill {selector,label}   ┌─────────────────────┐
 │  Agent   │ ────────────────────────────────► │ remote-browser-     │
 │  (LLM)   │ ◄──────── {status:"filled"} ────── │ service             │
 └──────────┘     (never the value)              │                     │
                                                 │  keeper WS registry │
                       fill_request  ┌───────────┤  pending requests   │
                       (over WS)     ▼           └─────────▲───────────┘
                              ┌────────────┐               │ fill_response {value}
   user types secret ──────► │  Keeper    │ ──────────────┘   (value → service → CDP fill)
   in tray popup             │  (this app)│
                             └────────────┘
```

1. Keeper connects to `wss://<host>/api/keeper/ws` (token sent as an `Authorization: Bearer` header, never in the URL) and
   auto-reconnects. It stays in the system tray until it has something to ask.
2. Agent calls `POST /api/sessions/{id}/request-fill` with `{selector, label, field}`
   (no value). Service registers a pending request and pushes `fill_request` to the
   user's connected Keeper(s).
3. Keeper brings its window up, over everything, on the **Approvals** page: the label
   (e.g. *"Password for web.telegram.org"*) and a masked input. User submits (or
   cancels — closing the window also declines). A window that a request brought up goes
   away again once nothing is waiting.
4. Keeper sends `fill_response {request_id, value}` back over the WS. The service
   fills the field via CDP using `fill` semantics, **discards the value**, and
   returns `{request_id, status:"filled"}` to the agent.

## WS protocol (`/api/keeper/ws`)

Server → keeper:
```json
{ "type": "fill_request", "request_id": "uuid", "session_id": "telegram",
  "selector": "#password", "label": "Password", "field": "password",
  "url": "https://web.telegram.org/k/",
  "message": "Logging into Telegram to read your unread chats",
  "expires_at": "2026-08-14T12:05:00Z",
  "screenshot": "data:image/jpeg;base64,…" }
```
`expires_at` is **optional, and the service does not send it yet** — see
[Time left](#time-left) for what the Keeper does with it, and what it does without it.

Keeper → server:
```json
{ "type": "fill_response", "request_id": "uuid", "value": "..." }
{ "type": "fill_response", "request_id": "uuid", "cancelled": true }
{ "type": "fill_response", "request_id": "uuid", "cancelled": true,
  "reason": "I already did this myself" }
{ "type": "fill_response", "request_id": "uuid", "cancelled": true,
  "error": "keeper_ui_failed", "reason": "content loaded but never painted" }
{ "type": "hello", "app": "remote-browser-keeper", "version": "0.1.0",
  "device": { "id": "6f1c…-uuid", "name": "vasyas-mbp", "platform": "macOS", "app_version": "0.1.0" },
  "vault": { "schema": 1, "has_key": true, "key_format": "aesgcm-sha256-v2", "legacy": false,
             "needs_migration": false, "secret_id": "a8ab…", "version": 7, "state": "ok" } }
{ "type": "device_state", "device": { … }, "vault": { … } }
{ "type": "pong" }
```

`device` + `vault` say **which device this is and which vault it holds**, so an account can
list its paired devices and see a version skew — or a device stuck on the legacy key model —
*before* it turns into a failed fill or a silent security gap. `device_state` repeats the
same two blocks whenever they change (after a sync, or after the vault password is
re-keyed); an unchanged state sends nothing. Both are **inert metadata** — no vault
password, no derived key, no session secret, no field or card values.

`vault.state` is the field to act on, and it keeps apart two failures that look identical
from outside:

| `state` | meaning | fix |
| --- | --- | --- |
| `ok` | on a v2 key model, vault readable | — |
| `no_key` | this device holds no vault key (never paired, or cleared) | pair it |
| `needs_repair` | a vault exists but this device can't decrypt it (`VaultKeyMismatch`) | re-pair it |
| `legacy_v1` | still on legacy `aesgcm-sha256-v1` | **migrate** — Set vault password… |

`secret_id` is the opaque, domain-separated id of the vault this device can open
(`sha256("rbvault-id-v2" ‖ master)`), so it is safe to publish and lets the service group
devices by vault. Under legacy `aesgcm-sha256-v1` the stored id **is** the AES key, so a v1
device reports its `key_format` and **`secret_id: null`** — see `vaultKeyReport` in
`src/vault.js`, which is the only place allowed to produce this field.

A **decline may say why**. `cancelled: true` on its own means only "dismissed", which reads
the same whether the user meant *wrong account*, *not now*, or *I already did this myself* —
three answers that call for three different next moves from the agent. The prompt therefore
offers a **▾ next to Cancel** that opens, in place, five one-tap presets plus a free-text
box; whatever is chosen or typed rides back as `reason` beside `cancelled: true` (no
`error` — that stays reserved for the UI failure below). Properties, all enforced in
`src/declinereason.js` and re-applied in main:

- **Cancel alone is unchanged** — one tap, no note, exactly the frame it sent before.
- The note is **trimmed, collapsed to a single line and capped at 200 characters**;
  blank / whitespace-only input sends no `reason` field at all.
- It is kept with the request in **History…** (`declined: …`), so the explanation no
  longer lives only in whatever chat the user typed it into.
- It is **ordinary text, written to be read by the model** — an unmasked input that is
  never prefilled from a saved value, a card, or the vault, and never joins the values
  map. A password does not belong in it and cannot get there by accident.

> **Service side:** the agent sees this only once the service carries `reason` from the
> cancel path into the `get_fill_status` payload (as it already does for `no_keeper`).
> Until then the Keeper sends it and the field is simply ignored, exactly as an older
> service ignores `keeper_ui_failed` — the decline itself still works.

`error: "keeper_ui_failed"` means the **approval page could not be shown** — the user was
never asked. It is deliberately distinct from a plain cancel (the user declined) and from a
timeout (the user was away): an automation that sees it should **stop**, not retry, since
retrying a login prompt nobody can approve just burns attempts against a lockout policy.
Older services that don't know the field still see a well-formed `cancelled` response.
Server → keeper (liveness): `{ "type": "ping" }`.

The agent calls `request_fill` (returns a `request_id`, status `pending`) and polls
`get_fill_status` until `filled` / `cancelled` / `timeout` / `error`.

### Time left

A request is not open-ended: the service waits `DEFAULT_FILL_TIMEOUT_S` (300s) and then
resolves it as `timeout`. The prompt therefore shows **how long is left**, counting down,
and retires itself when the time is up (it says so, then closes) instead of staying on
screen as a prompt that silently does nothing.

The remaining time is derived **only** from an absolute deadline on the wire, never from
when the frame arrived — the service **replays the same frame verbatim** to a keeper that
reconnects, so a phone woken by a push would start a fresh 5:00 on a request with thirty
seconds left, and a countdown that lies is worse than none. The Keeper accepts, in order:

| On the frame | Meaning |
| --- | --- |
| `expires_at` (or `deadline`) | the moment itself — ISO-8601, epoch seconds, or epoch millis |
| `created_at` + `timeout_s` | when the service started waiting, plus how long it waits |

A relative field (`expires_in`, `ttl`) is deliberately **ignored**: it is stale the moment
the frame is replayed. **Without either form the Keeper shows no countdown at all** — an
unknown deadline stays unknown rather than being invented. That is where things stand
today: the service sends neither, so the countdown appears only once `expires_at` is added
to `fill_request` server-side. See `src/deadline.js`.

### An answer is never dropped silently

The socket is not always up when the user finally answers: the prompt may be on screen for
the whole 300s, and a laptop sleeping, a wifi change or a service restart closes the link
underneath it, with a reconnect backoff of up to 30s behind that. Writing the answer to a
closed socket used to be a no-op, so the value the user had just typed went nowhere — and
the agent was told, 300s later, that nobody had answered.

So a `fill_response` / `secret_response` that cannot go out is **held and re-sent** when the
link is back; for an outage shorter than the request's deadline the user never learns there
was one, and until it lands the tray says *"⏳ n answer(s) waiting for the connection"*. A
replayed `fill_request` whose answer is still queued does **not** ask the user a second time.

What is still undeliverable once the request stops being answerable is **reported, never
forgotten**: an error in the log, a ⚠︎ in the menu bar, and an `undelivered` row in History
(shown next to the service's `timeout` — the two sides genuinely disagree about what
happened, and that gap is the point). The queue is in memory only, holds one answer per
request, and drops an answer — values with it — as soon as nobody can still be waiting for
it. See `src/outbox.js`.

## Security properties

- The value travels `keeper → service` only; it is **never** in the agent-facing
  API response and is **never logged** (service redacts and the request-fill
  handler returns only status).
- The masked input is `spellcheck/autocomplete/autocorrect=off` and cleared after
  send (same hardening as the VNC paste dialog).
- Auth: the Keeper uses your API key (`AC_API_KEY` env or `~/.ac-api-key`), so the
  service knows which user's sessions it may fill.

## Run

```bash
cd remote-browser-keeper
npm install
npm start          # tray app; a test prompt can be forced with KEEPER_TEST=1
```

### Building it

The window's UI depends on [`@f-proj/ui-components`](https://github.com/vasyaod/ui-components),
a **private** repo, as a git dependency pinned to a commit SHA (`package.json`
devDependencies; vite bundles it into `renderer-dist/`, so the packaged app carries the
built bundle, not the package). `npm install` therefore needs read access to it: a
machine signed in to GitHub has it; CI gets it from **one repo secret**, either

- `UI_COMPONENTS_DEPLOY_KEY` — an OpenSSH private key whose public half is a
  **read-only deploy key** on `vasyaod/ui-components` (preferred: scoped to that one
  repo, mintable unattended), or
- `UI_COMPONENTS_TOKEN` — a fine-grained PAT with *Contents: Read* on that repo.

`scripts/ui-components-credential.sh` (run by `.github/workflows/build.yml` before
`npm ci` on every runner) takes whichever exists and fails the build without one. To
mint the deploy key: generate an ed25519 pair in a temp dir, `POST
repos/vasyaod/ui-components/keys` with the public half and `read_only=true`, then pipe the
private half into `gh secret set UI_COMPONENTS_DEPLOY_KEY --repo
all-completed/remote-browser-keeper` on stdin — never on a command line, never printed.
This repo's CI uses the deploy key `remote-browser-keeper CI (read-only)` on
`vasyaod/ui-components`, provisioned by issue #30; to rotate it, delete that key and the
secret, then mint both again the same way.

Config: `RBS_URL` (your service base URL, e.g. `https://rb.example.com`),
`AC_API_KEY` / `~/.ac-api-key`.

### If an approval doesn't appear

A window that a request brings up is kept hidden until its renderer reports the request
is painted on the Approvals page, so a page that can't render is reported instead of
shown blank:

- the menu-bar icon shows **⚠︎** and the tray menu names the failure (click it to dismiss;
  the Approvals page shows it too);
- the log line is `[keeper] approval window failed to render: <cause>` (run `npm start`
  from a terminal, or `open -a "Remote Browser Keeper"` from one, to see it);
- the request is answered with `error: "keeper_ui_failed"` instead of being left hanging,
  and it appears in **History** with the outcome `ui_failed`;
- requests still waiting for you are listed in the tray menu under **Waiting for you**.

Two diagnostic switches, both off by default:

| Env | Effect |
| --- | --- |
| `KEEPER_RENDER_TIMEOUT_MS` | How long a prompt may take to appear before it is declared failed (default 15000). |
| `KEEPER_NO_CONTENT_PROTECTION=1` | Disables the screen-capture exclusion for one run, to rule it in or out as the cause of a window that won't paint. **Security trade-off: the Keeper window becomes capturable while it is set** — diagnosis only, never a normal way to run. |

## Files

Full layout — source tree, window/IPC, and the on-disk data store — is in
[docs/file-structure.md](docs/file-structure.md). In short:

- `src/main.js` — main process: tray, keeper WS client (reconnect), the one window
  (pages, the approval queue on screen, render supervision), IPC, and per-URL history
  storage
- `src/windowstate.js` — the window's remembered size/position (ported from Getway Chat)
- `src/config.js` — base URL + API key resolution
- `src/outbox.js` — answers the socket could not take: held, re-sent on reconnect,
  and reported if the request dies first ([above](#an-answer-is-never-dropped-silently))
- `src/historyapi.js` + `src/historymerge.js` — the service's copy of the request
  history, and its union with the local log: **History…** shows one list, each row
  tagged *local only* / *server only* / *both*
  ([details](docs/file-structure.md#request-history--one-list-from-two))
- `src/preload.cjs` — the one `contextBridge` preload (one bridge object per page)
- `ui/` — the window's UI (vite → `renderer-dist/app.html`): `App.jsx` (the AppShell and
  its nav), `pages/*Page.jsx`, `brand.js` (name, app icon, service colour)
- `~/.remote-browser-keeper/<base-url>/` — history (`history.jsonl`) + proof
  `screenshots/`, kept separate per service URL
