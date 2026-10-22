#!/usr/bin/env bash
# Seed the local stack's souply_local database (docker-compose.local.yml).
#
#   npm run local:seed -- dev             dump souply_dev from OMV (.env DB_*), keep the
#                                         dump in .local/dumps/, load it, rewrite URLs
#   npm run local:seed -- file <dump>     load a .sql or .sql.gz dump, rewrite URLs
#   npm run local:seed -- empty           schema only (tests/schema/schema.sql + newer
#                                         migrations) — no catalog, no users
#   npm run local:seed -- rewrite-urls    re-point stored MinIO URLs at local MinIO
#   npm run local:seed -- images          copy the MinIO objects too (localMinio.ts mirror)
#
# Writes ONLY into the souply-local-mariadb container; OMV is only ever read.
# Set SEED_YES=1 to skip the overwrite prompt.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=souply-local-mariadb
LOCAL_DB=souply_local
DUMP_DIR=.local/dumps

# Value of KEY in an env file, quotes stripped. Never echoed.
envval() { [[ -f "$1" ]] && grep -m1 "^$2=" "$1" | cut -d= -f2- | tr -d '"' || true; }

# Where stored URLs should point: the local MinIO as clients reach it
# (localhost, or the NetBird IP when testing on the phone).
LOCAL_MINIO=$(envval .env.local MINIO_PUBLIC_URL)
LOCAL_MINIO=${LOCAL_MINIO:-http://localhost:9000}
LOCAL_MINIO=${LOCAL_MINIO%/}

# mariadb client inside the local container, as root (password from the
# container's own env, so it never appears on this command line).
local_sql() {
    docker exec -i "$CONTAINER" sh -c 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$@"' sh "$@"
}

require_container() {
    if ! docker exec "$CONTAINER" true 2>/dev/null; then
        echo "souply-local-mariadb isn't running: docker compose -f docker-compose.local.yml up -d" >&2
        exit 1
    fi
}

confirm_replace() {
    [[ "${SEED_YES:-}" == "1" ]] && return
    read -r -p "Replace local database $LOCAL_DB? [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted"; exit 1; }
}

recreate_db() {
    local_sql <<SQL
DROP DATABASE IF EXISTS $LOCAL_DB;
CREATE DATABASE $LOCAL_DB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON $LOCAL_DB.* TO 'souply_app'@'%';
FLUSH PRIVILEGES;
SQL
}

load_dump() {
    local dump="$1"
    [[ -f "$dump" ]] || { echo "no such dump: $dump" >&2; exit 1; }
    confirm_replace
    recreate_db
    echo "[seed] loading $dump"
    # DEFINER clauses name users that don't exist locally — drop them.
    { if [[ "$dump" == *.gz ]]; then gunzip -c "$dump"; else cat "$dump"; fi; } \
        | sed -E 's/DEFINER=`[^`]+`@`[^`]+`//g' \
        | local_sql "$LOCAL_DB"
    echo "[seed] loaded: $(local_sql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$LOCAL_DB'") tables"
}

# Stored image/receipt URLs embed the MinIO host they were uploaded through
# (storageService.publicUrlPrefix). Rewrite every text column that contains
# one of the old prefixes so the local stack serves them from local MinIO.
rewrite_urls() {
    local prefixes=("$@")
    if [[ ${#prefixes[@]} -eq 0 ]]; then
        local host port pub
        host=$(envval .env MINIO_ENDPOINT); port=$(envval .env MINIO_PORT); pub=$(envval .env MINIO_PUBLIC_URL)
        [[ -n "$host" ]] && prefixes+=("http://$host:${port:-9000}")
        [[ -n "$pub" ]] && prefixes+=("${pub%/}")
        # Rows written by the local stack itself before MINIO_PUBLIC_URL changed.
        prefixes+=("http://localhost:9000")
    fi
    [[ ${#prefixes[@]} -gt 0 ]] || { echo "[urls] no source prefixes (pass them as arguments)"; return; }
    for old in "${prefixes[@]}"; do
        [[ "$old" == "$LOCAL_MINIO" ]] && continue
        echo "[urls] $old → $LOCAL_MINIO"
        local_sql -N "$LOCAL_DB" -e "
            SELECT CONCAT('UPDATE \`', table_name, '\` SET \`', column_name, '\` = REPLACE(\`', column_name,
                          '\`, ''$old/'', ''$LOCAL_MINIO/'') WHERE \`', column_name, '\` LIKE ''%$old/%'';',
                          ' SELECT ''', table_name, '.', column_name, ''', ROW_COUNT() FROM DUAL WHERE ROW_COUNT() > 0;')
            FROM information_schema.columns c
            JOIN information_schema.tables t USING (table_schema, table_name)
            WHERE c.table_schema = '$LOCAL_DB'
              AND t.table_type = 'BASE TABLE'
              AND c.is_generated = 'NEVER'
              AND c.data_type IN ('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'json')" \
            | local_sql -N "$LOCAL_DB"
    done
}

cmd="${1:-}"; shift || true
case "$cmd" in
    dev)
        require_container
        [[ -f .env ]] || { echo ".env (OMV dev credentials) not found" >&2; exit 1; }
        mkdir -p "$DUMP_DIR"
        src_db=$(envval .env DB_NAME)
        out="$DUMP_DIR/${src_db}-$(date +%Y%m%d-%H%M).sql.gz"
        echo "[seed] dumping $src_db from $(envval .env DB_HOST):$(envval .env DB_PORT)"
        MYSQL_PWD="$(envval .env DB_PASSWORD)" mariadb-dump --skip-ssl \
            -h "$(envval .env DB_HOST)" -P "$(envval .env DB_PORT)" -u "$(envval .env DB_USER)" \
            --single-transaction --quick --routines --events --triggers \
            --no-tablespaces --hex-blob --default-character-set=utf8mb4 "$src_db" \
            | gzip > "$out"
        echo "[seed] saved $out ($(du -h "$out" | cut -f1))"
        load_dump "$out"
        rewrite_urls
        ;;
    file)
        require_container
        load_dump "${1:?usage: seed.sh file <dump.sql[.gz]>}"
        rewrite_urls
        ;;
    empty)
        require_container
        confirm_replace
        recreate_db
        local_sql "$LOCAL_DB" < tests/schema/schema.sql
        # Same post-schema migrations + reference row as tests/globalSetup.ts —
        # keep the two lists in sync.
        for f in sql/household_ledger.sql sql/household_member_leaving.sql sql/receipt_item_family_scope.sql; do
            local_sql "$LOCAL_DB" < "$f"
        done
        local_sql "$LOCAL_DB" -e "INSERT INTO Category (id, name, isHidden) VALUES (688, 'Nepriskirta', 1) ON DUPLICATE KEY UPDATE isHidden = 1"
        echo "[seed] empty schema loaded"
        ;;
    rewrite-urls)
        require_container
        rewrite_urls "$@"
        ;;
    images)
        npx tsx src/scripts/localMinio.ts mirror
        ;;
    *)
        sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
