# syntax=docker/dockerfile:1
#
# Basket-API container. Build context MUST be the parent /Project/
# directory because the TypeScript build needs both basket-api/ AND
# shared/ (which lives as a sibling, referenced via `../shared` in
# tsconfig.json).
#
# Build from /Project/:
#   docker build -f basket-api/Dockerfile -t basket-api:latest .
#
# Multi-stage: builder compiles TS → runtime stage copies only the
# compiled JS + prod node_modules. Keeps the final image under ~300MB.

# ─── Stage 1: build ─────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install dev deps for compilation. Copy package files first so the
# npm install layer caches independently of source changes.
COPY basket-api/package*.json ./basket-api/
WORKDIR /app/basket-api
RUN npm ci

# Copy the rest of the source (TS + shared parsers).
WORKDIR /app
COPY basket-api/tsconfig.json ./basket-api/
COPY basket-api/src ./basket-api/src
COPY shared ./shared

# Compile. outDir=./dist with rootDir=.. means compiled tree lands
# at /app/basket-api/dist/{basket-api,shared}/...
WORKDIR /app/basket-api
RUN npm run build

# ─── Stage 2: runtime ───────────────────────────────────────────
# node:20-slim (Debian) instead of Alpine: Playwright's Chromium is
# compiled for glibc; it silently fails to launch on musl/Alpine.
FROM node:20-slim AS runtime
WORKDIR /app

# tini: PID 1 signal handling.
# poppler-utils: pdftoppm for PDF→PNG in pdfService.
# The rest are Chromium system libraries pulled in by
# `playwright install --with-deps` below, but listing them here
# keeps the apt layer cacheable independently of the npm layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Prod deps only (playwright itself is a prod dep — scrapers need it).
COPY basket-api/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Download Chromium + all required system libraries into the image.
# Must run after npm ci so the playwright CLI is available.
RUN npx playwright install chromium --with-deps

# Compiled output.
COPY --from=builder /app/basket-api/dist ./dist

# Tini as PID 1 so the container handles SIGTERM cleanly on
# docker stop (Node alone can be stubborn about signals).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/basket-api/src/index.js"]

EXPOSE 3000
