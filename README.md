# souply-api

Backend for [Souply](https://souply.lt) — a grocery price-comparison platform for the
Lithuanian market. It ingests prices from five supermarket chains, turns photographed
receipts into structured line items, and answers the question the product exists to
answer: *what would this basket cost at each shop near me?*

Souply is split across four repositories:

| Repo | Role |
|---|---|
| **`souply-api`** | **This repo — Node/Express/MariaDB backend** |
| `souply-app` | React Native / Expo mobile client — receipt scanning, basket building |
| `souply-web` | Web client — landing, creator auth, dashboard |
| `souply-shared` | Receipt parsers and recognition config, shared with the app |

## Stack

- **TypeScript 6 · Node · Express 5**, native ESM
- **MariaDB** via `mysql2/promise` — raw SQL, no ORM
- **MinIO** (S3-compatible) for receipt images
- **`jose`** for JWTs, including JWKS verification of Google and Apple ID tokens
- **`node-cron`** for the scrape schedule
- **Playwright** (+ stealth) and **cheerio** for scraping — see below
- **Jest + supertest**, 137 test files
- **Sentry**, **helmet**, **compression**, **swagger-jsdoc**

Roughly 71,000 lines across 320 source files and 85 SQL migrations.

## Things worth a look

**No barcodes exist, so identity is the hard problem.** No Lithuanian chain publishes an
EAN — one has an `eans` field that is empty in every record. There is no join key, so
matching a receipt line to a catalogue product is done on name, size and price signals.
Two rules came out of failures rather than design: numbers are treated as *disambiguating*
rather than decorative, so 2.5% and 3.5% milk carry a mismatch penalty instead of being
smoothed over; and matching is zero-fallback — below the confidence threshold an item
stays unmatched, because showing a wrong price is worse than showing none.

**The connection pool encodes two production incidents.** `config/db.ts` is worth reading
for the comments alone. MariaDB has no native JSON type — `JSON` is `LONGTEXT` plus a
check constraint — so columns built with `JSON_ARRAYAGG` come back as strings, sometimes
double-encoded. That's normalised once in the pool's `typeCast` hook rather than at 1,000+
call sites. The connection charset is separately pinned to `utf8mb4` because mysql2
defaults the *connection* to three-byte `utf8mb3`, which silently mangles emoji in transit
and fails a downstream `json_valid` constraint.

**Overload sheds instead of hanging.** The pool is 20 connections with a queue limit of
256. The queue limit is the interesting number: a basket calculation fires ~8 short
queries, so a burst of concurrent users produces a burst of acquisitions. Too low and
legitimate spikes fail; unbounded and a pathological burst queues forever and takes the
API with it.

**Two scraping strategies, chosen by measurement.** Three chains serve their promotional
data in the initial HTML response and are read with a plain fetch plus cheerio. Two render
it client-side and need a real browser. That split is measured per site rather than
assumed, because a headless browser costs roughly an order of magnitude more per page.

**Shared expenses are an append-only ledger.** Household balances are never stored — they
are derived by folding events. Everything is integer cents, and each event's shares are
materialised at write time so the entries sum to zero by construction rather than by
convention. A balance cannot drift out of step with its history.

## Running locally

```bash
npm install
cp .env.example .env      # then fill in DB, MinIO and OAuth values
npm run dev               # nodemon + tsx, hot reload
```

```bash
npm run build             # tsc → dist/
npm start                 # node dist/souply-api/src/index.js
npm test                  # jest (needs a test database — see tests/schema/README.md)
npx tsc --noEmit          # typecheck
```

Scrapers and maintenance CLIs each have a script:

```bash
npm run scrape:all        # or :rimi :iki :barbora :norfa :lidl
npm run receipts:batch    # import + parse a staged receipt batch
npm run receipts:matchaudit   # match-quality harness with baseline diffing
npm run admin             # moderation CLI
```

## Layout

```
src/
├── index.ts        express bootstrap + middleware chain
├── config/         db pool, MinIO client, env loader, swagger
├── middleware/     auth, resource authorization, rate limit, locale, version gate
├── routes/         one file per resource group
├── controllers/    thin — request → service → response
├── services/       business logic: basket calc, matching, ledger, OAuth
├── models/         raw SQL and row mappers
├── scrapers/       per-chain scrapers + cron scheduler
├── scripts/        operational CLIs (receipt batches, audits, backfills)
└── utils/          matching helpers, name parsing

sql/                85 migrations, applied in order
tests/              137 suites, mostly integration via supertest
```

## Tests and CI

GitHub Actions runs typecheck, build and the full suite on every push and pull request,
against a MariaDB service container. The workflow checks out `souply-shared` alongside
this repo and pins it to the **same environment branch** as the run, so a pull request
into `staging` is tested against staging's parsers rather than `main`'s.

Branches are `dev` → `staging` → `main`, promoted by pull request. Commits follow
Conventional Commits, enforced by commitlint through husky.

## Status and licence

Actively developed and deployed. Published so the work can be read; not currently
accepting contributions, and no open-source licence is granted — all rights reserved.

The receipt corpus used for parser regression testing is deliberately **not** in this
repository: it consists of real receipts, which are personal data.
