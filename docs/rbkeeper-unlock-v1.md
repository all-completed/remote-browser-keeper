# rbkeeper-unlock-v1 — the desktop half

A **headless Keeper** is a daemon on a server. It cannot type a vault password. When it
restarts, it asks the owner's desktop Keeper for one, and the owner approves it with a
click. This file is the desktop side: pinning a daemon, checking its request, and
sealing the answer. Umbrella: vasyaod/remote-browser-service#81. This part:
all-completed/remote-browser-keeper#26.

Code: `src/headless.js` (pure), wired up in `src/main.js` (section *Headless Keepers*).
Shared test vector: `test/vectors/rbkeeper-unlock-v1.json` (generated keys only).

## Keys

| Key | Who | Lifetime |
| --- | --- | --- |
| IK — Ed25519 | daemon | long-lived; its public half is pinned on the desktop |
| EK — X25519 | daemon | one per boot; the private half never leaves memory |

`headless_id` = `rbk1-XXXX-XXXX-XXXX`, the first 6 bytes of SHA-256 over the raw 32-byte
IK public key, as upper-case hex. The owner sees it when adding the daemon and can compare
it with what the daemon prints.

## Pinning (Tray → Headless Keepers…)

The owner pastes a **name** (`[A-Za-z0-9._-]{1,32}`) and the daemon's **base64 IK public
key**. The pin goes into the vault blob, so every desktop of the account trusts the same
daemons:

```json
"headless_keepers": {
  "rbk1-…": { "name": "build-box", "ed25519_pub": "<b64>", "added_at": "…", "updated_at": "…" }
}
```

It merges last-write-wins by `updated_at` like the other vault collections, and a removal
is a tombstone (`{ "deleted": true, "updated_at": … }`). A key already pinned under a
different name, or a name already used by another live pin, is refused. A pin whose key
does not hash to its id is ignored.

Order: pin → **sync the vault** → `POST /api/keeper/headless {id, name, ed25519_pub}`.
Removal: tombstone → sync → `DELETE /api/keeper/headless/{id}`. The service's list is only
a routing table. **Trust comes from the vault pin**, never from the service.

## The request

The daemon signs canonical JSON (keys sorted, no spaces) of exactly these fields:

```
{ type: "unlock_request", headless_id, boot_id, eph_pub, ts, nonce }
```

and sends them with `sig` (base64 Ed25519). The service adds `request_id` and `name`.
The desktop:

1. refuses anything malformed (`headless_id` shape, `boot_id` `[A-Za-z0-9._-]{1,64}`,
   32-byte `eph_pub`, 64-byte `sig`, integer `ts`, `nonce`);
2. looks up the **pin** for `headless_id` (`unknown` if none);
3. verifies `sig` against the pinned key (`bad-signature`);
4. requires `|now − ts| ≤ 15 min` (`stale`);
5. refuses a `nonce` or `request_id` it has already seen in this run.

A refusal is logged by reason only, and nothing is shown. The name on screen is the
**pin's** name. The service's `name` is never trusted.

## The window

*"<name> Keeper restarted"*: the restart time, the **comparison code** and Deny / Approve.

Comparison code = `XXXX-XXXX`, the first 4 bytes of SHA-256(`eph_pub` ‖ utf8(`boot_id`)).
The daemon prints the same code. If a relay swapped the EK, the two codes differ.

There is **no auto-approve**. The window closes on `unlock_resolved` (another desktop
answered) or after **10 minutes**.

## Approve

1. Enroll the boot's device token: `POST /api/keeper/devices/enroll` with
   `device_name: "headless:<name>:<boot_id>"`, `platform: "headless"`, `secret_less: true`.
2. **Fail closed:** unless the response says `secret_bound: false`, the minted device is
   revoked again, and nothing is sealed or sent. The window then says the service can't
   issue a secret-less token yet. (Until the service side ships that flag, Approve always
   ends here.)
3. Revoke every other `headless:<name>:*` device, so one daemon holds at most one token.
4. Seal with HPKE (RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 /
   ChaCha20-Poly1305):
   - recipient = `eph_pub`
   - `info` = utf8(`"rbkeeper-unlock-v1|" + headless_id + "|" + boot_id`)
   - `aad` = utf8(`request_id`)
   - plaintext = canonical JSON of
     `{ v: 1, vault: { password, format, salt? }, device_token, issued_at }`
5. If the request is still pending, send
   `{ type: "unlock_response", request_id, enc, ciphertext }` (both base64). Otherwise
   revoke the device just minted.

Any failure after step 1 revokes the device minted in step 1.

## Deny

`{ type: "unlock_response", request_id, denied: true }`.

## Logs

Only `request_id`, `headless_id`, `boot_id`, `name`, `reason`, `status` and the revoked
count are ever logged. The vault key, the device token, the plaintext and the ciphertext
are never logged.
