# Reducing "ask the user" in recipe import

**Status:** proposal / research. No code changed.
**Measured against:** `receipts/_recipes/tables/after_gate.jsonl` (1 661 rows, 180-recipe corpus),
`receipts/_recipes/verdicts_h05/slice_{1,2}.jsonl` (152 judged ingredients).
**Date:** 2026-07-27. **DB probed:** `souply_dev` @ 192.168.1.212:3307, MariaDB **11.4.11**.

---

## 0. The headline, before anything else

The measured cause of the 13 % ask rate is **not** a catalog gap, **not** a scoring
threshold, and **not** a ranking bug. It is this:

> The ingredient knowledge base replaces the recipe's own words with a generic
> canonical name **before the catalog is ever asked**, and the specific product the
> recipe wanted is then unreachable — even though it is sitting in the catalog and
> `searchProduct` finds it at rank 1 when you hand it the recipe's own phrase.

Verified by running the real `searchProduct` against the raw recipe phrases:

| recipe phrase | query the matcher actually sent | product it bought | `searchProduct(phrase)` rank 1 |
|---|---|---|---|
| `kiaulienos karka` | `Kiauliena` | Atšaldyta smulkinta kiauliena, 30 % | **Lietuviška kiaulienos karka su kaulu** |
| `Pekino kopūstai` | `Kopūstai` | Lietuviški baltagūžiai kopūstai | **Pekino kopūstai "Sprinkin H"** |
| `kokosų miltų` | `Kvietiniai miltai` | Kvietiniai miltai 550 D | **Ekologiški kokosų miltai BIONATURALIS** |
| `pusriebės varškės` | `Varškė` | Varškė PRESIDENT 4 % | **Pusriebė varškė FARM MILK 9 %** |
| `rūkytos saldžiosios paprikos` | `Saldžiosios paprikos` | Raud. saldžiosios paprikos (fresh) | **Saldžios rūkytos raudonosios paprikos SAUDA** |
| `kajeno paprikos` | `Saldžiosios paprikos` | Raud. saldžiosios paprikos (fresh) | **Kajeno paprikos SANTA MARIA** |
| `rauginti agurkai` | `Marinuoti agurkai` | Marinuoti agurkai SPILVA | **Rauginti agurkai** |
| `golden syrup` | *(none — no lexicon entry)* | *nothing* | **Auksaspalvis sirupas DANSUKKER** (only row) |
| `chorizo` | *(none)* | *nothing* | **Ispaniška vytinta dešra CHORIZO SARTA** |
| `citric acid` | *(none)* | *nothing* | **Citrinų rūgštis KLINGAI** |

So the primary fix is not a new subsystem. It is **stop throwing the recipe's words
away**, and make that affordable.

Two things make the brief harder than it looks, and both are measured:

1. **The flag is currently load-bearing.** Of the 152 judged ingredients,
   **all 6 CRITICAL errors happened in the SILENT path** and **all 7 MAJOR errors
   were caught by a flag**. Flag precision is 18/27 = 67 %. Blindly suppressing
   flags ships ~7 MAJOR errors per 183 ingredients. The goal must be *fewer wrong
   products*, not *fewer questions*.
2. **The flagged set is a long tail.** 267 flagged rows span **246 distinct
   normalised phrases**; only 18 phrases repeat (39 rows). A learned "ask once"
   alias therefore cannot be the *primary* lever — it is the residual catcher.
   (See §4.5 for why this is the single most important sizing fact in this document.)

---

## 1. CHARACTERISATION — what actually needs a human

### 1.1 Headline numbers

| | rows | note |
|---|---:|---|
| total ingredient rows | 1 661 | |
| matched to a product | 1 598 | |
| — of which `confident: false` | **204** | **12.77 %** — this is the "13 %" |
| no product at all (`productId: null`) | 63 | shown to the user as *skipped* |
| **total rows that need a human** | **267** | 16.1 % of all rows |
| pantry rows (struck in one tap) | 593 | |

`reviewReason` as recorded today:

| reviewReason | rows |
|---|---:|
| `dropped_word` | 133 |
| *(null — unmatched, no product)* | 61 |
| `generic_fallback` | 36 |
| `generic_ingredient` | 19 |
| `soft_score` | 14 |
| `low_score` | 2 |
| `unlisted_product` | 2 |

`reviewReason` is a *symptom* label, not a cause. Below is the cause taxonomy.

### 1.2 Cause classes (mechanism, not symptom)

Derived programmatically from `lexiconKey` / `query` / `productId` / `reviewReason`,
then cross-checked by reading every distinct row. "Retrievable" = an AND-of-all-recipe-
content-words `LIKE` against `Product.name` (LT rows) or `StoreProductTranslation.normalized`
(EN rows) returns ≥ 1 product.

| # | cause class | rows | retrievable | machine-resolvable? |
|---|---|---:|---:|---|
| **A** | **Lexicon over-generalised the query.** The phrase carried a qualifier (`karka`, `Pekino`, `kokosų`, `rūkytos`, `pusriebės`) that the lexicon mapped away to a generic `ltName`; the generic query cannot retrieve the specific product. | **156** | 54 | **YES — deterministic.** The phrase is already in hand; `searchProduct` already finds the product. §4.1 |
| **B** | **No query generated at all.** English phrase with no lexicon entry → `query = null` → the ingredient is dropped before any search. (`tequila`, `chorizo`, `pesto`, `croissants`, `citric acid`, `passion fruit`, `golden syrup`, `Cajun seasoning`, `Sumac`, `Marsala`…) | **43** | 20 | **YES — cheaply.** `StoreProductTranslation` already holds **55 116 English names covering 55 096 of 56 386 StoreProducts (97.7 %)**. It is simply never consulted. §4.2 |
| **B2** | Query built, nothing cleared the accept bar. (`akvafabos`, `ruginių dribsnių`, `Vanilinas`, `„dansukker“ auksaspalvis sirupas`, `Meliono`) | **20** | 11 | **PARTLY.** Some are true catalog gaps; some (`auksaspalvis sirupas`) are exact catalog matches the generic query never reached → class A in disguise. |
| **C** | **Unvouched query** — no lexicon entry, LT phrase used raw; the score measures nothing about identity. (`"devynerios" raudonos`, `prieskonių puokštės` → *a 2026 CALENDAR*, `Jei norisi` → *a dried sausage*) | **26** | 15 | **PARTLY.** Half are parser residue that should never have become an ingredient; the rest need an edibility/category gate. §4.4 |
| **D** | **The ingredient names only a category.** `mėsa`, `daržovių`, `žalumynų`, `uogų`, `prieskoniai`, `sėklų`, `vaisiai`. | **15** | 15 | **NO — genuinely unanswerable.** No single product is right; the recipe did not say which. This is the *honest residual ask*. |
| **E** | Other (`soft_score` with a lexicon entry — `Mango` → dried mango because the fresh shelf is empty; `juodųjų serbentų` → blackcurrant **vodka**). | **7** | 5 | **PARTLY** — needs the category/edibility gate. |
| | **TOTAL** | **267** | **120** | |

