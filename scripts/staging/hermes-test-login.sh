#!/usr/bin/env bash
# souply-test-login — sign the automated tester (Hermes) in to STAGING as the test
# account (config/testLogin.ts). Installed for the `hermes` user by
# provision-test-login.sh.
#
# Prints a one-time browser link (valid 60 s) and saves the API token to
# ~/.souply-test-token. Neither the key nor the token is ever printed.
set -euo pipefail

API=https://api-staging.souply.lt
key=$(grep -m1 '^SOUPLY_TEST_LOGIN_KEY=' "$HOME/.hermes/.env" | cut -d= -f2- || true)
[[ -n "$key" ]] || { echo "souply-test-login: no SOUPLY_TEST_LOGIN_KEY in ~/.hermes/.env" >&2; exit 1; }

# Header from a file descriptor, so the key never shows up in the process list.
resp=$(curl -fsS -X POST "$API/api/auth/test-login" -H @<(printf 'X-Test-Login-Key: %s\n' "$key"))

umask 077
printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"], end="")' > "$HOME/.souply-test-token"
url=$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["browserLoginUrl"])')

echo "Browser: open within 60 s (one use) → $url"
echo "API:     curl -H \"Authorization: Bearer \$(cat ~/.souply-test-token)\" $API/api/auth/me"
