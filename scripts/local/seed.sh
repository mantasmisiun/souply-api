#!/usr/bin/env bash
# Seed the local stack's souply_local database (docker-compose.local.yml).
#
#   npm run local:seed -- prod            dump souply_production over ssh (READ-ONLY
#                                         --single-transaction), keep it in .local/dumps/,
#                                         load, scrub, rewrite URLs
#   npm run local:seed -- file <dump>     load a .sql or .sql.gz dump, scrub, rewrite URLs
#   npm run local:seed -- empty           schema only (tests/schema/schema.sql + newer
#                                         migrations) — no catalog, no users
#   npm run local:seed -- scrub           anonymise users (runs after every load)
#   npm run local:seed -- url-prefixes    list the URL hosts stored in the DB
#   npm run local:seed -- rewrite-urls [OLD=NEW ...]
#                                         re-point stored URLs; no args = .env.r2
#                                         URL_REWRITES + localhost → MINIO_PUBLIC_URL
#   npm run local:seed -- images          copy the R2 buckets (localMinio.ts mirror)
#
# Writes ONLY into the souply-local-mariadb container; prod is only ever read.
# SEED_YES=1 skips the overwrite prompt, SEED_NO_SCRUB=1 keeps real identities,
# SEED_SSH_HOST picks the prod ssh alias (default: oracle).
set -euo pipefail
cd "$(dirname "$0")/../.."

# One run at a time: a second run's DROP DATABASE under a load still in
# progress breaks the first one mid-table (ERROR 1100 ... not locked).
mkdir -p .local
exec 9>.local/seed.lock
flock -n 9 || { echo "[seed] another seed run is in progress — wait for it to finish" >&2; exit 1; }

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

# Replace real identities with stable fakes so prod data can live on a dev box
# (and be read by tooling) without exposing users. Keeps every id and relation;
# deletes push tokens so local testing can never notify a real phone.
scrub() {
    if [[ "${SEED_NO_SCRUB:-}" == "1" ]]; then echo "[scrub] skipped (SEED_NO_SCRUB=1)"; return; fi
    local_sql "$LOCAL_DB" <<'SQL'
UPDATE User SET
    firstName        = IF(firstName IS NULL, NULL, 'Test'),
    lastName         = IF(lastName IS NULL, NULL, 'User'),
    username         = IF(username IS NULL, NULL, CONCAT('user_', REPLACE(LEFT(id, 13), '-', ''))),
    displayName      = IF(displayName IS NULL, NULL, CONCAT('User ', LEFT(id, 4))),
    email            = IF(email IS NULL, NULL, CONCAT('user-', id, '@local.test')),
    adminEmail       = IF(adminEmail IS NULL, NULL, CONCAT('admin-', id, '@local.test')),
    authSubject      = IF(authSubject IS NULL, NULL, CONCAT('local-', id)),
    bio              = NULL,
    avatarUrl        = NULL,
    shadowBannedNote = NULL;
UPDATE BasketTemplate bt JOIN User u ON u.id = bt.userId
    SET bt.creatorHandle = u.username WHERE bt.creatorHandle IS NOT NULL;
UPDATE BetaSignup SET name = 'Beta tester', email = CONCAT('beta-', id, '@local.test'), error = NULL;
UPDATE AdminInvite SET
    email     = CONCAT('invite-', id, '@local.test'),
    firstName = IF(firstName IS NULL, NULL, 'Test'),
    lastName  = IF(lastName IS NULL, NULL, 'Admin'),
    notes     = NULL,
    createdBy = 'local';
SQL
    # Tables a prod dump may not have yet (it can lag dev's migrations).
    if has_table Household; then
        local_sql "$LOCAL_DB" -e "UPDATE Household SET name = IF(name IS NULL, NULL, CONCAT('Household ', id))"
    fi
    if has_table PushToken; then local_sql "$LOCAL_DB" -e "DELETE FROM PushToken"; fi
    if has_table AccountRecoveryAttempt; then local_sql "$LOCAL_DB" -e "DELETE FROM AccountRecoveryAttempt"; fi
    echo "[scrub] users anonymised, push tokens + recovery attempts deleted"
}

# souply-web's local build signs in as this fixed id (VITE_DEV_USER_ID); a prod
# copy doesn't contain it, so every write from the web would hit the User FK.
ensure_dev_user() {
    local_sql "$LOCAL_DB" -e "INSERT IGNORE INTO User (id, isAdmin, points) VALUES ('00000000-0000-0000-0000-000000000000', 0, 0)"
    echo "[seed] dev user 00000000-… present"
}

