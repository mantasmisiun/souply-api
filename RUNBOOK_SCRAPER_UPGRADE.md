# Runbook — scraper/matching upgrade rollout (2026-07)

Replicates the full dev arc on staging → prod. Everything is name-keyed and
idempotent; the same sequence runs identically per environment.

## 0. What this ships

- **validFrom price windows** — future-dated promos insert safely; effective-price
  gate at every read site; graphs/SP-card use `COALESCE(validFrom, date)`.
- **Advanced matcher in ALL scrapers** (`upsertPromo` → `scraperProductMatch`):
  same-chain reuse → cross-chain JOIN ≥0.8 → leaf-borrow mint 0.75–0.8
  (+`categoryReviewPending`) → top-3 category consensus → 688. Leaf-guard: mints
  never land in non-leaf categories.
- **Per-chain data upgrades** — Norfa promo-start + no-discount price stamps;
  IKI weighable/pack-size payload hints; Rimi breadcrumb `siteCategory` + retries;
  Barbora brand join + `category_name_full_path` + comparative-unit size; Lidl
  growth-gated pagination + gridbox tiles + ERP codes.
- **Lidl leaflet scraper** (`scrape:lidl:leaflet`) — the food weekly flyer (PDF
  vector text), self-validating tiles, umbrella variant SPs with code sets.
- **Product-code flywheel** — `StoreProductCode` (+evidence) maps chain-native
  codes → SPs; receipt sightings resolve umbrella variants at K=2; grid↔leaflet
  duplicates self-heal (dedup on same-pack code collision, website names win).
- **Backlog re-categorisation tools** — `lidlRecatBacklog`, `nonleafRecat`
  (T1 SP-dedup / T2 soft-merge / T3 move+review / T4a consensus / T4b leaf-vote / T5 688).

## 1. Migrations (in order; all backward-compatible)

```
sql/price_valid_from.sql             -- Price.validFrom + index
sql/product_category_review.sql      -- Product.categoryReviewPending + index
sql/store_product_site_category.sql  -- StoreProduct.siteCategory
sql/store_product_code.sql           -- StoreProductCode table
sql/store_product_code_evidence.sql  -- StoreProductCodeEvidence table
```

Per env (fish):
```fish
mariadb -h <host> -P <port> -u <user> -p<pw> <db> < sql/<file>.sql
```

Verify: `SHOW COLUMNS FROM Price LIKE 'validFrom';` etc. — all five objects present.

## 2. Deploy code

Normal branch promotion (dev → staging → main). No config changes.
**Prod container prerequisite:** `poppler-utils` (pdftohtml) for the leaflet
scraper — add to the API image (`apt-get install -y poppler-utils`).

## 3. One-off re-categorisation (run once per env, AFTER migrations + deploy)

```fish
# 1) Lidl scraped-backlog placement (dry first, review CSV, then apply)
npx tsx src/scripts/lidlRecatBacklog.ts
npx tsx src/scripts/lidlRecatBacklog.ts --apply

# 2) The non-leaf catalog cleanup (~7.7k on dev; staging/prod counts will differ)
npx tsx src/scripts/nonleafRecat.ts            # dry-run → nonleaf_recat.csv
npx tsx src/scripts/nonleafRecat.ts --apply    # fixpoint rounds; idempotent
```

Both scripts are safe to re-run (decided rows are skipped). MANUAL_MINT entries
are keyed by product NAME (env-independent); category ids in that map assume the
seeded category tree — verify ids match on staging/prod before apply
(`SELECT id, name FROM Category WHERE id IN (5,16,17,24,39,63,99,134,137,173,222,329,542)`).

## 4. Receipt-code backfill (optional, Lidl)

```fish
npx tsx src/scripts/replayReceiptCodes.ts      # corpus → evidence (idempotent)
```

## 5. Post-run verification (per env)

```sql
-- no products in non-leaf categories
SELECT COUNT(*) FROM Product p JOIN Category c ON c.id=p.categoryId
WHERE p.mergedIntoId IS NULL AND c.id<>688
  AND EXISTS (SELECT 1 FROM Category ch WHERE ch.parentCategoryId=c.id);   -- expect 0
-- review queue size (admin backlog)
SELECT COUNT(*) FROM Product WHERE categoryReviewPending=1;
-- windows live
SELECT COUNT(*) FROM Price WHERE validFrom IS NOT NULL AND validFrom > NOW();
-- codes flowing (after first Lidl scrape + leaflet run)
SELECT COUNT(*) FROM StoreProductCode;
```

Then one full `npm run scrape:all` + `npm run scrape:lidl:leaflet` and check the
Telegram summaries: `errors: 0`, new Products land only in leaf categories or 688.

## 6. Known follow-ups (not in this rollout)

- Receipt-parser code extraction (souply-app + shared) — gated arc: corpus
  `/replay` sweep + both suites; feeds `recordCodeEvidence` live.
- Admin UI for `categoryReviewPending` + umbrella queue (flyer-crop preview).
- Name-mismatch flags on single-code SPs (receipt names vs stored names).
- IKI `erpCode` → StoreProductCode (same flywheel, needs receipt-side codes).
