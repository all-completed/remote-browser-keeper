#!/bin/sh
# Configure git so npm can fetch @f-proj/ui-components, which package.json pins as
# a git dependency on the PRIVATE repo vasyaod/ui-components (the Keeper window's
# shell and components, issue #28). .github/workflows/build.yml runs it before
# `npm ci` on every runner — macOS, Linux and Windows (Git Bash); a local machine
# signed in to GitHub needs nothing.
#
# Copied unchanged but for this header and the message naming this repo's files
# from vasyaod/f-proj-phone's scripts/ui-components-credential.sh (itself icons',
# commune's, agent-swarm's and remote-device-service's). This repo documents the
# secret in the header of .github/workflows/build.yml (what it is) and under
# "Building it" in README.md (how to provision it). Keep the three in step.
#
# It accepts either credential, and prefers whichever exists:
#
#   UI_COMPONENTS_DEPLOY_KEY — an OpenSSH PRIVATE key whose public half is a
#       read-only deploy key on vasyaod/ui-components. A deploy key is scoped to
#       exactly one repository and can be minted through the REST API, so this
#       is the form an executor can set up unattended.
#   UI_COMPONENTS_TOKEN — an HTTPS credential (a fine-grained PAT with
#       Contents: Read on vasyaod/ui-components). Kept because it is the form a
#       human-created PAT is delivered as; nothing here has to change when one
#       appears.
#
# Neither one ⇒ exit 1. A Keeper that quietly built without the library
# it is required to consume would be worse than a red build.
#
# Reads the credential from the environment and writes it only to a 0600 file
# under $HOME — never argv, never stdout. Nothing here echoes a secret.
set -eu

usage_error() {
    echo "Neither UI_COMPONENTS_DEPLOY_KEY nor UI_COMPONENTS_TOKEN is set —" \
         "npm ci cannot clone the private @f-proj/ui-components." >&2
    echo "Set one of them. The runbook — mint a read-only deploy key on" \
         "vasyaod/ui-components, or a fine-grained PAT with Contents: Read on" \
         "it — is in README.md under 'Building it'; the 'Required repo" \
         "secrets' header in .github/workflows/build.yml says what" \
         "each one is." >&2
    exit 1
}

# GitHub's own published host keys, so StrictHostKeyChecking can stay on without
# trust-on-first-use and without a fingerprint hardcoded here to rot the next
# time GitHub rotates one (it rotated the RSA key in March 2023).
#
# /meta needs no permission to read, but it is billed against the REST core rate
# limit, and an unauthenticated core request is 60/hour *per source IP* — an IP a
# GitHub-hosted runner shares with every other runner behind the same NAT. When
# that shared budget is gone GitHub answers `403 API rate limit exceeded for
# <ip>`, and this step dies on a commit whose tests all passed: build-and-deploy
# run 36668582860 failed exactly that way at 4f52efc, leaving a merged commit
# undeployed. So:
#
#   * Send a token when one exists. It lifts the same request to 5000/hour and
#     makes the budget per-TOKEN instead of per-IP. The default GITHUB_TOKEN
#     serves here — unlike the ui-components clone above, which it cannot do
#     because that is a different private repo, reading /meta needs no access at
#     all. The token buys budget, not permission.
#   * Retry a bounded number of times. The tokenless path (a plain local
#     `docker build`) still has to survive a runner IP someone else exhausted,
#     and 403/429/5xx/connection errors are all worth one more try.
#
# It still fails CLOSED. Nothing here falls back to trust-on-first-use or to a
# fingerprint pinned in this file; out of retries is a red build, as before.
github_meta_attempts="${GITHUB_META_ATTEMPTS:-4}"