has_table() {
    [[ "$(local_sql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$LOCAL_DB' AND table_name='$1'")" == "1" ]]
}

url_columns_sql() {
    echo "FROM information_schema.columns c
          JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE c.table_schema = '$LOCAL_DB'
            AND t.table_type = 'BASE TABLE'
            AND c.is_generated = 'NEVER'
            AND c.data_type IN ('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'json')"
}

# Distinct scheme://host[:port]/first-segment prefixes in the usual URL columns,
# to decide what rewrite-urls needs.
url_prefixes() {
    local_sql -N "$LOCAL_DB" -e "
        SELECT GROUP_CONCAT(CONCAT(
            'SELECT ''', table_name, '.', column_name, ''' col, ',
            'REGEXP_SUBSTR(\`', column_name, '\`, ''https?://[^/\"]+/[^/\"]+'') p, COUNT(*) n ',
            'FROM \`', table_name, '\` WHERE \`', column_name, '\` LIKE ''%http%'' GROUP BY p')
            SEPARATOR ' UNION ALL ')
        $(url_columns_sql)
          AND (c.column_name LIKE '%url%' OR c.column_name LIKE '%path%' OR c.column_name LIKE '%image%'
               OR c.column_name LIKE '%logo%' OR c.column_name LIKE '%cover%')" \
        | { read -r q; [[ -n "$q" && "$q" != "NULL" ]] && local_sql -N "$LOCAL_DB" -e "$q" | sort -k3 -nr; }
}

# Stored image/receipt URLs embed the host they were uploaded through
# (storageService.publicUrlPrefix / the R2 custom domains). Rewrite every text
# column that contains OLD/ to NEW/ so the local stack serves them itself.
rewrite_urls() {
    local pairs=("$@")
    if [[ ${#pairs[@]} -eq 0 ]]; then
        local cfg
        cfg=$(envval .env.r2 URL_REWRITES)
        IFS=',' read -r -a pairs <<< "${cfg//\{local\}/$LOCAL_MINIO}"
        # Rows written by the local stack itself before MINIO_PUBLIC_URL changed,
        # and receipts uploaded while prod still ran on OMV's MinIO (their
        # objects were carried into R2 under the same keys).
        pairs+=("http://localhost:9000=$LOCAL_MINIO"
                "https://minio.manofoto.dpdns.org=$LOCAL_MINIO"
                "http://192.168.1.212:9000=$LOCAL_MINIO")
    fi
    for pair in "${pairs[@]}"; do
        [[ -z "$pair" ]] && continue
        local old="${pair%%=*}" new="${pair#*=}"
        [[ "$pair" == *=* ]] || new="$LOCAL_MINIO"
        old="${old%/}"; new="${new%/}"
        [[ "$old" == "$new" ]] && continue
        echo "[urls] $old → $new"
        local_sql -N "$LOCAL_DB" -e "
            SELECT CONCAT('UPDATE \`', table_name, '\` SET \`', column_name, '\` = REPLACE(\`', column_name,
                          '\`, ''$old/'', ''$new/'') WHERE \`', column_name, '\` LIKE ''%$old/%'';',
                          ' SELECT ''', table_name, '.', column_name, ''', ROW_COUNT() FROM DUAL WHERE ROW_COUNT() > 0;')
            $(url_columns_sql)" \
            | local_sql -N "$LOCAL_DB"
    done
}

cmd="${1:-}"; shift || true
case "$cmd" in
    prod)
        require_container
        mkdir -p "$DUMP_DIR"
        host="${SEED_SSH_HOST:-oracle}"
        out="$DUMP_DIR/souply_production-$(date +%Y%m%d-%H%M).sql.gz"
        echo "[seed] dumping souply_production via ssh $host (read-only snapshot)"
        # Root password comes from the prod container's own env, never this host.
        ssh "$host" "docker exec souply-mariadb sh -c 'exec mariadb-dump -uroot -p\"\$MARIADB_ROOT_PASSWORD\" \
            --single-transaction --quick --routines --events --triggers \
            --no-tablespaces --hex-blob --default-character-set=utf8mb4 souply_production'" \
            | gzip > "$out"
        gunzip -t "$out"
        echo "[seed] saved $out ($(du -h "$out" | cut -f1))"
        load_dump "$out"
        scrub
        ensure_dev_user
        rewrite_urls
        ;;
    file)
        require_container
        load_dump "${1:?usage: seed.sh file <dump.sql[.gz]>}"
        scrub
        ensure_dev_user
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
    scrub)
        require_container
        scrub
        ensure_dev_user
        ;;
    url-prefixes)
        require_container
        url_prefixes
        ;;
    rewrite-urls)
        require_container
        rewrite_urls "$@"
        ;;
    images)
        npx tsx src/scripts/localMinio.ts mirror .env.r2
        ;;
    *)
        sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
