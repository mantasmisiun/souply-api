#!/usr/bin/env bash
# Create staging's env files on the staging VM (docker-compose.staging.yml).
#
#   cd /opt/souply/souply-api && bash scripts/staging/init-env.sh
#
#   .env          compose substitution: DB/MinIO root creds (+ tunnel token, added by hand)
#   .env.staging  souply-api runtime
#
# Every secret is generated here with openssl and written straight to the file —
# nothing is printed. Existing files are never overwritten (re-running is safe);
# delete one deliberately to regenerate it, which also means recreating the
# volumes whose passwords it set.
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077

rand() { openssl rand -hex "${1:-24}"; }

if [[ -f .env ]]; then
    echo "[init-env] .env exists — kept"
else
    db_app=$(rand)
    minio_user="souply_staging"
    minio_pw=$(rand)
    {
        echo "DB_ROOT_PASSWORD=$(rand)"
        echo "DB_APP_PASSWORD=$db_app"
        echo "MINIO_ROOT_USER=$minio_user"
        echo "MINIO_ROOT_PASSWORD=$minio_pw"
        echo "# Cloudflare Tunnel (Zero Trust → Networks → Tunnels → souply-staging):"
        echo "# paste the token, then uncomment COMPOSE_PROFILES so up -d starts cloudflared."
        echo "CLOUDFLARE_TUNNEL_TOKEN="
        echo "#COMPOSE_PROFILES=tunnel"
    } > .env
    echo "[init-env] .env written"
fi

if [[ -f .env.staging ]]; then
    echo "[init-env] .env.staging exists — kept"
else
    # The api must use the SAME app/MinIO credentials the containers were created with.
    get() { grep -m1 "^$1=" .env | cut -d= -f2-; }
    {
        echo "NODE_ENV=production"
        echo "PORT=3000"
        echo "APP_ENV=staging"
        echo "SENTRY_ENVIRONMENT=staging"
        echo "ENABLE_SCHEDULER=false"
        echo ""
        echo "DB_HOST=mariadb"
        echo "DB_PORT=3306"
        echo "DB_USER=souply_app"
        echo "DB_PASSWORD=$(get DB_APP_PASSWORD)"
        echo "DB_NAME=souply_staging"
        echo "DB_TIMEZONE=+02:00"
        echo ""
        echo "# storageService signs AND uploads through the public URL (as prod does via R2)."
        echo "MINIO_ENDPOINT=minio"
        echo "MINIO_PORT=9000"
        echo "MINIO_PUBLIC_URL=https://files-staging.souply.lt"
        echo "MINIO_ACCESS_KEY=$(get MINIO_ROOT_USER)"
        echo "MINIO_SECRET_KEY=$(get MINIO_ROOT_PASSWORD)"
        echo "MINIO_REGION=us-east-1"
        echo "MINIO_BUCKET=receipts"
        echo "MINIO_PRODUCT_IMAGES_BUCKET=product-images"
        echo ""
        echo "API_PUBLIC_URL=https://api-staging.souply.lt"
        echo "WEB_PUBLIC_URL=https://staging.souply.lt"
        echo "CORS_ORIGINS=https://staging.souply.lt"
        echo "APP_SCHEME=souply"
        echo "SESSION_JWT_SECRET=$(rand 48)"
        echo ""
        echo "# Public client ids: web + the staging Android client (comma-separated audiences)."
        echo "GOOGLE_OAUTH_CLIENT_ID=554949767682-oqvvbc2a3klc1tedqvbdotmg4uqkj5s3.apps.googleusercontent.com,554949767682-86fb6k23obqhn32aoil8op3233u7q2ju.apps.googleusercontent.com"
        echo ""
        echo "# All mail goes to the mailpit container (UI :8025 over NetBird)."
        echo "SMTP_HOST=mailpit"
        echo "SMTP_PORT=1025"
        echo "SMTP_SECURE=false"
        echo "SMTP_FROM=Souply Staging <noreply@souply.lt>"
        echo ""
        echo "# Telegram: staging gets its own bot later (prod's token is prod-only)."
    } > .env.staging
    echo "[init-env] .env.staging written"
fi
