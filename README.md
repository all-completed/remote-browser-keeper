# Remote Browser Keeper

A small **tray-resident Electron app** that supplies passwords/logins to remote
browser sessions **without the value ever reaching the AI model**.

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
   auto-reconnects. It stays hidden in the system tray.
2. Agent calls `POST /api/sessions/{id}/request-fill` with `{selector, label, field}`
   (no value). Service registers a pending request and pushes `fill_request` to the
   user's connected Keeper(s).
3. Keeper shows a small always-on-top prompt: the label (e.g. *"Password for
   web.telegram.org"*) and a masked input. User submits (or cancels).
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
  "screenshot": "data:image/jpeg;base64,…" }
```
Keeper → server:
```json
{ "type": "fill_response", "request_id": "uuid", "value": "..." }
{ "type": "fill_response", "request_id": "uuid", "cancelled": true }
{ "type": "hello", "app": "remote-browser-keeper", "version": "0.1.0" }
{ "type": "pong" }
```
Server → keeper (liveness): `{ "type": "ping" }`.

The agent calls `request_fill` (returns a `request_id`, status `pending`) and polls
`get_fill_status` until `filled` / `cancelled` / `timeout` / `error`.

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

Config: `RBS_URL` (your service base URL, e.g. `https://rb.example.com`),
`AC_API_KEY` / `~/.ac-api-key`.

## Files

Full layout — source tree, windows/IPC, and the on-disk data store — is in
[docs/file-structure.md](docs/file-structure.md). In short:

- `src/main.js` — main process: tray, keeper WS client (reconnect), prompt /
  history / image windows, IPC, and per-URL history storage
- `src/config.js` — base URL + API key resolution
- `src/*-preload.cjs` — `contextBridge` bridges for the prompt / history / image windows
- `renderer/{prompt,history,image}.*` — the window UIs
- `~/.remote-browser-keeper/<base-url>/` — history (`history.jsonl`) + proof
  `screenshots/`, kept separate per service URL