# Prints `github.com <key>` lines on stdout; non-zero and a reason on stderr
# otherwise. META_TOKEN is read from the environment, never passed as an
# argument, and is not echoed.
fetch_github_meta() {
    META_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}" node -e '
      var token = process.env.META_TOKEN || "";
      var headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "ui-components-credential",
      };
      if (token) headers.authorization = "Bearer " + token;
      fetch("https://api.github.com/meta", { headers: headers })
        .then(function (r) {
          if (!r.ok) {
            // x-ratelimit-remaining: 0 is what separates "the budget is gone"
            // from a real 403, and the two have different fixes. Say which.
            var why = r.headers.get("x-ratelimit-remaining") === "0"
              ? " (rate limit exhausted; " + (token
                  ? "authenticated, so this is the 5000/hour of the token sent"
                  : "UNAUTHENTICATED, so this is the 60/hour shared by every"
                    + " request from this IP — set GITHUB_TOKEN") + ")"
              : "";
            throw new Error("api.github.com/meta: HTTP " + r.status + why);
          }
          return r.json();
        })
        .then(function (m) {
          var keys = m.ssh_keys || [];
          if (!keys.length) throw new Error("api.github.com/meta carried no ssh_keys");
          process.stdout.write(keys.map(function (k) {
            return "github.com " + k;
          }).join("\n") + "\n");
        })
        .catch(function (e) { console.error(String(e)); process.exit(1); });
    '
}

write_known_hosts() {
    command -v node >/dev/null 2>&1 || {
        echo "node is required to fetch GitHub's SSH host keys" >&2; exit 1; }
    attempt=1
    delay=3
    while :; do
        # `if`, so errexit does not end the script on an attempt that is about to
        # be retried. -s as well as rc=0: a truncated body would leave an empty
        # known_hosts that ssh reads as "no key for github.com".
        if fetch_github_meta > "$1" && test -s "$1"; then
            return 0
        fi
        if [ "$attempt" -ge "$github_meta_attempts" ]; then
            echo "could not fetch GitHub's SSH host keys after $attempt attempt(s)" \
                 "— giving up rather than trusting an unverified host key." >&2
            exit 1
        fi
        echo "GitHub host keys: attempt $attempt of $github_meta_attempts failed," \
             "retrying in ${delay}s" >&2
        sleep "$delay"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}

home="${HOME:-/root}"
mkdir -p "$home/.ssh"
chmod 700 "$home/.ssh"

if [ -n "${UI_COMPONENTS_DEPLOY_KEY:-}" ]; then
    key="$home/.ssh/ui-components"
    known_hosts="$home/.ssh/github_known_hosts"
    # umask, not a later chmod: ssh flatly refuses a private key that is group-
    # or world-readable, and a redirect creates the file at 0644 first.
    (umask 077 && printf '%s\n' "$UI_COMPONENTS_DEPLOY_KEY" > "$key")
    write_known_hosts "$known_hosts"
    # IdentitiesOnly: a runner with an ssh-agent would otherwise offer its own
    # keys first and GitHub would answer as whatever that key is, not as the
    # deploy key — a confusing 404 on a repo this key can read.
    git config --global core.sshCommand \
        "ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$known_hosts"
    # package.json pins `git+https://`; the lockfile's `resolved` is the
    # `git+ssh://` form npm normalises it to. The deploy key only works over
    # ssh, so the https form is rewritten onto it.
    git config --global --replace-all url."ssh://git@github.com/".insteadOf "https://github.com/"
    echo "ui-components credential: deploy key (ssh, read-only, single repo)"
elif [ -n "${UI_COMPONENTS_TOKEN:-}" ]; then
    # The token goes into a 0600 credential-store file, written by printf (a
    # shell builtin, so never on any process's argv) — not into a URL in a git
    # config key, which would put it on git's command line and in ~/.gitconfig.
    store="$home/.git-credentials-ui-components"
    (umask 077 && printf 'https://x-access-token:%s@github.com\n' "$UI_COMPONENTS_TOKEN" > "$store")
    git config --global --replace-all credential.https://github.com.helper "store --file=$store"
    # package.json pins `git+https://`, the lockfile carries `git+ssh://`, and
    # npm's fetcher may try either: both ssh forms are rewritten onto https,
    # where the helper answers with the token.
    git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true
    for from in "ssh://git@github.com/" "git@github.com:"; do
        git config --global --add url."https://github.com/".insteadOf "$from"
    done
    echo "ui-components credential: UI_COMPONENTS_TOKEN (https)"
else
    usage_error
fi
