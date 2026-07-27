# Recipe-import validation corpus

A frozen set of real recipe pages used to measure how well recipe import turns an
ingredient line into a catalog product. It lives here, next to `receipts/_logs/`,
because it is the same kind of thing: a regeneratable evidence pile that must
survive a session ending.

**This corpus used to live in a session scratchpad and was deleted with it.
Nothing about it may move back there.**

## Layout

| path       | what it is                                            | in git?      |
|------------|-------------------------------------------------------|--------------|
| `urls/`    | JSONL URL lists — the expensive, curated part          | **tracked**  |
| `pages/`   | harvested HTML, one file per recipe, plus manifest     | gitignored   |
| `tables/`  | sweep output (`*.jsonl`), one row per ingredient        | gitignored   |

`pages/` and `tables/` are **disposable** — delete them and re-run the harvest.
`urls/` is **not**: rebuilding it means re-crawling a dozen publishers, verifying
every link is live, and re-balancing the category spread. If you only keep one
thing, keep `urls/corpus.jsonl`.

`.gitignore` carries a narrow rule for `receipts/_recipes/pages/` and
`receipts/_recipes/tables/` only, so `urls/` stays committable.

## What the corpus contains

`urls/corpus.jsonl`, one object per line:

```json
{"url":"…","lang":"lt","site":"lamaistas.lt","category":"soups","dish":"…","ingredientCount":9}
```

180 verified single-recipe pages — 120 Lithuanian, 60 English — 15 per category
across all twelve: soups, meat, fish, salads, vegetables, stews, desserts, cakes,
cookies, bread, drinks (non-alcoholic), alcohol (cocktails, liqueurs, mulled wine).
Every URL was fetched and confirmed to expose a real ingredient list before it was
written to the file.

## Commands

Run everything from the repo root.

```bash
# 1. harvest — fetch each URL once, store the HTML. Incremental: a page already
#    in pages/ is reused, so re-running only picks up stragglers.
npm run recipes:harvest -- --urls receipts/_recipes/urls/corpus.jsonl --out receipts/_recipes/pages

#    force a fresh copy of everything (the sites change under you):
npm run recipes:harvest -- --urls receipts/_recipes/urls/corpus.jsonl --out receipts/_recipes/pages --refetch

# 2. sweep — the baseline. Reads the frozen bytes, so two runs are comparable.
npm run recipes:sweep -- --dir receipts/_recipes/pages --json receipts/_recipes/tables/baseline.jsonl

#    totals only:
npm run recipes:sweep -- --dir receipts/_recipes/pages --json receipts/_recipes/tables/baseline.jsonl --quiet

#    one live page, no corpus:
npm run recipes:sweep -- --url https://…

# 3. after a matcher/parser change: sweep to a NEW table, then diff it
npm run recipes:sweep -- --dir receipts/_recipes/pages --json receipts/_recipes/tables/after.jsonl
npm run recipes:diff -- receipts/_recipes/tables/baseline.jsonl receipts/_recipes/tables/after.jsonl
```

The sweep needs the dev database (`souply_dev`) — it resolves ingredients against
the real catalog. The harvest does not.

## The harness measures MATCH QUALITY, not correctness

The summary block counts how many ingredients found *a* product and how confident
the matcher was. It cannot tell you whether the product is the right one. A rising
match rate with the wrong products is exactly the failure this corpus exists to
catch.

**Correctness comes from reading the table.** Open `tables/baseline.jsonl` (or drop
`--quiet` and read the per-ingredient lines) and judge the `name → productName`
pairs yourself. "aliejaus → Alyvuogių aliejus" is a bad match no percentage will
flag. Treat the summary as a regression tripwire and the table as the verdict.

## Regenerating `urls/` from scratch

Only if the list is lost. Crawl category listing pages per site, extract recipe
links, then verify each one is live and exposes an ingredient list before adding
it. Notes that cost time to learn:

**LT sites that work** — `lamaistas.lt`, `receptai.lt`, `beatosvirtuve.lt`,
`valgom.lt`, `greitireceptai.lt`.

**LT sites that are DEAD — do not try** — `skanurasti.lt`, `ievosreceptai.lt`,
`gaspadine.lt`.

**EN sites** — `allrecipes.com`, `bbcgoodfood.com`, `seriouseats.com`,
`simplyrecipes.com`, `food.com`, `tasty.co`.

Gotchas:

- The Dotdash Meredith network (allrecipes, seriouseats, simplyrecipes) answers a
  plain fetch with 402/403. That is a TLS-fingerprint refusal, not rate limiting —
  `fetchRecipeHtml` already falls back to a real Chromium and resolves it. **Retry
  with backoff; never discard a URL for a 402/403.**
- `tasty.co` refuses topic/listing pages (406) even through Chromium; individual
  `/recipe/<slug>` pages are fine. Collect its links from pages that embed them.
- `valgom.lt` category pages (`/k/<cat>`) render recipe links server-side as
  absolute URLs; its sitemap (`/sitemap.xml` → `sitemap-recipes-N.xml`) has no
  category labels.
- `greitireceptai.lt` recipe pages carry a correct ingredient list but the
  extractor reads the title as `"Titulinis"`. Do not treat that as a broken page —
  fall back to the URL slug for the dish name. It is a genuine extractor weakness
  worth keeping in the corpus.
- Skip `/feed/`, `/amp/`, `/print/` URLs — no ingredient markup.
- Cocktails and liqueurs really do have three ingredients. A "minimum four
  ingredients" filter silently deletes the whole drinks half of the corpus.
- `15min.lt` (`/gyvenimas/receptas/`) is listed as working, but its recipe pages
  are not reachable from the public sitemaps; it is not in the current corpus.
