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
FROM node:20-alpine AS runtime
WORKDIR /app

# pdfService shells out to `pdftoppm` (poppler-utils) for PDF→PNG
# conversion. Same rasterizer the dev-time `npm run receipts:stage`
# script uses, so output matches dev parity. Earlier we shipped
# GhostScript + GraphicsMagick for the old pdf2pic path; both are
# unused now and dropped from the image.
RUN apk add --no-cache poppler-utils tini

# Prod deps only.
COPY basket-api/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output.
COPY --from=builder /app/basket-api/dist ./dist

# Tini as PID 1 so the container handles SIGTERM cleanly on
# docker stop (Node alone can be stubborn about signals).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/basket-api/src/index.js"]

EXPOSE 3000
