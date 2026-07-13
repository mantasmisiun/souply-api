# Contributing — souply-api

Node/Express + MariaDB backend.

## Branches & flow
- `main` — **production**. Protected: PRs only, CI must pass, no force-push.
- `staging` — integration; deploys to the staging stack (`souply-api.manofoto.dpdns.org`).
- `feature/*` — your work. Branch off `staging`.

Flow: `feature/*` → PR into `staging` → validate on staging → PR `staging` → `main` (promotion) → prod deploy.

## Local setup
```bash
npm install
cp .env.production.example .env        # then fill in: DB→souply_dev, MinIO :9002, SESSION_JWT_SECRET (≥32 chars), etc.
npm run dev                            # ts watch on :3000
```
The app/shared parsers live in the sibling **`../shared`** repo (GitHub `souply-shared`); keep it cloned next to this repo.

## Tests
```bash
npm test                               # jest; needs a MariaDB (DB_* in .env.test → souply_test_ci)
```
`tests/globalSetup.ts` bootstraps the schema (`tests/schema/schema.sql`) into an empty DB and seeds the few reference rows tests rely on. CI spins up a MariaDB service + checks out `souply-shared`.

## Commits
Conventional Commits, enforced by commitlint (husky `commit-msg`). **Header ≤ 100 chars**, detail in the body:
```
feat(receipts): add foo        # type(scope): summary
```
Types: `feat fix chore docs refactor test build ci perf`.

## CI (GitHub Actions)
On every push/PR to `main`/`staging`: **typecheck (`tsc --noEmit`) + build (`tsc`) + tests**. All must pass before merge to `main`.
