# MEASURED — the prerequisite check and fixes 1–4

**Status:** measurement only. No production code changed. Every script was a throwaway
run against an isolated copy of `src/` under `/tmp` (symlinked `node_modules`), so the
repo tree is untouched.
**Date:** 2026-07-27. **DB:** `souply_dev` @ 192.168.1.212:3307 (49 503 `Product` rows,
46 803 with `mergedIntoId IS NULL`; 55 116 `StoreProductTranslation` rows at `lang='en'`).
**Instrument:** the real `matchIngredient` / `findProducts` / `findProductsFor` /
`searchProduct` / `findBestProductMatches`, patched only to *record* what they saw.

---

## 0. The denominator

| set | rows |
|---|---:|
| `tables/after_gate.jsonl`, `confident: false` | 267 |
| `tables/after_gate.jsonl`, `productId: null` | 63 |
| **union of the two** (every no-product row is also `confident:false`) | **267** |
| MAJOR/CRITICAL rows in `verdicts_h05/slice_{1,2}.jsonl` | **13** |
| **TOTAL POPULATION USED THROUGHOUT** | **280** |

The 13 verdict rows are **not** a subset of the 267. `verdicts_h05` judges
`tables/holdout05.jsonl`, which was swept from `pages_h05/` — a different page set with
**zero** `(url, raw, name)` overlap with `after_gate`. So they add 13 rows, not zero.

Comparison sets used for regression measurement:

* **`confident200`** — a seeded random sample (seed 7) of the 1 394 rows that are
  `confident: true` with a product today. This is the "87 % that already works".
* **`sample60`** — a seeded random sample (seed 7) of the 267, judged by hand.

**Reproduction fidelity:** re-running `matchIngredient` on all 267 `after_gate` rows
reproduced the recorded `productId` and `confident` **267/267 exactly**, and on
`confident200` **200/200 exactly**. The harness is faithful.

**But 4 of the 13 verdict rows no longer reproduce** — see §5.

---

## 1. THE PREREQUISITE CHECK — retrieval or ranking?

### 1.1 What was dumped

For every one of the 280 rows I recorded, per retrieval arm:

* `armLists` — the query list `findProducts` *proposed* (`[ltName, …aliases, recipeArm(nameFull), recipeArm(name)]`);
* which of those arms actually **executed** (the early break skips the rest);
* `retrieved` — every row `searchProduct` returned (≤ 50/arm);
* `ranked` — the `RANKING_POOL = 12` survivors of `findBestProductMatches`, with confidence;
* `kept` — the ≤ 4 that `rankPicks(...).slice(0, 4)` returned, i.e. the pick + the three
  alternatives the review screen shows.

### 1.2 Mechanical result — the 12 judged rows with a stated expected product