### 1.3 Sub-structure of class A (the big one), by reading all 133 `dropped_word` rows

| sub-class | ≈rows | example | is the current pick wrong? |
|---|---:|---|---|
| A1 wrong variant/cut, right family | ~45 | `Pekino kopūstai` → white cabbage; `kiaulienos karka` → mince; `rauginti agurkai` → pickled-not-fermented; `Apvalūs ryžiai` → Basmati; `Olandiškas sūris` → Rokiškio | **yes** |
| A2 English identity adjective | ~30 | `distilled white vinegar` → apple cider vinegar; `frozen sweetcorn` → canned; `dried navy beans` → canned | often |
| A3 instruction/purpose tail not stripped | ~16 | `aliejaus kepti`, `medaus bandelėm aptepti`, `Sirupo neišpilkite`, `single cream to serve` | **no — pure false positive** |
| A4 brand token in the recipe line | ~13 | `dansukker cukrus farinas` → generic sugar (**`Cukrus DANSUKKER FARINAS` exists**); `Kreminis sūris „PHILADELPHIA“` → WELL DONE (**`Tepamasis sūris PHILADELPHIA` exists**) | **yes** |
| A5 derived product bought as raw | ~11 | `pomidorų tyrė` → fresh tomatoes; `vyšnių sultys` → **BBQ wood chips**; `kokosų miltų` → wheat flour | **yes** |
| A6 powder/dried spice vs fresh produce | ~8 | `saldžiosios paprikos miltelių` → fresh peppers (**`Maltos saldžiosios paprikos SANTA MARIA` exists**); `džiovintų česnakų` → fresh garlic (**`Česnakų granulės SALDVA` exists**) | **yes** |
| A7 catalog noise won | ~6 | `Raudonųjų serbentų` → **vodka**; `moliūgo` → **seed packet**; `romaninių salotų` → **shallots** (lexicon key bug) | **yes** |

### 1.4 What the judged verdicts add

152 judged ingredients, cross-referenced against `holdout05.jsonl`:

| verdict | in the SILENT path | caught by a flag |
|---|---:|---:|
| OK | 98 | 9 |
| MINOR | 20 | 3 |
| MAJOR | 0 | **7** |
| **CRITICAL** | **6** | 0 |
| MISSING | 0 | 5 |
| CATALOG_GAP | 0 | 2 |
| PARSE_BAD | 1 | 1 |

The 6 CRITICALs, all silent: `bacon` and `bacon lardons` → raw chilled pork belly;
`cream cheese` → RAMBYNO processed cheese while **Philadelphia is stocked**;
`pasta sauce` → dry tagliatelle; `kiauliena (kumpis, rūkytas, juostelės)` → raw mince;
`tešlos` → a bag of pastry SNACKS.

**Every one of these six is class A or class B** — the specific words (`bacon`,
`cream cheese`, `pasta sauce`, `rūkytas kumpis`) were dropped before retrieval.
The same fix that removes the asks removes the CRITICALs. That is the strongest
argument for the recommendation below.

Genuine catalog gaps found by the judges: **2** (fish stock, star anise). That is the
true floor for "we cannot buy this", and it is ~1 %.

---

## 2. INVENTORY — what already exists here

### 2.1 `src/utils/productSearchMatch.ts` — the one match-clause builder (103 lines)

Five signals, in relevance rank order:

| arm | source | what it gives you |
|---|---|---|
| 1 | `Product.name` fuzzy, diacritic-folding `LIKE` | head match |
| 2 | `Product.name` **stemmed** `LIKE` (`stemQuery`) | inflection recall (`sojos`→`sojų`) |
| 3 | `StoreProduct.storeProductName` | SP names that diverge from the cluster head |
| 4 | **`StoreProductTranslation.normalized`** | **EN names + LT synonyms** |
| 5 | `StoreProductReceiptAlias` where `status='canonical'` | user-confirmed receipt namings |

All AND-composed per stem, `COLLATE utf8mb4_unicode_ci` (which folds `ą`→`a` at
primary weight — that is the "diacritic folding").

**Cost:** `searchProduct` runs these as **up to 8 sequential SQL round trips**
(2 name arms + 3 id-arms × (subquery + hydrate)). Measured p50 **390 ms**, max **1 235 ms**
against dev over LAN. A single `Product.name` two-token `LIKE` scan alone profiles at
**40–58 ms**; the translation join at **187 ms**. There is no index that helps a leading-
wildcard `LIKE`; these are collation-bound full scans of a 46 803-row table.

**This is the single biggest constraint on the whole proposal.**

### 2.2 `src/models/storeProductAliasModel.ts` + `sql/receipt_name_vocabulary.sql` (332 lines)

A complete, shipped, *proven* human-in-the-loop vocabulary:

- `StoreProductReceiptAlias` (chainId, storeProductId, normalizedAlias, occurrences,
  identicalUsers/similarUsers/differentUsers, status, adminVerdict) —
  `UNIQUE (chainId, storeProductId, normalizedAlias)`, `KEY idx_match (chainId, status, normalizedAlias)`.
- `StoreProductReceiptAliasVote` — one row per (alias, user), upsert, latest vote wins.
- `deriveAliasStatus()` — the **balanced-veto state machine**: adminVerdict wins;
  a `different` vote rejects only when dissenters **tie or exceed** confirmers;
  else **K = 2 distinct `identical` users → canonical**; else `similar` → similarity; else pending.
- `fetchAliasesByChainGrouped()` — **one query** returns canonical / rejected /
  similarity maps for a whole chain.
- `fetchPendingAliasCards()` — surfaces unresolved aliases as swipe cards, with a
  no-repeat rule per user.

**Cost:** 2 small tables, 1 query per chain to load, no nightly job.
**Current size in dev: 14 rows.** The machinery is far more mature than its data.

**This is the exact "ask once, learn forever" primitive the brief asks for, already built,
already reviewed, already shipped — and it is generic enough to take a second alias kind
with almost no new code.**

### 2.3 `productAffinityService.ts` + `productInteractionModel.ts` (277 + 96 lines)

- `UserProductScore` — `PRIMARY (userId, productId)`, sparse, decayed;
  305 rows in dev. `loadAffinityCache(userId)` reads a shopper's whole table in one query
  (~0.2 ms, 113 rows for the busiest dev account) and is reused for a whole import.
- `Product.globalScore` — everybody's decayed total, re-decayed nightly.
- `rankAffinity(items)` — ranks candidates **against each other** on each side separately,
  then blends by a confidence that rises to 1.0 at 10 interactions. Carries a large
  documented trap: `personal ≤ global` is an invariant, so a per-product convex blend can
  only ever *penalise* a preference. **Do not re-derive this.**
