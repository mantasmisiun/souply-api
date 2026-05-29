# souply-api

Backend for [Souply](https://souply.lt) — the Lithuanian grocery
price-comparison platform. Powers price comparison, receipt OCR &
matching, basket templates, the swipe-based product cluster system,
gamification, and the admin moderation queues.

Web client lives in `souply-web`. Mobile client lives in `souply-app`.

## Stack

- **Node.js 20 + TypeScript** on Express
- **MySQL/MariaDB** (`Souply_DB`), accessed via mysql2/promise pool
- **MinIO** for receipt images + product photography
- **BullMQ + Redis** for background scrape jobs and receipt processing
- **Jest** for unit + integration tests
- Cross-stack `shared/` folder consumed by both api and the mobile app

## Commands

```bash
npm run dev                # nodemon + tsx, hot reload on src/ changes
npm run build              # tsc -> dist/
npm start                  # node dist/souply-api/src/index.js
npm test                   # NODE_ENV=test jest

# Scrapers (Mon: IKI + Lidl; Tue: Rimi + Barbora; Thu: Norfa; Sat: Lidl)
npm run scrape:barbora
npm run scrape:rimi
npm run scrape:iki
npm run scrape:norfa
npm run scrape:lidl
npm run scrape:all

# Receipt batch test pipeline (runs the dev MLKit phone-side flow)
npm run receipts:stage     # stage receipts/<chain>/*.pdf as PNGs + manifest
npm run receipts:batch     # import + parse a staged batch
npm run receipts:cleanup   # purge test data

# Truths corpus (manual labels for matcher regression)
npm run truths:bootstrap
npm run truths:review

# Admin CLI (one-off moderation tools)
npm run admin
```

## Layout

```
src/
├── index.ts                ← express bootstrap + middleware chain
├── config/                 ← db pool, MinIO client, env loader
├── middleware/             ← locale, auth, error handler, admin gate
├── routes/                 ← one file per resource group
├── controllers/            ← thin: request -> service -> response
├── services/               ← business logic (basket calc, matching, share, OAuth)
├── models/                 ← raw SQL queries + row mappers
├── scrapers/               ← chain-specific scrapers + shared scheduler
├── scripts/                ← one-off CLIs (admin, truth corpus, receipt batch)
└── utils/                  ← fuzzyNameClause, productMatcher, name parsers
```

## Deployment

Multi-stage Docker build. From the parent `Projects/` directory:

```bash
docker compose -f souply-api/docker-compose.yml build
docker compose -f souply-api/docker-compose.yml up -d
docker compose -f souply-api/docker-compose.yml logs -f
```

External Docker networks expected on the host:

- `mysql_net` — backing MariaDB
- `minio_2_default` — backing MinIO
- `souply_redis_default` — backing Redis (rename per your env)

Traefik on the LAN proxy reaches this service via host LAN IP + port 3000.