The judges wrote the correct product id into `expected`. That is a free, unbiased oracle.
(`tešlos` is excluded: the judges' expected value is "nothing".)

| the correct product was… | rows | % |
|---|---:|---:|
| in the **kept top-4** (already on screen as an alternative) | **1** | 8 % |
| in the **ranked 12-pool** but dropped before the top-4 | **3** | 25 % |
| **retrieved** by SQL but scored out of the 12-pool | **7** | 58 % |
| **never retrieved** by any executed arm | **5** | 42 % |

(The rows are cumulative: "ranked" ⊂ "retrieved".)

Where the retrieved-but-unranked ones sat in the SQL result (`ORDER BY globalScore DESC`,
`LIMIT 50`, then `CANDIDATE_CAP = 40`):

```
kepalo čiabatos      id 1269  retrieved pos  6/19   never ranked
kiaulienos nugarinės id 1673  retrieved pos  5/41   never ranked
žalumynų             id 21331 retrieved pos 23/29   never ranked
bacon / bacon lardons id 2287 retrieved pos 12/16   ranked at #4, not kept
cream cheese         id  837  retrieved pos  3/50   ranked at #1, KEPT — and still not picked
pasta sauce          id 3091  retrieved pos  0/50   never ranked
```

`cream cheese` is the headline: the judges' expected product was **retrieved first,
ranked first, and kept** — and the matcher bought a different cream cheese anyway.
That is not a retrieval failure by any reading.

### 1.3 Judged result — the 60-row random sample

I read every row's full pool and judged whether a plainly better product exists and where
it lives.

| bucket | rows | % of 60 |
|---|---:|---:|
| **no better product exists** — right answer already, catalog gap, or a category-only ask (`uogų`, `prieskoniai`, `sėklų`, `Vištiena`) | 24 | 40 % |
| a **non-food** won and nothing better exists (`prieskonių puokštės` → a 2026 calendar; `dr oetker … marinavimui` → a meat injector) | 2 | 3 % |
| **a plainly better product exists** | **34** | **57 %** |

Of those 34 fixable rows:

| where the better product already was | rows | % of fixable |
|---|---:|---:|
| already in the **kept top-4** — pure ranking/acceptance | 7 | 21 % |
| in the **ranked 12-pool**, dropped before the top-4 | 7 | 21 % |
| **retrieved**, scored out of the pool | 5 | 15 % |
| **never retrieved** | 15 | 44 % |

### 1.4 The answer, plainly

Combining both evidence sets (46 fixable rows with a known better product):

> **43 % retrieval, 57 % ranking/scoring.**
> The right product never arrives for 20 of 46. For the other 26 it arrives and loses —
> and for **8 of 46 it is already sitting in the top-4 that the shopper is shown.**

The proposal's §0 claim — *"the specific product the recipe wanted is then unreachable"* —
**does not survive**. Four of its seven Lithuanian headline examples are already reachable
today, and three of them are already in the kept list:

| headline example | proposal says | measured today (`after_gate` state) |
|---|---|---|
| `kiaulienos karka` | phrase never searched | phrase arm **ran**; `Kiaulienos karka` **1.00**, ranked #2, **kept as alternative #1** — mince still won |
| `pusriebės varškės` | phrase never searched | phrase arm **ran**; `Pusriebė varškė IKI 9 %` **0.95**, **kept** — PRESIDENT 4 % still won |
| `Pekino kopūstai` | phrase never searched | phrase arm **ran**; `Pjaustytas pekino kopūstas FIT & EASY` **0.93**, **kept** — white cabbage still won |
| `rauginti agurkai` | phrase never searched | phrase arm **ran** and returned only marinated cucumbers |
| `kokosų miltų`, `kajeno paprikos`, `rūkytos saldžiosios paprikos` | phrase never searched | **correct** — the early break skipped the phrase arm |

### 1.5 The early break, sized exactly

| | rows |
|---|---:|
| population | 280 |
| rows where `findProducts` proposed **more than one** arm | 116 |
| — of which **at least one extra arm ran** | 38 |
| — of which **every extra arm was skipped** by `if (leader && leader.confidence >= AUTO_ACCEPT) break;` | **78 (67 %)** |
| rows where **no arm was built at all** (`query === null`, `ignored`, `notSold`) | 47 |

So the early break really does suppress the phrase arm on 78 of 280 failing rows.
§2.3 measures what happens when you stop it.

---

## 2. MEASURE 1 — phrase-first retrieval with today's `searchProduct`

`searchProduct(nameFull, 'lt', { includeUncategorised: true })` → `findBestProductMatches`
with the same constants `findProductsFor` uses (`CANDIDATE_CAP 40`, `RANKING_POOL 12`,
threshold `MIN_ACCEPT − 0.12`). Judged by hand against the catalog.

### 2.1 On the 280 failing rows

| outcome | rows | % |
|---|---:|---:|
| phrase returns **nothing** → merging changes nothing, **safe** | 174 | 62 % |
| phrase's top-1 is **the product already picked** → no change | 13 | 5 % |
| phrase's top-3 contains a **plainly better** product | **61** | **22 %** |
| a wash — both the old pick and the phrase result are wrong | 9 | 3 % |
| phrase's top-3 is **worse** than what is picked today | **23** | **8 %** |

Of the 61 better ones, **8** are only reachable below `SOFT_ACCEPT` (`rūkytos saldžiosios
paprikos` 0.52, `golden caster sugar` 0.55 ×4, `sweet chilli sauce` 0.58 ×2, `Raudoni
maisto dažai` 0.52), so a `SOFT_ACCEPT`-gated preference realises **53 of 280 (19 %)**.

Real wins in that 53 include `Cukrus DANSUKKER FARINAS` (1.00), `Rauginti agurkai` (1.00),
`Romaninės salotos` (0.98), `Pomidorų tyrė GIANA`, `Šaldyti žalieji žirneliai`,
`Kajeno paprikos SANTA MARIA`, `Vištienos prieskoniai SALDVA` (currently a whole chicken),
`Sardinės alyvuogių aliejuje` (currently olives), `Šaldytos vyšnios GARDU` (currently
**BBQ wood chips**), `Apvalūs ryžiai`, `Sušių ryžiai AJI`, `Penkių pipirų mišinys`.

The 23 worse ones are the reason this cannot ship unguarded: `aguonų sėklų` →
a **seed packet**; `tešlos` → a **dough scraper**; `cream cheese` → **PRINGLES crisps**;
`bacon` → **frozen pizza**; `passion fruit` → **liqueur**; `šaldytų aviečių` →
frozen pastries; `jautienos` → cured ham instead of fresh mince.

### 2.2 Blast radius on the 87 % that already works — the number that matters most

200 currently-`confident` rows, same method. "Would change the pick" = the phrase arm's
top-1 differs from the current product **and** clears `SOFT_ACCEPT` (the proposal's L1
step 4).

| | rows | % of 200 |
|---|---:|---:|
| phrase returns nothing → no effect | 76 | 38 % |
| phrase top-1 == the product already picked | 42 | 21 % |
| phrase top-1 differs but below `SOFT_ACCEPT` | 1 | 0.5 % |
| **phrase top-1 differs AND clears `SOFT_ACCEPT` → the pick changes** | **81** | **40.5 %** |

Judging those 81: **3 better, 13 neutral, 65 worse.** The worse ones are exactly the traps
the code comments in `matchIngredient` already document:

```
cukrus   → Vanilinis cukrus            sviesto → Prancūziškas batonas su česnakinio sviesto įdaru
druskos  → Druskos dribsniai ICA       eggs    → Guminukai VIDAL FRIED EGGS
sage     → Plaukų sagė (a HAIR CLIP)   agurkų  → Agurkų TRĄŠOS (fertiliser)
salmon   → cat treats                  vanilla → Degtinė HLIBNY DAR VANILLA
milk     → Sviestas FARM MILK          garlic  → Padažas BBQ ROASTED GARLIC
medaus   → Medaus pyragas              sugar   → Gaz. gėr. NO SUGAR
```

Extrapolated to 1 394 confident rows: **≈ 450 regressions**, against ≈ 53 fixes.
**Unconditional phrase preference is catastrophic and must not be built.**

### 2.3 …but the existing `recipeArm()` guard absorbs almost all of it

`recipeArm()` already suppresses the phrase arm when the phrase adds no content word over
`ltName` — that guard is what stops `sviesto`/`druskos`. Of the 81 swaps above, **72 are
rows where `recipeArm()` never opens a phrase arm at all**. With the guard kept:

| guarded phrase preference, 200 confident rows | rows |
|---|---:|
| picks changed | **9 (4.5 %)** |
| — better (`Sausos mielės` → `Sausos MOČIUTĖS mielės` ×2, `migdolų drožlių` → `Migdolų drožlės ALVO`) | 3 |
| — worse (`salmon` → **cat treats**, `Citrinos žievelė` → biscuits, `Vištienos kiaušinis` → instant noodles, `Augalinis aliejus` → sardines, `žalių žirnelių` → pasta, `Vištienos šlaunelių mėsa` → a marinated grill product) | **6** |

Projected to 1 394 rows: **≈ 21 gains vs ≈ 42 regressions**, and the regressions convert
*silently-right* into *silently-wrong*. 4 of the 6 are category errors an edibility/family
gate would kill.

### 2.4 Removing the early break, measured directly (not estimated)

I patched the isolated copy to skip `if (leader && leader.confidence >= AUTO_ACCEPT) break;`
and re-ran both sets. **Ranking untouched.**

| | 200 confident rows | 280 failing rows |
|---|---:|---:|
| SQL arms run, before → after | 209 → 229 (+9.6 %) | 311 → 394 (+27 %) |
| **picks changed** | **0** | **2** |
| `confident` flag changed | 0 | 1 |
| kept top-4 gained a new candidate | — | 14 |

The only genuine fix: `dansukker cukrus farinas` → `Cukrus DANSUKKER FARINAS`,
`dropped_word` → confident. (`Rūkyta kalakutiena` changed product but not for the better.)

> **Widening retrieval is free — and by itself almost worthless.** The extra candidates
> land in the pool and the ranking, still judged against `queries[0]`, ignores them.
> The lever is entirely in `rankPicks` / `acceptable`, not in `findProducts`.

---

## 3. MEASURE 2 — the English translation arm

### 3.1 A load-bearing correction to the proposal

> §4.2: *"`StoreProductTranslation` … is simply never consulted."*

**False.** `searchProduct` runs it as arm 4 on **every** call where the earlier arms
return < 50 rows (`productModel.ts:152-159`, `productSearchMatch.ts:81`). Every LT and EN
recipe query already reaches it.

The real gap is one line: `matchIngredient:427` —
`const query = info?.ltName ?? (lang === 'lt' ? ing.name : null)`. When `lang === 'en'`
and there is no lexicon entry, `query` is `null` and **no search of any kind runs**.
That is **43 rows**, not "the translation table is unused".

### 3.2 The isolated translation arm, 101 EN failing rows

Querying `StoreProductTranslation` alone (`lang='en'`, AND-of-`stemQuery` stems on
`spt.normalized`), then hydrating through `Product`:

| | rows |
|---|---:|
| EN failing rows | 101 |
| — with `query === null` (currently produce **nothing at all**) | **43** |
| translation arm returns ≥ 1 product, all EN rows | 43 |
| translation arm returns ≥ 1 product, **`query === null` rows** | **20 / 43** |

Judging those 20:

| | rows | examples |
|---|---:|---|
| **correct at rank 1–3** | **13** | `tamari` → KIKKOMAN TAMARI · `pesto` → Klasikinis pesto SACLA · `chorizo` → čiorisas ESPANA · `Marsala` → likerinis vynas MARSALA · `golden syrup` → **Auksaspalvis sirupas DANSUKKER** · `citric acid` → Citrinų rūgštis RIMI · `tequila` → Tekila · `pepperoncini brine` → paprikos PEPPERONCINI sūryme · `dark rum` → Romas HAVANA CLUB · `grenadine` → Sirupas MONIN GRENADINE · `dry gin` → Džinas (rank 2) · `caramel sauce` → karamelinis padažas · `spicy pepperoni slice` → saliamis PEPPERONI |
| plausible but wrong at the top | 3 | `croissants` → 7DAYS raguolis · `croutons` → soup *with* croutons · `Crackers` → lentil crisps |
| **wrong / junk** | **4** | `gin` → **majonezas HELLMANN'S** · `white miso` → **a face mask** · `white rum` → **PVA glue** at rank 2 · `passion fruit` → liqueurs (while `Pasifloros` exists and is never reached) |
| nothing returned | 23 | |

### 3.3 The 23 misses are NOT a coverage gap

Direct probes of `StoreProductTranslation` prove the English strings exist:

```
rhubarb      → Rabarbarai, Rabarbarų vynas VORUTA, …   (28 products)
gnocchi      → Bulvių virtinukai RANA GNOCCHI, …       (14 products)
pretzels     → Breceliai MIO & RIO, Sūrūs riestainiai, … (33 products)
tarragon     → NAMINIAI virtiniai su peletrūnu, …
crab / elderflower / crackers → all present
scallion     → genuinely absent (0 rows)
```

They fail because `stemQuery` AND-composes **every** stem and the parser leaves prep words
in the phrase: `['finel','chopped','scallion']`, `['crushed','ritz','cracker']`,
`['container','frozen','whipped','topping']`, `['imitation','crab','meat']`. One
un-stripped adjective zeroes the arm. **This is a parser fix, not a data fix**, and it is
the cheapest unclaimed win in the whole document.

### 3.4 Via the realistic path (full `searchProduct` on the phrase)

For the 43 `query === null` rows, the shippable version — just stop short-circuiting on
`query === null` and search the phrase — yields:

| | rows |
|---|---:|
| a ranked candidate is produced | **9** |
| — of which correct within top-3 | **8** (tamari, pesto, Marsala, Crackers, tequila, dark rum, white rum, grenadine) |
| — wrong (`passion fruit` → liqueur) | 1 |
| still nothing | 34 |

The gap between **8** here and **13** from the isolated arm is `findBestProductMatches`
scoring the EN phrase against Lithuanian product names and discarding good translation
hits. A dedicated EN arm that ranks against the *translation* string, plus prep-word
stripping, is worth **≈ 13–16** of the 43; the naïve version is worth **8**.

---

## 4. MEASURE 3 — the in-memory catalog index (speed only)

Loaded `Product(id, name, categoryId, globalScore)` where `mergedIntoId IS NULL` plus all
`lang='en'` `StoreProductTranslation` rows joined to `productId`. Heap measured with
`--expose-gc`, double GC, and the raw SQL result arrays **out of scope** (leaving them in
scope inflates the number to 25 MB). Scan = fold + AND-of-`stemQuery`-stems `indexOf`,
384 real arm queries taken from the dump.

| metric | proposal | **measured** | verdict |
|---|---:|---:|---|
| products indexed | 46 803 | 46 803 | ✔ |
| EN translations indexed | 55 116 | 55 116 | ✔ |
| load time | 266 ms | **312 ms** (261 SQL + 50 build) | ✔ close |
| **heap** | **3.4 MB** | **19.0 MB** | ✘ **understated 5.6×** |
| per-query scan, LT | 2.05 ms | **2.78 ms p50** / 3.93 p90 / 4.67 max | ✔ close |
| `searchProduct` p50 | 390 ms | **328 ms** (n = 280); 327 ms (n = 200) | ✔ close |
| `searchProduct` max | 1 235 ms | **1 375 ms** | ✔ close |
| speed-up | 190× | **≈ 118×** | ✔ same order |

**Real 16-ingredient import, wall-clock** — 8 corpus recipes of 14–18 ingredients,
124 ingredients, one shared `QueryCache` per recipe, exactly as `matchIngredient` is called:

| | measured |
|---|---:|
| median per recipe | **3 956 ms** |
| range | 2 983 – 5 140 ms |
| SQL arms actually run | 119 |
| arms proposed (i.e. with the early break removed) | 163 (**+37 %**) |

So the proposal's "~6–12 s" is **too pessimistic** — it is ~4 s. With the early break
removed it goes to ≈ 5.4 s. On the in-memory index, 163 arms × 2.78 ms ≈ **0.45 s** of
retrieval, so **< 1 s** per import, *not* the claimed "< 0.3 s".

**The claim survives directionally. Two numbers in it do not: heap is 19 MB, not 3.4 MB,
and the current import is 4 s, not 6–12 s.**

> Caveat: 19 MB is one node process. `refreshDiscountedSummary` and the scrapers already
> live in the same heap; 19 MB is fine on the Oracle VM but it is not "free", and a second
> index for `StoreProduct.storeProductName` (56 386 rows, arm 3) would roughly double it.

---

## 5. MEASURE 4 — purpose-clause stripping in the parser

Trailing purpose/instruction clauses, counted exactly over all 1 661 `after_gate` rows
(`kepimui`, `papuošimui`, `patiekimui`, `aptepti`, `pabarstyti`, `kepti`,
`Sirupo neišpilkite`, `cut into …`, `for serving`, `to serve`, `for sprinkling`,
`plus more …`, `and softened`):

| | rows |
|---|---:|
| rows carrying a strippable purpose tail | **22** |
| — currently flagged / unmatched | **12** |
| — currently confident | 10 |
| plus rows that are *nothing but* a purpose clause and should be dropped upstream (`Jei norisi`, `for dipping`, `for sprinkling`) | 3 |
| **attributable to purpose clauses, flagged** | **15** |

The proposal's "~16 rows" **survives as a count.** What does not survive is the payoff.
Re-running `matchIngredient` on the stripped lines:

| outcome | rows | detail |
|---|---:|---|
| **flag cleared, same product** — pure gain | **4** | `cukraus miltelių 5 kartus daugiau`, `sviesto bandelėm aptepti`, `medaus bandelėm aptepti`, `aliejaus kepti` |
| **product fixed and flag cleared** | **1** | `konservuotų mangų Sirupo neišpilkite`: `Džiovinti mangai SEEBERGER` → **`Konservuoti mangai ST MAMET`** |
| **flag lost without improvement** — a *regression in kind* | **1** | `saulėgrąžų ir moliūgų sėklų mišinio pabarstyti`: salted pumpkin seeds → **cheese-flavoured sunflower seeds**, and now silent |
| unaffected | 16 | the flag is driven by a different uncovered word (`plakinio`, `konservuotų`, `skinless`, `single`, `full-fat`, `toasted/seared`) |
| **currently-confident rows changed** | **0** | zero regression risk on the working set |

> **The claim "~16 rows come from trailing purpose clauses" is true. The implied
> "stripping fixes them" is not — measured, it fixes 5 and silently breaks 1.**

---

## 6. THE TABLE

| # | change | rows it fixes (of 280) | rows it risks breaking | confidence | what I could not test |
|---|---|---:|---|---|---|
| **1a** | Always run the phrase arm (delete the early break). Ranking untouched. | **2** measured | **0 / 200** confident rows changed. +27 % SQL arms (+9.6 % on confident rows) | **measured**, full population, both directions | nothing — this one is fully measured |
| **1b** | Prefer a phrase-arm candidate that clears `SOFT_ACCEPT`, **keeping `recipeArm()`** | **≤ 53** (61 better, minus 8 unreachable below `SOFT_ACCEPT`) | **9 / 200** confident picks change: 3 better, **6 worse** → **≈ 42 projected regressions** | fixes = judged on all 280; regressions = judged on a 200-row sample of 1 394 (± ~3.5 pp) | I did not implement `viaQuery`-scoped acceptance (L1 step 3); I approximated it with `searchProduct(phrase)` rankings. Real behaviour may differ where the two arms' candidates merge |
| **1c** | Prefer the phrase arm **without** `recipeArm()` ("run both unconditionally") | ≤ 53 | **81 / 200 = 40 %** of confident picks change, **65 worse** → **≈ 450 projected regressions** | **measured** | — |
| **2** | Stop the `query === null` short-circuit for EN and search the phrase | **8** via plain `searchProduct`; **≈ 13–16** with a dedicated EN arm + prep-word stripping | 1 measured wrong hit (`passion fruit` → liqueur); 4 junk hits if the isolated arm is used raw (`gin` → mayonnaise, `white rum` → **PVA glue**, `white miso` → face mask) | **measured** on all 43 `query===null` rows; the 13–16 upside is measured on the isolated arm, not on a shipped implementation | how `findBestProductMatches` would score a translation-sourced candidate if ranked against the EN string rather than the LT name |
| **3** | In-memory catalog index | **0** by itself | 0 correctness risk; **19 MB heap**, 312 ms boot, staleness after a scraper run | **measured** (heap, load, p50/p90/max, and a real import wall-clock) | production latency on the Oracle VM behind Cloudflare Tunnel; whether an in-memory scan reproduces `productSearchClauses` exactly (I implemented a *simplified* scan — arms 1+4 only, no `buildFuzzyNameClause` semantics) |
| **4** | Strip purpose clauses in `ingredientParser` | **5** (4 flags cleared + 1 product fixed) | **1** flag lost without improvement; **0 / 10** confident purpose-tail rows changed | **measured** — exact count over all 1 661 rows, re-run end to end | whether a looser regex catches more; mine is deliberately tail-anchored |

---

## 7. Recommendation

**Build, in this order:**

1. **Fix #4 — purpose-clause stripping.** Smallest, safest, zero measured regression on the
   working set. 5 rows. Ship the 3 "pure residue" lines (`Jei norisi`, `for dipping`,
   `for sprinkling`) as *drops*, not strips. Guard the one regression by keeping
   `dropped_word` when what remains is still uncovered.
2. **Fix #2 — the EN `query === null` short-circuit.** 8 rows for ~20 lines with today's
   `searchProduct`. Do it together with **EN prep-word stripping** (`finely`, `chopped`,
   `crushed`, `container`, `imitation`, `refrigerated`, `frozen`, `dried`), which is what
   turns 8 into ≈ 13–16 and which is measured, not guessed. **Do not** use the isolated
   translation arm without a category gate — it returns PVA glue for `white rum`.
3. **Fix #3 — the in-memory index**, *only if* you commit to #1b afterwards. It buys nothing
   on its own; it exists to make #1b affordable. 19 MB, not 3.4. Budget accordingly.
4. **Fix #1a + #1b, together, and only behind an edibility/category gate.** 1a alone is
   free and worthless; 1b alone is what fixes ~53 rows and breaks ~42. Four of the six
   measured regressions (cat treats, biscuits, instant noodles, sardines) are category
   errors. **The category gate is not "a correctness fix that should ride along" — it is
   the precondition that makes #1b net-positive at all.** Without it, do not ship #1b.

**Not worth building: #1c, and #1a on its own.**

* **#1c (phrase arm unconditional, `recipeArm()` removed or bypassed) is the single most
  dangerous idea in the proposal.** Measured: it changes 40 % of currently-correct picks
  and 65 of 81 changes are worse — sugar → vanilla sugar, salt → salt flakes, butter →
  a garlic-butter baguette, sage → a hair clip, cucumber → cucumber fertiliser, salmon →
  cat treats. The `recipeArm()` guard already documents every one of these in its comment
  block. Removing it re-buys a trap that was already paid for.
* **#1a on its own returns 2 rows for +27 % SQL arms.** It is only worth its cost as the
  enabler for #1b.

---

## 8. Proposal claims that did NOT survive measurement

1. **"The specific product is unreachable; retrieval is the bottleneck."** Measured
   **43 % retrieval / 57 % ranking**. For 8 of 46 fixable rows the correct product is
   already in the kept top-4 that the shopper is shown.
2. **`kiaulienos karka` — the document's opening example.** The phrase arm already runs,
   already finds `Kiaulienos karka` at **1.00**, and it is already kept as the first
   alternative. The mince wins on ranking. Same for `pusriebės varškės` and
   `Pekino kopūstai`.
3. **"The runner-up beats the pick in only 11/204 rows, which rules out re-rank as a
   sufficient fix."** The sweep only ever recorded `altName` (top-1 alternative). With all
   four alternatives dumped, ranking is the *majority* mechanism.
4. **"`StoreProductTranslation` … is simply never consulted."** It is arm 4 of
   `searchProduct` and runs on essentially every recipe query. The gap is the
   `query === null` short-circuit, worth 43 rows, not the whole 55 116-row table.
5. **"L2 … its diff is pure gain and cannot regress."** Measured: `passion fruit` →
   a liqueur, and the isolated arm returns PVA glue, a face mask and mayonnaise. It can
   regress.
6. **In-memory index heap "3.4 MB".** Measured **19.0 MB** with the SQL rows out of scope
   (25 MB if they are not). Off by 5.6×.
7. **"Import wall-clock ~6–12 s → < 0.3 s".** Measured **4.0 s median** today, and ≈ 0.45 s
   of in-memory retrieval → **< 1 s**, not < 0.3 s.
8. **"~16 rows from purpose clauses" → implied 16 fixes.** The count is right (15–22
   depending on strictness). The fixes are **5**, plus **1** silent regression.
9. **The CRITICAL list is stale.** `verdicts_h05` judged `holdout05.jsonl`, swept at 12:20;
   `after_gate` is the 13:22 matcher. Re-running the 13 MAJOR/CRITICAL rows today,
   **4 no longer reproduce**, all of them improvements:

   | row | judged as | today |
   |---|---|---|
   | `bacon` | raw chilled pork belly | **`Rūkyta kiaulienos šoninė, a.r.`** (smoked) |
   | `bacon lardons` | raw chilled pork belly | **`Rūkyta kiaulienos šoninė, a.r.`** |
   | `pasta sauce` | **dry tagliatelle** | **`Pomidorų padažas BE KONSERVANTŲ KKF`** |
   | `cream cheese` | `RAMBYNO tepamasis sūrelis` | `Tepamasis sūris WELL DONE` (a real cream cheese; still not Philadelphia, which is ranked #1 and kept) |

   Any sizing that leans on "6 CRITICALs" is leaning on a superseded run. Re-judge before
   using that number as a gate.

---

## 9. What I could not measure at all

* **Fix L3 (`RecipeIngredientAlias`)** — untouched. There is no swap data, and the corpus
  cannot produce cross-user repetition. The proposal's own LOW-confidence rating stands.
* **Fix L5 (category/edibility gate)** — I counted the rows it would need to catch
  (2 of 60 in the sample are pure non-food wins; 4 of the 6 measured #1b regressions are
  category errors) but I did not build or measure a family mapping, and I did not audit
  whether `Category` has a usable food tree.
* **L1 step 3 (`viaQuery`-scoped acceptance)** — not implemented. Everything in §2 about
  fixes is `searchProduct(phrase)` as a proxy for it.
* **The in-memory scan's fidelity to `productSearchClauses`.** My scan implements arms 1
  and 4 with plain `indexOf`, not `buildFuzzyNameClause`. The proposal's own
  `project_ocr_pipeline_unified` warning applies and I did not test it.
* **Production latency.** All numbers are dev-over-LAN. The ratio should hold; the
  absolutes will not.
* **Judgement quality.** "Better / worse" is my reading of *product names only* — no
  images, no prices, no shelf verification. The 60-row sample gives ±~6 pp; the 200-row
  confident sample ±~3.5 pp at 95 %.

---

## 10. How to reproduce

Scripts lived in an isolated copy under
`/tmp/claude-1000/.../scratchpad/measure/src/scripts/` (`mDump.ts`, `mPhrase.ts`,
`mTrans.ts`, `mIndex2.ts`, `mImport.ts`) with `node_modules` symlinked to the repo and the
only source edits being (a) three `__DBG` recording hooks in `recipeMatcher.ts` and
(b) `if (!process.env.NO_EARLY_BREAK && leader && …) break;`. The repo tree was never
modified. Regenerate by re-applying those two patches to a throwaway copy of `src/`.