- `refreshUserProductScores()` — nightly rebuild from `ProductInteraction`.

**Cost:** one cached query per import. Already wired into recipe import
(`matchIngredient(..., userId, affinityCache)`), stamped **before** ranking.

**Gap:** with `totalInteractions === 0` it returns a flat zero by design — so it does
nothing for a new shopper, and it cannot express "this *phrase* means this product",
only "this shopper likes this product".

### 2.4 `src/services/recipes/recipeMatcher.ts` (~2 000 lines) — where `confident` is decided

Thresholds: `AUTO_ACCEPT` 0.85, `SOFT_ACCEPT` 0.75, `SILENT_ACCEPT` 0.85, `MIN_ACCEPT` 0.62,
`CANDIDATE_CAP` 40, `RANKING_POOL` 12.

The decision (lines 595–615):

```
genericAsk        → 'generic_ingredient'
unitConflict      → 'unit_conflict'
fellBack          → 'generic_fallback'
dropped           → 'dropped_word'
best.unlisted     → 'unlisted_product'
best.demerits > 0 → 'soft_score'
conf < 0.85 && info == null → 'soft_score'
else                → null   // confident
```

**Three mechanisms in `findProducts` cause class A, and all three are visible in the code:**

1. **The query list is generic-first:** `[ltName, ...aliases, recipeArm(nameFull), recipeArm(name)]`.
2. **The loop breaks early** — `if (leader && leader.confidence >= AUTO_ACCEPT) break;`.
   So when `Kiauliena` returns a 0.85+ leader, **`kiaulienos karka` is never searched at all.**
   The comment is explicit about why: *"Each extra query is another five ranked SQL arms."*
   The early break exists **because retrieval is slow**.
3. **Ranking and acceptance judge against `queries[0]`** — the generic name — so even when
   the specific arm does run and merges, the specific product is scored against the wrong query.

Measured consequence: for flagged rows the runner-up beats the pick on confidence in only
11/204 rows (5 %) — i.e. the right product is usually **not even in the returned pool**,
which rules out "just re-rank" as a sufficient fix.

`droppedWord()` is a genuinely good guard (LT stem coverage + lexicon window + shelf
abbreviations + shop synonyms + a 26-stem non-identity list + a 40-word EN identity list).
It is not the problem; it is correctly reporting that retrieval was handed the wrong query.

### 2.5 Everything else relevant

- **No recipe tables exist.** `sql/` has 80 migrations, none recipe-related. Import is
  entirely stateless: `POST /api/recipes/import` returns a *preview*; the app then calls
  `POST /api/basket-templates`.
- **`app/recipe-import.tsx` line 115 — `swapProduct`.** When the shopper corrects a match,
  it mutates local state and sets `needsReview: false`. **Nothing is sent to the server.
  Every correction the system has ever been given has been thrown away.**
- Corpus harness: `npm run recipes:sweep -- --dir … --json …` then
  `npm run recipes:diff -- before.jsonl after.jsonl`, keyed on `(url + raw line)`,
  splitting gains from losses. **This is exactly the instrument needed to prove any of this.**

---

## 3. HOW THIS IS SOLVED ELSEWHERE

### 3.1 The convergent industry architecture

Every vendor that discloses detail uses the same three layers:
**parse → resolve to a canonical/generic ingredient (low thousands of classes) → rank
retailer SKUs within that class by availability, price, pack fit, and *historical conversion*.**
Souply already has layers 1 and 2 (`ingredientParser.ts`, `ingredientData.ts` with 355 entries).
**The measured failure is that souply's layer-2 output *replaces* the phrase instead of
*accompanying* it into layer 3.**

