#!/usr/bin/env bash
# Replace STAGING's data with this PC's local stack (docker-compose.local.yml):
# the scrubbed, migrated prod copy in souply_local + its MinIO objects.
#
#   bash scripts/staging/load-from-local.sh          (run on the dev PC)
#
# Only ever reads the local stack and writes staging. Staging's secrets stay on
# the VM: the dump is streamed into the staging MariaDB container (root password
# from that container's own env), and objects are copied by a one-off container
# started with `--env-file .env.staging`.
# SEED_YES=1 skips the prompt; STAGING_SSH picks the ssh alias (default: staging).
set -euo pipefail
cd "$(dirname "$0")/../.."

SSH_HOST="${STAGING_SSH:-staging}"
LOCAL_CONTAINER=souply-local-mariadb
LOCAL_DB=souply_local
STAGING_CONTAINER=souply-staging-mariadb
STAGING_DB=souply_staging
STAGING_FILES=https://files-staging.souply.lt
REMOTE_DIR=/opt/souply/souply-api

envval() { [[ -f "$1" ]] && grep -m1 "^$2=" "$1" | cut -d= -f2- | tr -d '"' || true; }
LOCAL_MINIO=$(envval .env.local MINIO_PUBLIC_URL)
LOCAL_MINIO=${LOCAL_MINIO:-http://localhost:9000}
LOCAL_MINIO=${LOCAL_MINIO%/}

local_dump() {
    docker exec "$LOCAL_CONTAINER" sh -c 'exec mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" "$@"' sh \
        --single-transaction --quick --routines --triggers --hex-blob \
        --default-character-set=utf8mb4 "$LOCAL_DB"
}
# mariadb client inside the staging container; extra args (e.g. -N, the db) are passed through.
staging_sql() {
    ssh "$SSH_HOST" "docker exec -i $STAGING_CONTAINER sh -c 'exec mariadb -uroot -p\"\$MARIADB_ROOT_PASSWORD\" $*'"
}

if [[ "${SEED_YES:-}" != "1" ]]; then
    read -r -p "Replace ALL staging data ($STAGING_DB + MinIO) with the local copy? [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted"; exit 1; }
fi

echo "[staging] recreating $STAGING_DB"
staging_sql <<SQL
DROP DATABASE IF EXISTS $STAGING_DB;
CREATE DATABASE $STAGING_DB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON $STAGING_DB.* TO 'souply_app'@'%';
FLUSH PRIVILEGES;
SQL

echo "[staging] streaming $LOCAL_DB → $STAGING_DB"
local_dump | gzip -1 | ssh "$SSH_HOST" \
    "gunzip | docker exec -i $STAGING_CONTAINER sh -c 'exec mariadb -uroot -p\"\$MARIADB_ROOT_PASSWORD\" $STAGING_DB'"
echo "[staging] loaded: $(echo "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$STAGING_DB'" | staging_sql -N) tables"

# Stored object URLs point at the local MinIO; make them staging's public one.
for old in "$LOCAL_MINIO" "http://localhost:9000"; do
    echo "[staging] urls: $old → $STAGING_FILES"
    staging_sql -N "$STAGING_DB" <<SQL | staging_sql "$STAGING_DB"
SELECT CONCAT('UPDATE \`', table_name, '\` SET \`', column_name, '\` = REPLACE(\`', column_name,
              '\`, ''$old/'', ''$STAGING_FILES/'') WHERE \`', column_name, '\` LIKE ''%$old/%'';')
FROM information_schema.columns c
JOIN information_schema.tables t USING (table_schema, table_name)
WHERE c.table_schema = '$STAGING_DB' AND t.table_type = 'BASE TABLE' AND c.is_generated = 'NEVER'
  AND c.data_type IN ('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'json');
SQL
done

echo "[staging] copying MinIO objects (staging pulls from this PC over NetBird)"
# Ship this checkout's copy of the helper, so the run doesn't depend on what the
# VM's checkout currently has.
scp -q scripts/staging/mirror-objects.mjs "$SSH_HOST:/tmp/souply-mirror-objects.mjs"
src_host=$(echo "$LOCAL_MINIO" | sed -E 's#^https?://([^:/]+).*#\1#')
src_port=$(echo "$LOCAL_MINIO" | sed -nE 's#^https?://[^:/]+:([0-9]+).*#\1#p')
ssh "$SSH_HOST" "cd $REMOTE_DIR && docker run --rm --network souply-staging_default --env-file .env.staging \
    -e SRC_ENDPOINT=$src_host -e SRC_PORT=${src_port:-9000} \
    -e SRC_ACCESS_KEY=$(envval .env.local MINIO_ACCESS_KEY) -e SRC_SECRET_KEY=$(envval .env.local MINIO_SECRET_KEY) \
    -v /tmp/souply-mirror-objects.mjs:/app/mirror-objects.mjs:ro \
    --entrypoint node souply-api:staging /app/mirror-objects.mjs"
echo "[staging] done"
