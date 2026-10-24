#!/usr/bin/env bash
# Enable the staging test login for Hermes (run on the staging VM, as ubuntu):
#
#   bash /opt/souply/souply-api/scripts/staging/provision-test-login.sh
#
# 1. generates TEST_LOGIN_KEY into .env.staging (once; never printed)
# 2. copies it into the hermes user's ~/.hermes/.env as SOUPLY_TEST_LOGIN_KEY
# 3. installs `souply-test-login` for hermes
# Then recreate the api container so it picks the key up.
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077

if grep -q '^TEST_LOGIN_KEY=' .env.staging; then
    echo "[test-login] key already in .env.staging — kept"
else
    printf 'TEST_LOGIN_KEY=%s\n' "$(openssl rand -hex 32)" >> .env.staging
    echo "[test-login] key generated in .env.staging"
fi

key=$(grep -m1 '^TEST_LOGIN_KEY=' .env.staging | cut -d= -f2-)
henv=/home/hermes/.hermes/.env
sudo sed -i '/^SOUPLY_TEST_LOGIN_KEY=/d' "$henv"
printf 'SOUPLY_TEST_LOGIN_KEY=%s\n' "$key" | sudo tee -a "$henv" >/dev/null
sudo install -o hermes -g hermes -m 0755 -D scripts/staging/hermes-test-login.sh /home/hermes/.local/bin/souply-test-login
echo "[test-login] key handed to hermes; installed /home/hermes/.local/bin/souply-test-login"
echo "[test-login] now: docker compose -f docker-compose.staging.yml up -d --no-deps souply-api"