| system | what they do | source | cost / fit here |
|---|---|---|---|
| **Instacart** (patent US20230260007A1, "Mapping recipe ingredients to products") | NLP → map to a **"generic item"** (brand-free) via **string matching + rule-based systems** → query product DB → rank candidates with a model trained on **"historical conversions by customers presented with an opportunity to add products"** → auto-select top-ranked. | [patents.google.com/patent/US20230260007A1](https://patents.google.com/patent/US20230260007A1/en) | The generic layer is `ingredientData.ts`. The **conversion model is what souply lacks and what §4.3 proposes in miniature.** Free to imitate. |
| **Instacart Recipe API** | `name` is used **as a search term**; "specify the generic product name … broadest match". But `upcs` / `product_ids` let a partner **pin a SKU directly**, and pinned UPCs take priority. | [docs.instacart.com](https://docs.instacart.com/developer_platform_api/guide/concepts/recipe/) | Direct precedent for a **phrase→product pin table** (§4.3). Even Instacart does not trust pure matching. |
| **Instacart ITEMS** (search embeddings) | Two-tower sentence-transformer bi-encoder fine-tuned on (query, converted product) pairs from search logs. **+10 % Recall@20, +4.1 % cart-adds, +1.5 % GMV.** | [arXiv 2209.05555](https://arxiv.org/abs/2209.05555) | Needs conversion logs souply does not have yet. **Not now** — see §4.6. |
| **Chicory** ("Dolores" Food AI) | Contextual disambiguation ("is *pepper* black pepper or bell pepper?"), taxonomy mined from 3M+ recipes, **supervised learning from user cart edits**. Google Cloud raised AutoML's 100-classifier cap to **5 000** for them → their canonical space is **low thousands of classes**, same order as souply's 355. | [cloud.google.com/customers/chicory](https://cloud.google.com/customers/chicory) | **Validates the lexicon's size and the learn-from-corrections loop.** |
| **Chicory 2019 pivot** | Dropped their own cart and **"eliminat[ed] real-time ingredient parsing and inventory mapping"** — which let them *"more accurately match ingredients to products at grocers"*. | [prnewswire.com](https://www.prnewswire.com/news-releases/chicory-streamlines-two-click-shoppable-recipe-experience-300816072.html) | **Precompute, don't resolve live.** Directly motivates §4.1's in-memory index and §4.3's cache. |
| **Northfork** | Inventory-first: *"we will directly match which of the 7 000 recipes … with the current assortment they have in stock"*; re-ranks by purchase history; CEO claims **~98 % of users keep the recommended product**. Ships a **"Match Adjustment Tool — self-serve correction tool"**. | [foodnavigator.com](https://www.foodnavigator.com/Article/2019/09/11/We-have-not-seen-the-full-potential-Online-recipe-firm-Northfork-discusses-UK-expansion-plans/), [northfork.ai](https://northfork.ai/products/recipe-shopping-foundation) | The 98 % figure is the realistic ceiling — **and it is achieved with a human correction tool in the loop.** |
| **Whisk / Samsung Food** ("Food Genome") | Deep-learning food ontology; store catalogs are **mapped into the ontology automatically**; *"most shopping-list line-items have multiple possible products … Whisk selects defaults based on algorithms"*; gram-level density normalisation. Powers Tesco, Sainsbury's, Ocado, Kroger. | [venturebeat.com](https://venturebeat.com/ai/how-whisk-is-using-its-food-genome-to-turn-recipes-into-smart-shopping-lists/) | Confirms Tesco/Ocado/Sainsbury's/Kroger **buy** this rather than build it. Trained on 500M interactions/month — not reproducible here. |
| **Walmart** (patent US11562414B2) | NER extracts ingredient + quantity → **used directly as catalog search terms** → when catalog search fails, an **n-gram model generates alternative search variations**. | [patents.google.com/patent/US11562414B2](https://patents.google.com/patent/US11562414B2/en) | **This is exactly §4.1 + §4.2**: send the phrase, and on failure widen. Patent-documented as the mainstream approach. |
| **Walmart Retail Graph** | Entity linking via a dictionary built from top-selling SKUs; substitutes via text+image embeddings in FAISS; plus **"a governance module which can weed out noise using … manual tagging."** | [medium.com/walmartglobaltech](https://medium.com/walmartglobaltech/retail-graph-walmarts-product-knowledge-graph-6ef7357963bc) | Human curation is in the architecture, not an embarrassment. |
| **Amazon** (patent US9165320B1) | String matching + **category/taxonomy mapping** (cabbage → napa/savoy) + fuzzy logic + **manual mapping UIs for recipe editors**, written into the claims. | [patents.google.com/patent/US9165320B1](https://patents.google.com/patent/US9165320B1/en) | Same conclusion. |
| **Amazon Semantic Product Search** (KDD 2019) | Chose **average pooling + n-grams over LSTM/GRU** (< 0.5 % MAP difference at far lower latency); deployed to **augment, not replace, lexical matching**. | [amazon.science](https://www.amazon.science/publications/semantic-product-search) | Strong evidence that **lexical-first + cheap augmentation** is the right shape for a small system. |
| **SideChef** | *"AI-powered matching with high accuracy, **plus manual verification**"*. | [sidechef.com](https://www.sidechef.com/business/recipe-platform/shoppable-recipe-button) | — |
| **Spoonacular** | `POST /food/ingredients/map` maps free text → **its own ~80 000 US packaged products**, not a live retailer catalog. **Free tier = 50 points/day, backlink required**; then $29–149/mo. | [spoonacular.com/food-api/pricing](https://spoonacular.com/food-api/pricing) | **Fails free-only at any real volume, and cannot reach Lithuanian SKUs. Excluded.** |
| **Rimi Lietuva** (the local incumbent) | `rimi.lt/receptai` ingredient lines are **authored directly against Rimi's own SKU names** — "Pusriebė varškė RIMI 500 g", "Kvietiniai miltai RIMI 405D" — with one basket button. **Human curation at authoring time, no free-text matching at all.** | [rimi.lt/receptai/varskeciai/15359](https://www.rimi.lt/receptai/varskeciai/15359) | **The competitive bar in this market is: no runtime matching whatsoever.** Souply is already ahead; it needs to be *reliable*, not superhuman. |

### 3.2 Named techniques, with fit

| technique | what it is | who | cost | fits Node/MariaDB free-only? |
|---|---|---|---|---|
| **Query rewriting from behavioural logs / OR-expansion** | Mine (query → better query) pairs; expand a failing query with learned synonyms. eBay's key finding: **more synonym pairs → lower precision**, so promotion must be conservative. | [Jones et al. WWW 2006](http://www.rosiejonesphd.com/papers/jones-www2006-generating-query-subs.pdf); [eBay SIGIR eCom 2019](https://sigir-ecom.github.io/ecom2019/ecom19Papers/paper20.pdf) | ~0 | **YES — this is §4.1/§4.3.** Best fit in the whole list. |
| **Fellegi–Sunter record linkage** | Per-field `log2(m/u)` agreement weights; rare-token agreement scores high, common-token agreement scores low. Two thresholds → match / **clerical review** / non-match. | [Fellegi & Sunter 1969](http://www2.stat.duke.edu/~rcs46/linkage/presentations/01-baiLi_FelleigSunter1969.pdf); **Splink** (MIT, trains `m`/`u` unsupervised via EM) | Offline train; weights export as JSON; ~200 lines of JS at runtime | **YES**, but it replaces `findBestProductMatches`, which is heavily tuned. **Deferred** — high risk, unclear marginal gain over §4.1. |
| **Learning-to-rank from implicit feedback** | Relative preferences ("clicked > skipped-above") are reliable even though absolute clicks are position-biased. LambdaMART/LightGBM `lambdarank`, exportable to ONNX or transpiled from `model.txt`. | [Joachims SIGIR 2005](https://www.cs.cornell.edu/people/tj/publications/joachims_etal_05a.pdf); [Burges MSR-TR-2010-82](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/MSR-TR-2010-82.pdf) | LightGBM MIT, offline training free | **YES eventually.** Needs logs that do not exist yet. **§4.3 creates them.** Note: Elastic's *native* LTR needs an Enterprise subscription → excluded. |
| **Margin / uncertainty sampling** | Auto-accept when top-1 beats top-2 by a wide margin; ask only in the middle band. | [Settles, AL survey CS-TR-1648](https://minds.wisconsin.edu/bitstream/handle/1793/60660/TR1648.pdf) | ~0 | **YES — §4.4.** Replaces today's "any dropped word → ask" with "ambiguous → ask". |
| **K≥2 promotion with veto** | Never promote on one label; conflicting vote demotes to pending. Algolia's Dynamic Synonym Suggestions **proposes to an admin rather than auto-applying**, even at their scale. | [algolia.com](https://www.algolia.com/doc/guides/algolia-ai/dynamic-synonym-suggestions) | ~0 | **YES — already shipped as `deriveAliasStatus`.** |
| **Embedding / vector similarity** | `multilingual-e5-small`: **384 dims, int8 ONNX = 118 MB, MIT, Lithuanian explicitly supported**. 50k × 384 × 4 B ≈ **77 MB** of vectors. Runs via `onnxruntime-node`. | [intfloat/multilingual-e5-small]; [MMTEB arXiv 2502.13595] | 118 MB model + ~77 MB vectors + ~15–30 ms/query CPU *(inferred, not measured)* | **Technically yes, but:** ⚠️ **MariaDB `VECTOR` is GA only in 11.8 LTS — this server is 11.4.11.** Brute-force cosine in Node is fine at 50k. **MMTEB shows notable quality decline for lower-resource languages — treat as a recall booster, not a precision oracle, for Lithuanian.** **Deferred to §4.6.** |
| **Lithuanian stemming** | Snowball has an official **Lithuanian stemmer** (BSD, Dainius Jocas 2018), compiles to JS; npm `node-snowball` includes `lithuanian`. | [snowballstem.org](https://snowballstem.org/algorithms/lithuanian/stemmer.html) | 0 RAM, in-process | **YES.** Would strengthen `searchStem.ts`. Low-risk optional upgrade. ⚠️ **Avoid Lemuoklis — CC BY-NC-SA, NonCommercial.** |
| **Open Food Facts taxonomy** | `taxonomies/food/ingredients.txt`, 2.7 MB, ~80k lines, **ODbL**, with verified `lt:` lines *in the inflected forms recipes use* (`lt: kiaušinių, kiaušinio`). Carries **Wikidata QIDs** → CC0 Lithuanian labels. | [openfoodfacts.org] | ~6 MB, one-off import | **YES — the cheapest way to widen `ingredientData.ts`'s 355 entries.** OFF's *Lithuanian product* coverage (10 586) is too thin to be a SKU source. ⚠️ ODbL share-alike matters only on redistribution. |
| **Self-hosted LLM for offline adjudication** | Locally deployable DeepSeek-R1-Distill-Qwen-14B reached **98.23 % F1** on entity matching. | [arXiv 2310.11244](https://arxiv.org/abs/2310.11244) | free, but slow | **Batch only**, never on the request path. Useful to bootstrap §4.2's lexicon expansion offline. |
| ⚠️ **MariaDB has no `ngram` fulltext parser** | [MDEV-10267](https://jira.mariadb.org/browse/MDEV-10267) open since 2016, unresolved. | | | Rules out MySQL-style n-gram FULLTEXT. Alternatives: Mroonga, a DIY n-gram table, or a SQLite FTS5 trigram sidecar. **§4.1 sidesteps this entirely by matching in-process.** |

---

## 4. THE PROPOSAL

### Ranked summary

| # | change | cause classes removed | est. rows | impl. cost | runtime cost | ratio |
|---|---|---|---:|---|---|---|
| **L0** | **In-memory catalog index** (enabler) | none directly | 0 | S | **−388 ms/query** | ∞ (it *buys* budget) |
| **L1** | **Phrase-first retrieval** | A, part of B2 | **~56** measured | M | 0 (given L0) | **highest** |
| **L2** | **English phrase → `StoreProductTranslation`** | B | **~12–19** measured | **S** | 0 (given L0) | **highest per line of code** |
| **L3** | **`RecipeIngredientAlias` — learn from the swap** | residual of A/B2/C/E | 39 in-corpus; unbounded at scale | M | 1 cached query | high but **unproven at scale** |
| **L4** | **Margin-based silent gate** | A3 (false positives), part of E | ~16 | S | 0 | high |
| **L5** | **Edibility / category-family gate** | A7, C, E | ~15 | M | 0 (given L0) | medium |
| **L6** | Embeddings / LTR | long tail | unknown | **L** | 118 MB + CPU | **do not build yet** |

**Primary recommendation: L0 + L1 + L2 + L4, then L3.** L5 is a correctness fix that
should ride along. L6 is explicitly *not* recommended now.

---

### 4.1 L1 — Phrase-first retrieval (with L0 as its enabler)

**The change.** The recipe's own phrase becomes a first-class retrieval arm that
**always** runs, in parallel with the lexicon's canonical name; the early break is
removed; and **each candidate is scored against the arm that found it**, not against
`queries[0]`.

Concretely, in `findProducts` / `matchIngredient`:

1. Run **both** `ltName` and `nameFull` arms unconditionally (plus lexicon aliases).
2. Tag every `ProductPick` with `viaQuery` — the string that retrieved it.
3. In `rankPicks` / `acceptable`, judge `queryFullyPresent(p.viaQuery, p.name)` rather
   than `queryFullyPresent(acceptQuery, p.name)`.
4. **Prefer the more specific arm when it produces an acceptable candidate**: a
   candidate found by the *phrase* arm that clears `SOFT_ACCEPT` outranks any candidate
   found only by the generic arm. Rationale: the phrase is strictly more informative;
   the lexicon exists to *widen*, not to *narrow*.
5. `droppedWord()` then reports far less, because the word did take part in retrieval.

**Measured effect.** On a **random sample of 25 class-A rows** (seed 7), running the real
`searchProduct` on the raw phrase:

- **9 / 25 (36 %)** returned a clearly better product at rank 1–2
  (`rūkytos saldžiosios paprikos`, `rūkytos vištienos`, `vaisinės arbatos`, `kokosų miltų`,
  `Sweet chili sauce`, `DVARO kefyro`, `viso grūdo ruginių miltų`, `kiaulienos karka`,
  `canned whole tomatoes`).
- **15 / 25 (60 %)** returned zero rows → merging changes nothing → **safe by construction**.
- **1 / 25 (4 %)** would be a regression if the phrase arm won unconditionally
  (`imbieras` → ginger-flavoured candy). This is why step 4 requires `SOFT_ACCEPT`
  *and* why L5's edibility gate should ship with it.

Extrapolated to the 156 class-A rows: **≈ 56 rows**, with ~6 at regression risk.
Plus class B2's disguised class-A rows (`„dansukker“ auksaspalvis sirupas` →
`Auksaspalvis sirupas DANSUKKER`, an exact and unique catalog hit): **+~5**.

*This is evidence-backed, from a random sample, not hand-picked.*

**L0 — why this needs the in-memory index first.**

L1 roughly doubles the number of retrieval arms per ingredient. At the measured
**390 ms p50** per `searchProduct`, a 16-ingredient recipe already costs ~6 s and would
go to ~12 s. Unacceptable. So retrieval moves in-process:

> **Measured, on this dev box:** loading `Product` (46 803 rows: id, name, categoryId,
> globalScore) **and** the 55 116 English `StoreProductTranslation` rows takes **266 ms**
> and occupies **3.4 MB of heap**. An AND-of-stems substring scan over that index runs in
> **2.05 ms** (LT) / **1.87 ms** (EN) — versus **390 ms** for the SQL path.
> **A 190× speedup for 3.4 MB of RAM.**

- Build at boot and refresh on a timer (the catalog changes only when a scraper runs;
  15 min is generous) or on an explicit invalidation hook from the import scripts.
- Keep the SQL path as the fallback for a cold index, and keep `productSearchClauses`
  as the single source of truth for *what* a match is — the in-memory scan must implement
  the same five arms, not a second opinion. (This is the `project_ocr_pipeline_unified`
  lesson: divergence between two implementations of one rule is how recovery breaks.)
- Arms 3 and 5 (SP names, canonical receipt aliases) are small enough to hold too
  (56 386 SP names ≈ +4 MB); arm 5 is 14 rows today.

**Where it sits:** module-level singleton in `src/utils/`, warmed at boot, consumed by
`findProductsFor`. **Off the request path entirely.**

**Added latency per import: negative.** Estimated import time drops from ~6 s to
well under 1 s for a 16-ingredient recipe, *while doing twice the retrieval*.

---

### 4.2 L2 — English phrase → `StoreProductTranslation` (cheapest win in the document)

**The change.** In `matchIngredient`, `query = info?.ltName ?? (lang === 'lt' ? ing.name : null)`.
When `lang === 'en'` and `info == null`, that `null` throws the ingredient away.
Instead: **run the raw English phrase through the arm-4 (translation) retrieval.**

The data is already there and already indexed:
**55 116 English machine translations covering 55 096 of 56 386 StoreProducts (97.7 %)**,
`KEY idx_spt_search (lang, normalized)`.

**Measured effect.** On a **random sample of 18 class-B rows** (seed 7), the EN arm
returned the correct product at rank 1–3 for **5** (`dark rum` → Romas PLANTERAY Dark Rum,
`chorizo sliced` → čiorisas ESPANA, `grenadine` → Sirupas MONIN GRENADINE, `tequila` →
Tekila SIERRA, `pepperoncini brine` → paprikos PEPPERONCINI sūryme) and something
plausible-but-needing-ranking for **2** (`pesto`, `croutons`).
**5–7 / 18 = 28–39 % → ≈ 12–17 of the 43 class-B rows.**

**2 / 18 returned junk** (`white miso` → home fragrance) — mitigated by L5's category gate.
**9 / 18 returned nothing**, and several of those are genuine catalog gaps
(`fiddlehead ferns`, `Salata falahiyeh`) or parser residue (`for dipping`, `or biscotti`)
that should be dropped upstream rather than matched.

**Cost:** roughly 20 lines. No schema change. No new query on the hot path once L0 exists.

**Secondary, offline:** widen `ingredientData.ts` from 355 entries using OFF's
`taxonomies/food/ingredients.txt` (2.7 MB, ODbL, verified Lithuanian inflected forms) joined
to Wikidata QIDs for CC0 `lt` labels — a batch script, reviewed by hand, not a runtime
dependency. This is the direct answer to class B's root cause.

---

### 4.3 L3 — `RecipeIngredientAlias`: learn from the swap that is currently discarded

**The teaching event.** `app/recipe-import.tsx:115 swapProduct()` — the shopper opens the
alternatives sheet and picks a different product. Today this is local state.
Make it a `POST`.

Also worth capturing (weaker signal, no extra tap): the *unchanged* confirmations implied
by `handleCreate` — every row that survived into the created template without a swap.

#### DB — `sql/recipe_ingredient_alias.sql` (modelled 1:1 on `receipt_name_vocabulary.sql`)

```sql
CREATE TABLE IF NOT EXISTS RecipeIngredientAlias (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- normalizeProductName() of the recipe's own phrase (nameFull). NOT chain-scoped:
    -- a recipe phrase means the same thing in every shop, unlike a receipt printing.
    normalizedPhrase  VARCHAR(255) NOT NULL,
    lang              CHAR(2) NOT NULL,          -- 'lt' | 'en' — 'sweet' is not 'sweet'
    productId         INT NOT NULL,
    rawSample         VARCHAR(255) NULL,
    occurrences       INT UNSIGNED NOT NULL DEFAULT 1,
    identicalUsers    INT UNSIGNED NOT NULL DEFAULT 0,
    differentUsers    INT UNSIGNED NOT NULL DEFAULT 0,
    status            ENUM('pending','canonical','rejected') NOT NULL DEFAULT 'pending',
    adminVerdict      ENUM('confirmed','rejected') NULL,
    firstSeenAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastSeenAt        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ria (normalizedPhrase, lang, productId),
    -- THE read path: one index-only lookup per ingredient.
    KEY idx_lookup (lang, normalizedPhrase, status),
    KEY idx_curation (status, lastSeenAt),
    CONSTRAINT fk_ria_product FOREIGN KEY (productId) REFERENCES Product(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS RecipeIngredientAliasVote (
    id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
    aliasId   INT UNSIGNED NOT NULL,
    userId    VARCHAR(64) NOT NULL,
    vote      ENUM('identical','different') NOT NULL,
    -- Position of the chosen candidate in the list the user was shown. Joachims 2005:
    -- "clicked > skipped-above" is the reliable signal, and it needs the position.
    -- Logging it from day one is what makes an LTR model possible LATER (§4.6).
    shownRank TINYINT UNSIGNED NULL,
    sourceUrl VARCHAR(512) NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ria_user (aliasId, userId),
    KEY idx_user (userId),
    CONSTRAINT fk_riav_alias FOREIGN KEY (aliasId) REFERENCES RecipeIngredientAlias(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Expected size: bounded by *distinct corrected phrases*, i.e. thousands, not millions.
The whole `canonical` set fits in memory alongside L0's index.

#### How it learns

| question | answer |
|---|---|
| **What event teaches it?** | An explicit swap in the review sheet (`vote='identical'` on the chosen product; **`vote='different'` on the product that was replaced** — the pairwise signal Joachims 2005 says is the reliable one). |
| **How many confirmations before trusted?** | Reuse `deriveAliasStatus` verbatim: **K = 2 distinct users** → `canonical`. A `different` vote rejects only when dissenters **tie or exceed** confirmers (balanced veto). `adminVerdict` overrides. |
| **Per-user or global?** | **Both, in tiers.** 1 confirmation → applies to **that user only** (via the existing `UserProductScore` / affinity path — record a `ProductInteraction` so the shopper's own next import already prefers it, with no new personal table). 2+ distinct users → **global** `canonical`, used as a hard pin for everyone. This is exactly the receipt-vocabulary trust model. |
| **How is a wrong lesson unlearned?** | (a) any user swapping *away* from a canonical pin writes `vote='different'`, and the balanced veto demotes it; (b) `adminVerdict='rejected'` pins it dead; (c) `Product` deletion cascades; (d) a `recomputeAliasAfterVoteRemoval` twin handles account deletion. **Same four routes the receipt vocabulary already has.** |

#### Read path

At the top of `matchIngredient`, before any retrieval:
`canonicalPin(normalizedPhrase, lang)` → if present, that product wins, `confident: true`,
no search at all. Load the whole `canonical` set **once per import** (or hold it in L0's
in-memory index) — **one query, index-only, per import, not per ingredient**.

#### Honest sizing — read this before prioritising L3

**The 267 flagged rows span 246 distinct normalised phrases. Only 18 phrases repeat,
covering 39 rows (15 %).** Within this corpus, a learned alias could remove at most
39 rows even with perfect learning.

Its real value depends on **cross-user, cross-recipe phrase repetition at production
scale, which this corpus cannot measure.** The head of the overall distribution *is*
extremely repetitive (`druska` 33, `cukrus` 26, `kiaušiniai` 21) — but those rows are
already confident. **The flagged set is the tail, and tails are where learned aliases
pay off slowly.**

⚠️ **This is the most speculative claim in the document.** L3 is worth building because it
is cheap (the model, the state machine and the vote UI pattern all already exist) and
because it satisfies the brief's "any residual asking must teach the system permanently" —
**not** because it will move the 13 % number in the next sweep.

---

### 4.4 L4 — Margin-based silent gate (replaces "any dropped word → ask")

Today: *any* uncovered identity word → ask. That fires on class A3 (~16 rows of
`aliejaus kepti`, `medaus bandelėm aptepti`, `single cream to serve`) which are pure
false positives, and it produced the measured 9/27 = 33 % false-ask rate in the holdout.

Replace with **margin sampling** (Settles): ask when the decision is *close*, not when a
word is *missing*.

```
silent  ⟸ top1 clears SOFT_ACCEPT
          AND margin(top1, top2) ≥ τ            // τ ≈ 0.10, tuned on the sweep
          AND top1 was found by the PHRASE arm  // the specific words took part
          AND no edibility/category demerit     // L5
ask     ⟸ otherwise
```

Once L1 ships, "found by the phrase arm" subsumes most of what `droppedWord()` was
protecting against — because the dropped word is no longer dropped. **Keep `droppedWord()`
as a demerit that lowers the margin, not as a hard ask.** Two rules stay hard, because the
judged CRITICALs prove them:

- **`genericAsk` stays a hard ask** (class D, 15 rows). No machine can pick which
  vegetable "daržovių" meant.
- **A process word (`rūkyt`, `šaldyt`, `konservuot`, `džiovint`, …) that survives in
  neither query nor product name stays a hard ask.** That rule is what would have caught
  `bacon` → raw pork belly.

Also fix upstream, in `ingredientParser.ts` (class A3, ~16 rows): strip purpose clauses
(`bandelėm aptepti`, `Sirupo neišpilkite`, `for serving`, `to serve`, `cut into N pieces`).
Those are parse residue, not identity words.

---

### 4.5 L5 — Edibility / category-family gate

Rides along with L1 because L1 widens retrieval and therefore widens the blast radius.

- **A candidate must share a food-category family with the ingredient's expected family.**
  The lexicon key already implies one; `Product.categoryId` supplies the other.
  Kills: `Raudonųjų serbentų` → **vodka**, `vyšnių sultys` → **BBQ wood chips**,
  `prieskonių puokštės` → **a 2026 calendar**, `moliūgai` → **seed packet**,
  `white miso` → **home fragrance**, `imbieras` → **ginger candy**.
- The existing `NOT_FOOD` / `PET_FOOD` / `NON_FOOD_CATEGORY` id-range guards already do
  part of this; extend them with a positive family check rather than more negative regexes.
- Also fix the `romaninių salotų` → `shallot` **lexicon key bug** (judged MAJOR) — one
  bad row in `ingredientData.ts`, and a form-ownership assertion in the index build would
  have caught it.

Estimated: ~15 rows, mostly moving *silent-wrong* → *right*, which matters more than the
flag count.

---

### 4.6 L6 — Embeddings and learning-to-rank: **not now**

`multilingual-e5-small` (384 dims, int8 ONNX **118 MB**, MIT, Lithuanian supported) plus
brute-force cosine over ~77 MB of vectors is technically free and self-hostable
(`onnxruntime-node`). But:

- ⚠️ **MariaDB `VECTOR` is GA only in 11.8 LTS; this server runs 11.4.11.** Native vector
  indexing would require a server upgrade, and Ubuntu 24.04 ships 10.11 — this is an APT
  repo change, not a config flag.
- **MMTEB ([arXiv 2502.13595](https://arxiv.org/pdf/2502.13595)) reports notable quality
  decline and volatility for lower-resource languages.** For Lithuanian, embeddings are a
  recall booster, not a precision oracle.
- **Recall is not the bottleneck.** L1's probe shows lexical retrieval already returns the
  right product at rank 1 for the failing cases. Adding a semantic arm addresses a problem
  that is not the measured one.
- LTR (LightGBM `lambdarank` → ONNX) needs conversion logs. **§4.3's `shownRank` column
  creates them.** Revisit after ~6 months of real swap data.

**Recommendation: do not build. Log the data L6 would need (`shownRank`), and revisit.**

---

### 4.7 API and APP changes

**API**

| endpoint | change |
|---|---|
| `POST /api/recipes/import` | unchanged contract; add `reviewReason` to each item so the app can say *why* (it is already computed and thrown away in `toItem`). |
| **`POST /api/recipes/ingredient-match`** *(new)* | body `{ phrase, lang, productId, replacedProductId?, shownRank?, sourceUrl? }`; `requireUser`; rate-limited. Calls `recordIngredientAliasVote()`. Returns the new alias status. Fire-and-forget from the app. |
| `POST /api/basket-templates` | optionally accept `ingredientPhrase` per item, so template creation also implies a weak confirmation. |

**Services:** new `src/models/recipeIngredientAliasModel.ts` (a near-copy of
`storeProductAliasModel.ts`, minus chain scoping, reusing `deriveAliasStatus`);
new `src/utils/catalogIndex.ts` (L0).

**APP** — deliberately minimal:

- The alternatives sheet **already exists**. `swapProduct` gains one fire-and-forget
  `POST` and passes the index of the tapped alternative as `shownRank`. **The user sees
  no new UI and does no extra work.**
- The pink review dot's copy can become specific (`"Ar tikrai šis?"` vs
  `"Kurių daržovių reikia?"`) using `reviewReason`.
- Optional later: surface *pending* recipe aliases in the existing vocabulary swipe queue,
  which already renders exactly this card shape.

---

### 4.8 SPEED — the numbers

All measured on this dev box against `souply_dev` over LAN.

| path | now | after L0+L1+L2 |
|---|---:|---:|
| one `searchProduct` (5 arms, ≤8 round trips) | **390 ms p50 / 1 235 ms max** | **~2 ms** (in-memory) |
| retrieval arms per ingredient | 1–4 (early-broken) | 2–4 (never broken) |
| **per ingredient** | ~390–800 ms | **~4–8 ms** |
| **per 16-ingredient import** | **~6–12 s** | **< 0.3 s** |
| alias pin lookup | — | 1 index-only query **per import** (or 0, if folded into L0) |
| affinity | 1 cached query per import | unchanged |

Kept off the hot path:

- **Catalog index:** built at boot (266 ms), refreshed on a timer / scraper hook. Never
  built during a request. 3.4 MB heap (+~4 MB if SP names are added).
- **Alias set:** `canonical` rows loaded with the index; a pending alias never influences
  matching (same rule as the receipt vocabulary).
- **Vote write:** fire-and-forget `POST` from the app, outside the import request.
- **Lexicon expansion from OFF/Wikidata:** an offline script, reviewed by hand, committed
  as data. Not a runtime dependency.
- **No nightly job is added.** `refreshUserProductScores()` already exists and is untouched.

**Net: the import gets ~20× faster while doing more work.** The speed budget L0 frees is
what makes L1 possible at all — that is why L0 is ranked first despite removing zero rows
by itself.

---

### 4.9 What to MEASURE (existing harness only)

```bash
npm run recipes:sweep -- --dir receipts/_recipes/pages \
    --json receipts/_recipes/tables/after_L1.jsonl
npm run recipes:diff  -- receipts/_recipes/tables/after_gate.jsonl \
                         receipts/_recipes/tables/after_L1.jsonl
```

`after_gate.jsonl` is the frozen baseline. Gates, per the README's own warning that a
rising match rate with wrong products is the failure this corpus exists to catch:

| metric | baseline | target | how |
|---|---|---|---|
| `confident:false` / matched | **12.77 %** (204/1598) | **< 6 %** | sweep summary |
| unmatched rows | **63** | **< 45** | sweep summary |
| class-A rows (`lexiconKey` set + `dropped_word`/`generic_fallback`) | **156** | **< 100** | script over the JSONL |
| class-B rows (`query == null`) | **43** | **< 30** | script over the JSONL |
| **`recipes:diff` LOSSES** | — | **each one defended in writing** | the diff already splits gains/losses |
| **wrong products (the real metric)** | 6 CRITICAL + 7 MAJOR in 152 judged | **0 CRITICAL** | re-judge the same holdout slices, `verdicts_h05/` format, same rubric |
| import wall-clock, 16 ingredients | ~6–12 s | **< 1 s** | time the sweep |

**The `verdicts_h05` re-judge is non-negotiable.** The flag-count metric can be gamed by
silencing flags; the verdict metric cannot. Ship nothing on the flag count alone.

Suggested order, each with its own sweep + diff so gains and losses stay attributable:
**L0 → L2 → L1 → L5 → L4 → L3.** (L2 before L1 because it is 20 lines and touches only
rows that currently produce *nothing*, so its diff is pure gain and cannot regress.)

---

### 4.10 Risks

| risk | severity | mitigation |
|---|---|---|
| **Removing flags ships silent errors.** All 6 CRITICALs were already silent; flag precision is 67 %. | **high** | The gate metric is the **re-judged verdicts**, not the flag count. `genericAsk` and the process-word rule stay hard asks. L5 ships with L1. |
| **The phrase arm retrieves junk.** Measured 1/25 LT (`imbieras` → candy) and 2/18 EN (`white miso` → home fragrance). | med | Phrase-arm candidates must clear `SOFT_ACCEPT` *and* the L5 category gate before outranking the generic arm. Never let a phrase-arm candidate win *below* the generic arm's score. |
| **In-memory index goes stale** after a scraper run. | med | Timer refresh + explicit invalidation from the import scripts; SQL fallback on a cold index. Cheap: a full rebuild is 266 ms. |
| **Two implementations of "what is a match" diverge** (in-memory vs `productSearchClauses`). | **high** | The in-memory scan must be *generated from* the same stem/fold helpers, with a test asserting identical results on a fixture set. This repo has been burned by exactly this (`project_ocr_pipeline_unified`). |
| **L3 never reaches K=2** because the flagged set is a 246-phrase tail. | **high** | Accept it. L3 is justified by the brief's "teach permanently" requirement, not by corpus rows. Seed it offline for the top ~200 ingredients (Rimi/Northfork both do exactly this) and let admin `adminVerdict` promote without waiting for two users. |
| **A canonical pin freezes a product that is later delisted.** | med | `ON DELETE CASCADE` on `productId`; a nightly sanity check that pinned products are still live can reuse the existing discount-refresh job. |
| **Alias poisoning** by one user. | low | Already solved: K=2 distinct users, balanced veto, `adminVerdict` override. Per-user tier is per-user only. |
| **ODbL share-alike** if OFF taxonomy data is imported. | low | Internal use is fine; only redistribution of a derived database triggers it. Prefer Wikidata (CC0) labels where they suffice. |
| **`imbieras`-class regressions** where the generic pick was already right. | med | The `recipes:diff` losses list is the gate. Do not ship a diff whose losses are not individually defended. |

---

## 5. Confidence, and what I could not verify

**Confidence: HIGH** for L0, L1, L2 and the cause taxonomy.
Every load-bearing claim is measured on this machine, against this data:

- the class counts come from a script over `after_gate.jsonl`;
- the "the product is in the catalog" claim comes from direct `souply_dev` queries;
- the "the phrase arm finds it" claim comes from running the **real `searchProduct`**;
- the L1/L2 hit rates come from **random samples (seed 7)**, not hand-picked rows;
- the latency and memory numbers come from profiling the actual queries and building
  the actual index.

**Confidence: MEDIUM** for L4 (τ ≈ 0.10 is a starting point, not a measured value) and
L5 (the category-family mapping does not exist yet and its precision is unknown).

**Confidence: LOW** for L3's *impact*, though not for its *design*: with 246 distinct
phrases over 267 flagged rows, its payoff depends on production-scale repetition I cannot
measure from a 180-recipe corpus.

### Not verified

1. **Whether the correct product sits deeper in `alternatives`.** The sweep JSONL records
   only `altName` (top-1) and `altCount`. On that evidence the runner-up beats the pick in
   only 11/204 flagged rows, which is why I concluded retrieval — not ranking — is the
   bottleneck. A sweep that dumped all four alternatives would confirm or refute this
   directly, and it is the first thing I would check before implementing.
2. **The A1–A7 sub-class counts in §1.3** are my reading of all 133 distinct
   `dropped_word` rows, not a script. They are approximate (±3 per row) and the boundaries
   between A1/A5/A6 are genuinely fuzzy.
3. **Production latency.** All numbers are dev-over-LAN. The Oracle VM behind Cloudflare
   Tunnel will differ; the *ratio* (in-memory vs SQL) should hold, the absolutes will not.
4. **`multilingual-e5-small` inference latency** (~15–30 ms/short string) is the research
   agent's inference from an `all-MiniLM-L6-v2` benchmark, not a measurement. Irrelevant
   unless L6 is revisited.
5. **Cross-user phrase repetition at production scale** — the key unknown for L3.
6. **Whether `Category` has a usable food-family tree** for L5. The id-range guards in
   `recipeMatcher.ts` suggest the tree is workable but irregular; I did not audit it.
7. Chicory's and Northfork's internal methods are known only from press, patents and
   marketing pages — no engineering blog exists for either. Their *architecture shape* is
   well attested; their accuracy claims (Northfork's "98 %") are vendor-reported.
