#!/usr/bin/env bash
#
# Souply production backup — runs nightly via souply-backup.timer.
#
# Backs up three things to a dedicated folder on the RAID array (md0):
#   1. MariaDB `souply_production` -> consistent gzipped mariadb-dump
#   2. MinIO object store (images) -> incremental, hardlinked rsync snapshot
#   3. Prod stack secrets + compose -> tar.gz of .env + docker-compose files
#
# Durability note: this writes to the SAME RAID array that holds the live
# data. That protects against logical loss (bad migration, DROP, app bug,
# container corruption) and single-disk failure (md0 is RAID). It does NOT
# protect against array/site loss — for that, copy $BACKUP_ROOT off-box
# (rsync to another machine or cloud). Documented follow-up.
#
# Restore: see scripts/BACKUP.md.
set -euo pipefail

### ---- config (all overridable via environment) --------------------------
DISK="${DISK:-/srv/dev-disk-by-uuid-684af50e-d47d-4d94-965e-7f9feb0520e9}"
BACKUP_ROOT="${BACKUP_ROOT:-$DISK/souply_backups}"
MINIO_DATA="${MINIO_DATA:-$DISK/minio}"
PROD_DIR="${PROD_DIR:-/opt/souply/souply-api}"
DB_CONTAINER="${DB_CONTAINER:-souply-mariadb}"
DB_NAME="${DB_NAME:-souply_production}"
KEEP_DB_DAYS="${KEEP_DB_DAYS:-30}"
KEEP_IMG_DAYS="${KEEP_IMG_DAYS:-30}"
KEEP_CFG_DAYS="${KEEP_CFG_DAYS:-30}"
### ------------------------------------------------------------------------

TS="$(date +%Y-%m-%d_%H%M%S)"
DATE="$(date +%Y-%m-%d)"
log() { echo "[souply-backup $(date '+%F %T')] $*"; }

mkdir -p "$BACKUP_ROOT"/{db,images,config}

# ---- 1. Database (consistent logical dump) -------------------------------
log "Dumping $DB_NAME from $DB_CONTAINER ..."
ROOT_PW="$(docker exec "$DB_CONTAINER" printenv MARIADB_ROOT_PASSWORD 2>/dev/null \
        || docker exec "$DB_CONTAINER" printenv MYSQL_ROOT_PASSWORD 2>/dev/null || true)"
if [ -z "$ROOT_PW" ]; then
    log "ERROR: could not read root password from $DB_CONTAINER env"; exit 1
fi
DB_OUT="$BACKUP_ROOT/db/${DB_NAME}_${TS}.sql.gz"
# --single-transaction => consistent snapshot of InnoDB without locking tables.
docker exec "$DB_CONTAINER" mariadb-dump \
    -uroot -p"$ROOT_PW" \
    --single-transaction --quick --routines --triggers --events \
    --default-character-set=utf8mb4 \
    --databases "$DB_NAME" \
    | gzip -c > "$DB_OUT"
gzip -t "$DB_OUT"   # fail loudly if the dump is truncated/corrupt
log "DB dump OK -> $DB_OUT ($(du -h "$DB_OUT" | cut -f1))"

# ---- 2. Images (MinIO) — incremental hardlinked snapshot -----------------
log "Snapshotting MinIO images from $MINIO_DATA ..."
IMG_DEST="$BACKUP_ROOT/images/$DATE"
IMG_PREV="$(ls -1dt "$BACKUP_ROOT"/images/*/ 2>/dev/null | grep -v "/$DATE/\$" | head -1 || true)"
LINK_OPT=()
[ -n "$IMG_PREV" ] && LINK_OPT=(--link-dest="$IMG_PREV")
# --delete keeps the snapshot an exact mirror of "now"; older snapshots still
# hold files that have since been deleted (hardlinks => unchanged files free).
rsync -a --delete "${LINK_OPT[@]}" "$MINIO_DATA"/ "$IMG_DEST"/
log "Image snapshot OK -> $IMG_DEST ($(du -sh "$IMG_DEST" | cut -f1) apparent)"

# ---- 3. Config + secrets -------------------------------------------------
log "Backing up prod config/secrets from $PROD_DIR ..."
CFG_OUT="$BACKUP_ROOT/config/config_${TS}.tar.gz"
CFG_FILES=()
for f in .env .env.production docker-compose.yml docker-compose.prod.yml; do
    [ -f "$PROD_DIR/$f" ] && CFG_FILES+=("$f")
done
if [ "${#CFG_FILES[@]}" -gt 0 ]; then
    tar -czf "$CFG_OUT" -C "$PROD_DIR" "${CFG_FILES[@]}"
    chmod 600 "$CFG_OUT"   # contains secrets
    log "Config backup OK -> $CFG_OUT (${CFG_FILES[*]})"
else
    log "WARN: no config files found in $PROD_DIR"
fi

# ---- 4. Retention --------------------------------------------------------
log "Pruning backups older than ${KEEP_DB_DAYS}d (db) / ${KEEP_IMG_DAYS}d (img) / ${KEEP_CFG_DAYS}d (cfg) ..."
find "$BACKUP_ROOT/db"     -maxdepth 1 -name '*.sql.gz' -mtime +"$KEEP_DB_DAYS"  -delete
find "$BACKUP_ROOT/config" -maxdepth 1 -name '*.tar.gz' -mtime +"$KEEP_CFG_DAYS" -delete
find "$BACKUP_ROOT/images" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_IMG_DAYS" -exec rm -rf {} +

log "Backup complete."
