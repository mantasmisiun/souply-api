import { getClosestStores } from '../models/storeModel.js';
import { getBasketProductIds } from '../models/basketModel.js';
import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';

const VILNIUS_LAT = 54.6872;
const VILNIUS_LNG = 25.2797;
const NEPRISKIRTA_CATEGORY_ID = MatchThresholds.nepriskirtaCategoryId;

type MatchMode = 'sku' | 'base';

interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    chainId: number;
    chainLogoUrl: string | null;
    storeAddress: string;
    distance: number;
    total: number;
    isApproximated: boolean;
    missingItemNames: string[];
    items: ItemResult[];
}

interface ItemResult {
    productId: number;
    productName: string;
    quantity: number;
    matchMode: MatchMode;
    storeProductName: string | null;
    storeProductAmount: number | null;
    storeProductUnit: string | null;
    packsNeeded: number | null;
    actualAmount: number | null;
    price: number | null;
    promoPrice: number | null;
    effectivePrice: number | null;
    totalPrice: number | null;
    isWeighable: boolean;
    isMissing: boolean;
    isFallback: boolean;
    isSubstituted: boolean;
    /** When matchMode='base' or isSubstituted, this is the specific Product
     *  id whose StoreProduct was priced at this store. For sku-mode exact
     *  matches this equals the basket item's productId. */
    resolvedProductId: number | null;
    /** Same shape for the SP id — useful if the frontend wants to link to
     *  the actual variant the calc chose. */
    storeProductId: number | null;
    /** True when we fell back to cross-chain average pricing (tier-4).
     *  Distinct from isSubstituted (tier-3, name-similar in chain). */
    isCrossChainAverage: boolean;
}

export interface CalculateOptions {
    /** User-supplied coordinates. When omitted, falls back to Vilnius
     *  city centre so the calc never crashes for callers that haven't
     *  been migrated to pass location yet. */
    lat?: number;
    lng?: number;
}

// ---------------------------------------------------------------------------
// Tier-1/2 price cache — pre-fetched once before the store × item loop
// ---------------------------------------------------------------------------

interface Tier12Cache {
    /** Map<storeId, Map<spProductId, SpRow[]>> — for sku-mode lookups */
    sku: Map<number, Map<number, SpRow[]>>;
    /** Map<storeId, Map<baseProductId, SpRow[]>> — extra entries for
     *  base-mode lookups: cluster members whose Product.baseProductId
     *  equals the basket item's productId. */
    cluster: Map<number, Map<number, SpRow[]>>;
}

function addToNestedMap<K1, K2, V>(
    map: Map<K1, Map<K2, V[]>>,
    k1: K1,
    k2: K2,
    v: V,
): void {
    if (!map.has(k1)) map.set(k1, new Map());
    const inner = map.get(k1)!;
    if (!inner.has(k2)) inner.set(k2, []);
    inner.get(k2)!.push(v);
}

/**
 * Pre-fetch the latest price for every (storeId, storeProductId) combination
 * that matches the basket items and the queried store chains — one query
 * instead of one per (store, item) pair.
 *
 * Uses ROW_NUMBER() to pick the latest Price row per (storeProductId, storeId)
 * without a correlated subquery.
 */
/**
 * Fetch the latest Price for each (storeProductId, storeId) pair.
 * Uses MAX(id) grouping — scans only Price rows for the specific SPs and
 * stores we care about, not all rows.
 * Returns: spId → storeId → { price, promoPrice, isFallback }.
 */
async function fetchLatestPrices(
    spIds: number[],
    storeIds: number[],
): Promise<Map<number, Map<number, { price: any; promoPrice: any; isFallback: any }>>> {
    const result = new Map<number, Map<number, any>>();
    if (!spIds.length || !storeIds.length) return result;
    const [rows]: any = await pool.query(
        `SELECT p.storeProductId, p.storeId, p.price,
                CASE WHEN p.promoEnd > NOW() THEN p.promoPrice ELSE NULL END AS promoPrice,
                p.isFallback
         FROM Price p
         INNER JOIN (
             SELECT storeProductId, storeId, MAX(id) AS maxId
             FROM Price
             WHERE storeProductId IN (?) AND storeId IN (?)
             GROUP BY storeProductId, storeId
         ) latest ON latest.maxId = p.id`,
        [spIds, storeIds],
    );
    for (const row of rows as any[]) {
        const spId = Number(row.storeProductId);
        const storeId = Number(row.storeId);
        if (!result.has(spId)) result.set(spId, new Map());
        result.get(spId)!.set(storeId, row);
    }
    return result;
}

const batchFetchTier12Prices = async (
    storeIds: number[],
    chainIds: number[],
    productIds: number[],
): Promise<Tier12Cache> => {
    const cache: Tier12Cache = { sku: new Map(), cluster: new Map() };
    if (!storeIds.length || !productIds.length) return cache;

    // Step 1: find relevant StoreProducts (tiny result for small baskets)
    const [spRows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName,
                sp.isWeighable, sp.amount, sp.unit,
                prod.baseProductId
         FROM StoreProduct sp
         JOIN Product prod ON prod.id = sp.productId
         WHERE sp.chainId IN (?)
           AND prod.mergedIntoId IS NULL
           AND (prod.id IN (?) OR prod.baseProductId IN (?))`,
        [chainIds, productIds, productIds],
    );
    if (!spRows.length) return cache;

    // Step 2: fetch latest prices only for those SPs at those stores
    const spIds = (spRows as any[]).map(r => Number(r.id));
    const priceMap = await fetchLatestPrices(spIds, storeIds);

    for (const sp of spRows as any[]) {
        const spId = Number(sp.id);
        const spProductId = Number(sp.productId);
        const baseProductId = sp.baseProductId !== null ? Number(sp.baseProductId) : null;
        const storePrices = priceMap.get(spId);
        if (!storePrices) continue;

        for (const [storeId, pd] of storePrices.entries()) {
            const spRow: SpRow = {
                id: spId,
                productId: spProductId,
                storeProductName: sp.storeProductName,
                isWeighable: sp.isWeighable,
                amount: sp.amount,
                unit: sp.unit,
                price: pd.price,
                promoPrice: pd.promoPrice,
                isFallback: pd.isFallback,
            };
            addToNestedMap(cache.sku, storeId, spProductId, spRow);
            if (baseProductId !== null && baseProductId !== spProductId) {
                addToNestedMap(cache.cluster, storeId, baseProductId, spRow);
            }
        }
    }

    return cache;
};

/** Sync tier-1/2 resolution from the pre-fetched cache. */
function getCheapestFromCache(
    cache: Tier12Cache,
    storeId: number,
    productId: number,
    matchMode: MatchMode,
): (SpRow & { effectivePrice: number }) | null {
    const direct = cache.sku.get(storeId)?.get(productId) ?? [];
    const cluster = matchMode === 'base'
        ? (cache.cluster.get(storeId)?.get(productId) ?? [])
        : [];
    return pickCheapest([...direct, ...cluster]);
}

/**
 * Compare a basket's per-store total across the 10 closest stores to
 * (lat, lng). For each basket item, resolution tiers:
 *
 *   Tier 1  (sku mode)  : the user's specific Product's SPs at this chain.
 *   Tier 2  (base mode) : all cluster members' SPs at this chain.
 *   Tier 3  (both)      : if Tier 1/2 yields nothing, look for the
 *                         name-nearest SP in this chain (Levenshtein on
 *                         normalized names, ≥ substitutionMinSimilarity,
 *                         excluding Nepriskirta). Flag isSubstituted.
 *   Tier 4  (both)      : still nothing → cross-chain average of this
 *                         Product's prices elsewhere (the historic
 *                         "approximate" behaviour). Flag
 *                         isCrossChainAverage.
 *   Missing             : even Tier 4 has no data → isMissing=true,
 *                         contributes 0 to total, surfaces in
 *                         missingItemNames.
 *
 * Sort order: (missing count asc, total asc). Full-coverage stores beat
 * partial-coverage stores regardless of nominal total.
 */
export const calculateBasketForStores = async (
    basketId: number,
    opts: CalculateOptions = {}
): Promise<StoreResult[]> => {
    const lat = Number.isFinite(opts.lat) ? (opts.lat as number) : VILNIUS_LAT;
    const lng = Number.isFinite(opts.lng) ? (opts.lng as number) : VILNIUS_LNG;

    const stores = await getClosestStores(lat, lng, 10);
    const basketItems = await getBasketProductIds(basketId);

    if (!basketItems.length) return [];

    // Drop stores with no coordinates (distance would be null).
    const validStores = (stores as any[]).filter(s => s.distance != null);

    const storeIds  = validStores.map((s: any) => Number(s.id));
    const chainIds  = [...new Set(validStores.map((s: any) => Number(s.chainId)))] as number[];
    const productIds = [...new Set(basketItems.map((i: any) => Number(i.productId)))] as number[];

    // Tier 1/2: single batch query — sync lookup inside the loop.
    const tier12Cache = await batchFetchTier12Prices(storeIds, chainIds, productIds);

    // Tier 3: one query per (chainId × productId) instead of per (storeId × productId).
    // Results keyed as "chainId:productId" → best-substitute SpRow per store.
    const tier3Cache = await batchFetchTier3Substitutes(productIds, basketItems, storeIds, chainIds);

    // Tier 4: one cross-chain average query per productId, not per (store × productId).
    const tier4Cache = new Map<number, (SpRow & { effectivePrice: number }) | null>();
    await Promise.all(
        productIds.map(async pid => {
            tier4Cache.set(pid, await approximateCrossChain(pid, storeIds));
        })
    );

    const storeResults = await Promise.all(
        validStores.map(async (store: any): Promise<StoreResult> => {
            const itemResults = await Promise.all(
                basketItems.map((basketItem: any) =>
                    resolveItemAtStore(
                        Number(basketItem.productId),
                        parseFloat(basketItem.quantity),
                        String(basketItem.name),
                        basketItem.matchMode === 'base' ? 'base' : 'sku',
                        Number(store.id),
                        Number(store.chainId),
                        tier12Cache,
                        tier3Cache,
                        tier4Cache,
                    )
                )
            );

            const missingItemNames = itemResults
                .filter(r => r.isMissing)
                .map(r => r.productName);
            const total = itemResults.reduce(
                (s, r) => s + (r.isMissing ? 0 : r.totalPrice ?? 0),
                0
            );
            const isApproximated = itemResults.some(
                r => r.isSubstituted || r.isCrossChainAverage
            );

            return {
                storeId: store.id,
                storeName: store.name,
                chainName: store.chainName,
                chainId: store.chainId,
                chainLogoUrl: store.logoUrl || null,
                storeAddress: store.address,
                distance: parseFloat(store.distance.toFixed(2)),
                total: Math.round(total * 100) / 100,
                isApproximated,
                missingItemNames,
                items: itemResults,
            };
        })
    );

    return storeResults.sort((a, b) => {
        // 1. Fewer missing items first (item not found anywhere)
        if (a.missingItemNames.length !== b.missingItemNames.length)
            return a.missingItemNames.length - b.missingItemNames.length;
        // 2. Fewer cross-chain average items first (tier-4: item not at this chain at all)
        const aCCA = a.items.filter(i => i.isCrossChainAverage).length;
        const bCCA = b.items.filter(i => i.isCrossChainAverage).length;
        if (aCCA !== bCCA) return aCCA - bCCA;
        // 3. Fewer substituted items first (tier-3: found a similar item, not the exact one)
        const aSub = a.items.filter(i => i.isSubstituted).length;
        const bSub = b.items.filter(i => i.isSubstituted).length;
        if (aSub !== bSub) return aSub - bSub;
        // 4. Cheaper total
        return a.total - b.total;
    });
};

/**
 * Tiered resolution for a single basket item at a specific store. Returns
 * the best-effort ItemResult — never throws for "no data"; the missing/
 * substitution/average flags communicate quality.
 *
 * Tier 3 and 4 results are pre-computed before the store loop and passed
 * in as caches — no DB calls happen here.
 */
async function resolveItemAtStore(
    productId: number,
    userQuantity: number,
    productName: string,
    matchMode: MatchMode,
    storeId: number,
    chainId: number,
    tier12Cache: Tier12Cache,
    tier3Cache: Map<string, (SpRow & { effectivePrice: number }) | null>,
    tier4Cache: Map<number, (SpRow & { effectivePrice: number }) | null>,
): Promise<ItemResult> {
    // Tier 1 / 2: served from the pre-fetched cache — no DB call.
    const direct = getCheapestFromCache(tier12Cache, storeId, productId, matchMode);
    if (direct) {
        return priceItem(productId, userQuantity, productName, matchMode, direct,
            { isSubstituted: false, isCrossChainAverage: false });
    }

    // Tier 3: pre-computed best substitute for this (chain, product) pair.
    const substitute = tier3Cache.get(`${chainId}:${productId}`) ?? null;
    if (substitute) {
        return priceItem(productId, userQuantity, productName, matchMode, substitute,
            { isSubstituted: true, isCrossChainAverage: false });
    }

    // Tier 4: pre-computed cross-chain average — no DB call.
    const synthetic = tier4Cache.get(productId) ?? null;
    if (synthetic) {
        const priced = priceItem(productId, userQuantity, productName, matchMode, synthetic,
            { isSubstituted: false, isCrossChainAverage: true });
        return { ...priced, storeProductName: null, storeProductId: null, resolvedProductId: null };
    }

    return missingAtStore(productId, productName, userQuantity, matchMode);
}

export interface SpRow {
    id: number;
    productId: number;
    storeProductName: string;
    isWeighable: number | boolean;
    amount: string | number | null;
    unit: string | null;
    price: string | null;
    promoPrice: string | null;
    isFallback: number | boolean;
}

/**
 * Pre-fetch tier-3 substitutes for all (chainId × productId) pairs in one
 * pass. Returns a Map keyed "chainId:productId" → best substitute SpRow
 * (cheapest effective price among name-similar SPs in that chain, priced
 * at any of the nearby stores). One query per chain instead of one per
 * (store × product).
 */
async function batchFetchTier3Substitutes(
    productIds: number[],
    basketItems: any[],
    storeIds: number[],
    chainIds: number[],
): Promise<Map<string, (SpRow & { effectivePrice: number }) | null>> {
    const result = new Map<string, (SpRow & { effectivePrice: number }) | null>();
    if (!productIds.length || !chainIds.length || !storeIds.length) return result;

    await Promise.all(chainIds.map(async chainId => {
        await Promise.all(basketItems.map(async (bi: any) => {
            const productId = Number(bi.productId);
            const productName = String(bi.name);
            const key = `${chainId}:${productId}`;
            const normalized = normalizeName(productName);
            if (!normalized) { result.set(key, null); return; }
            const firstToken = normalized.split(' ')[0];
            if (firstToken.length < 3) { result.set(key, null); return; }

            // Step 1: find candidate SPs by name — no price join yet
            const [candidateRows]: any = await pool.query(
                `SELECT sp.id, sp.productId, sp.storeProductName, sp.isWeighable, sp.amount, sp.unit,
                        prod.name AS productName
                   FROM StoreProduct sp
                   JOIN Product prod ON prod.id = sp.productId
                  WHERE sp.chainId = ?
                    AND prod.mergedIntoId IS NULL
                    AND prod.categoryId <> ?
                    AND prod.id <> ?
                    AND (LOWER(prod.name) LIKE ? OR LOWER(sp.storeProductName) LIKE ?)
                  LIMIT 200`,
                [chainId, NEPRISKIRTA_CATEGORY_ID, productId,
                    `%${firstToken}%`, `%${firstToken}%`],
            );
            if (!candidateRows.length) { result.set(key, null); return; }

            // Score candidates — only keep the best above the threshold
            let bestCandidate: (typeof candidateRows[number] & { score: number }) | null = null;
            for (const sp of candidateRows as any[]) {
                const score = levenshteinRatio(normalized, normalizeName(sp.productName));
                if (score < MatchThresholds.substitutionMinSimilarity) continue;
                if (!bestCandidate || score > bestCandidate.score) bestCandidate = { ...sp, score };
            }
            if (!bestCandidate) { result.set(key, null); return; }

            // Step 2: price the winning candidate at any nearby store
            const candidateSpIds = [Number(bestCandidate.id)];
            const priceMap = await fetchLatestPrices(candidateSpIds, storeIds);
            const storePrices = priceMap.get(Number(bestCandidate.id));
            if (!storePrices?.size) { result.set(key, null); return; }

            // Pick the cheapest price across the nearby stores
            let bestPrice: any = null;
            for (const pd of storePrices.values()) {
                if (pd.price == null) continue;
                const eff = pd.promoPrice ? parseFloat(pd.promoPrice) : parseFloat(pd.price);
                const bestEff = bestPrice
                    ? (bestPrice.promoPrice ? parseFloat(bestPrice.promoPrice) : parseFloat(bestPrice.price))
                    : Infinity;
                if (eff < bestEff) bestPrice = pd;
            }
            if (!bestPrice) { result.set(key, null); return; }

            result.set(key, {
                ...bestCandidate,
                price: bestPrice.price,
                promoPrice: bestPrice.promoPrice,
                isFallback: bestPrice.isFallback,
                effectivePrice: bestPrice.promoPrice
                    ? parseFloat(bestPrice.promoPrice)
                    : parseFloat(bestPrice.price),
            });
        }));
    }));

    return result;
}

/**
 * Find the most similar StoreProduct (by name) in the given chain whose
 * similarity passes the configured substitution threshold. Excludes
 * Nepriskirta-bound Products so garbage-bin items don't get picked.
 *
 * Implementation: pull all SPs in the chain that share at least one
 * meaningful name token with the target (cheap LIKE prefilter), then
 * score with normalized Levenshtein ratio. For small baskets at thesis
 * scale this is fast enough; if it ever becomes hot, precompute a
 * trigram inverted index like the import scripts use.
 */
async function fetchNearestNameSubstitute(
    productId: number,
    productName: string,
    storeId: number,
    chainId: number
): Promise<(SpRow & { effectivePrice: number }) | null> {
    const normalized = normalizeName(productName);
    if (!normalized) return null;

    // LIKE prefilter on the first "word" keeps the candidate pool
    // reasonable without forcing a chain-wide sort. If the chain genuinely
    // has no SP sharing this prefix, tier-3 skips to tier-4 cleanly.
    const firstToken = normalized.split(' ')[0];
    if (firstToken.length < 3) return null;

    // Pull the CANDIDATE'S Product.name alongside the SP fields so we
    // compare name-to-name at the canonical Product level, not at the
    // StoreProduct level. StoreProduct names are noisy ("Pienas Dvaras
    // 2.5% 1L plastikinėje pakuotėje") while Product.name is clean
    // ("Pienas Dvaras 2.5%"), which is what the user's basket row stores
    // and what they visually match against. Levenshtein on clean names
    // produces sensible 0.80+ hits; noisy-name comparisons never clear
    // the bar.
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.isWeighable, sp.amount, sp.unit,
                p.price, p.promoPrice, p.isFallback,
                prod.name AS productName
           FROM StoreProduct sp
           JOIN Product prod ON prod.id = sp.productId
           LEFT JOIN (
               SELECT storeProductId, price, promoPrice, isFallback
               FROM (
                   SELECT storeProductId, price, promoPrice, isFallback,
                          ROW_NUMBER() OVER (PARTITION BY storeProductId ORDER BY id DESC) AS rn
                   FROM Price WHERE storeId = ?
               ) sub WHERE sub.rn = 1
           ) p ON p.storeProductId = sp.id
          WHERE sp.chainId = ?
            AND prod.mergedIntoId IS NULL
            AND prod.categoryId <> ?
            AND prod.id <> ?
            AND (LOWER(prod.name) LIKE ? OR LOWER(sp.storeProductName) LIKE ?)
          LIMIT 200`,
        [storeId, chainId, NEPRISKIRTA_CATEGORY_ID, productId, `%${firstToken}%`, `%${firstToken}%`]
    );
    const priced = (rows as (SpRow & { productName: string })[]).filter(r => r.price !== null);
    if (!priced.length) return null;

    // Dedup by candidate Product id — a Product with many SPs would
    // otherwise re-enter the loop per SP, and the first-seen priced SP
    // for that Product already wins on cheapest-per-unit below. Keep
    // the row with the cheapest per-unit price.
    const bestPerProduct = new Map<number, typeof priced[number]>();
    for (const sp of priced) {
        const current = bestPerProduct.get(sp.productId);
        if (!current) {
            bestPerProduct.set(sp.productId, sp);
            continue;
        }
        const currEff = current.promoPrice
            ? parseFloat(String(current.promoPrice))
            : parseFloat(String(current.price));
        const newEff = sp.promoPrice
            ? parseFloat(String(sp.promoPrice))
            : parseFloat(String(sp.price));
        const currUnit = currEff / Math.max(parseFloat(String(current.amount ?? 1)), 1);
        const newUnit = newEff / Math.max(parseFloat(String(sp.amount ?? 1)), 1);
        if (newUnit < currUnit) bestPerProduct.set(sp.productId, sp);
    }

    let best: (SpRow & { productName: string; score: number }) | null = null;
    for (const sp of bestPerProduct.values()) {
        // Compare the user's Product.name against the candidate's
        // Product.name. Both are canonical, relatively short, and not
        // polluted by pack-size phrasing — this is where 0.80+ is
        // meaningful.
        const score = levenshteinRatio(normalized, normalizeName(sp.productName));
        if (score < MatchThresholds.substitutionMinSimilarity) continue;
        if (!best || score > best.score) best = { ...sp, score };
    }
    if (!best) return null;
    // Reuse the cheapest-selection helper so effectivePrice/promoPrice
    // handling is consistent with the tier-1/2 paths.
    return pickCheapest([best as any]);
}

/**
 * Cross-chain average fallback. Aggregates the Product's latest prices
 * from every SP at the user's 10 nearest stores, regardless of chain,
 * and returns a synthetic SpRow with averaged effectivePrice + a
 * representative (amount, unit, isWeighable) signature. The caller
 * runs this through priceItem() so pack-vs-weighable math stays
 * consistent with Tiers 1-3.
 *
 * Pack size handling: if SPs across stores have different pack sizes
 * (rare — e.g. 80g at Maxima vs 100g at Rimi), the rows are bucketed
 * by (amount, unit, isWeighable) and the largest bucket wins. This
 * avoids the prior bug where averaging mixed pack sizes via per-kg
 * collapsed back into nonsense when multiplied by a pack count.
 */
async function approximateCrossChain(
    productId: number,
    nearbyStoreIds: number[],
): Promise<(SpRow & { effectivePrice: number }) | null> {
    if (!nearbyStoreIds.length) return null;

    // Step 1: find all SPs for this product (small result)
    const [spRows]: any = await pool.query(
        `SELECT id, amount, unit, isWeighable FROM StoreProduct WHERE productId = ?`,
        [productId],
    );
    if (!spRows.length) return null;
    const spIds = (spRows as any[]).map(r => Number(r.id));

    // Step 2: fetch latest prices for those SPs at nearby stores
    const priceMap = await fetchLatestPrices(spIds, nearbyStoreIds);

    // Flatten into rows
    const rows: any[] = [];
    for (const sp of spRows as any[]) {
        const storePrices = priceMap.get(Number(sp.id));
        if (!storePrices) continue;
        for (const [storeId, pd] of storePrices.entries()) {
            if (pd.price == null) continue;
            rows.push({
                amount: sp.amount,
                unit: sp.unit,
                isWeighable: sp.isWeighable,
                // Use the regular price for cross-chain estimation: a promo at
                // one chain doesn't imply the same discount at a chain that
                // doesn't even stock this product.
                effectivePrice: parseFloat(pd.price),
                storeId,
            });
        }
    }
    if (!rows.length) return null;

    interface Bucket {
        amount: number;
        unit: string | null;
        isWeighable: boolean;
        // storeId → cheapest per-pack effective price seen at that store
        prices: Map<number, number>;
    }
    const buckets = new Map<string, Bucket>();
    for (const row of rows as any[]) {
        const amount = row.amount ? parseFloat(row.amount) : 1;
        const unit = row.unit ?? null;
        const isWeighable = !!row.isWeighable;
        const key = `${amount}|${unit ?? ''}|${isWeighable ? 1 : 0}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { amount, unit, isWeighable, prices: new Map() };
            buckets.set(key, bucket);
        }
        const eff = parseFloat(row.effectivePrice);
        const current = bucket.prices.get(row.storeId);
        if (current === undefined || eff < current) bucket.prices.set(row.storeId, eff);
    }

    // Largest bucket wins (most common pack size across nearby stores).
    let chosen: Bucket | null = null;
    for (const b of buckets.values()) {
        if (!chosen || b.prices.size > chosen.prices.size) chosen = b;
    }
    if (!chosen || chosen.prices.size === 0) return null;

    let total = 0;
    for (const v of chosen.prices.values()) total += v;
    const avgEffective = total / chosen.prices.size;

    return {
        id: 0,
        productId,
        storeProductName: '',
        isWeighable: chosen.isWeighable,
        amount: chosen.amount,
        unit: chosen.unit,
        price: String(avgEffective),
        promoPrice: null,
        isFallback: false,
        effectivePrice: avgEffective,
    };
}

export function pickCheapest(rows: SpRow[]): (SpRow & { effectivePrice: number }) | null {
    const priced = rows.filter(r => r.price !== null);
    if (!priced.length) return null;
    let best: (SpRow & { effectivePrice: number }) | null = null;
    let bestPricePerUnit = Infinity;
    for (const sp of priced) {
        const effectivePrice = sp.promoPrice
            ? parseFloat(String(sp.promoPrice))
            : parseFloat(String(sp.price));
        const amount = sp.amount ? parseFloat(String(sp.amount)) : 1;
        const pricePerUnit = effectivePrice / amount;
        if (pricePerUnit < bestPricePerUnit) {
            bestPricePerUnit = pricePerUnit;
            best = { ...sp, effectivePrice };
        }
    }
    return best;
}

export function priceItem(
    productId: number,
    userQuantity: number,
    productName: string,
    matchMode: MatchMode,
    chosen: SpRow & { effectivePrice: number },
    flags: { isSubstituted: boolean; isCrossChainAverage: boolean }
): ItemResult {
    const effectivePrice = chosen.effectivePrice;
    const spAmount = chosen.amount ? parseFloat(String(chosen.amount)) : 1;
    const spUnit = chosen.unit;
    const isWeighable = chosen.isWeighable === 1 || chosen.isWeighable === true;

    let packsNeeded: number;
    let actualAmount: number;
    let totalPrice: number;
    if (isWeighable) {
        // Weighable: userQuantity is a weight typed by the user.
        // Normalize to match the SP's unit. If user said "2" for an SP
        // priced per gram, they meant 2 kg = 2000 g; if they said "1500"
        // for an SP in kg, they meant 1500 g = 1.5 kg.
        let normalizedQuantity = userQuantity;
        if (spUnit === 'g' && userQuantity < 10) normalizedQuantity = userQuantity * 1000;
        else if (spUnit === 'kg' && userQuantity > 10) normalizedQuantity = userQuantity / 1000;

        packsNeeded = 1;
        actualAmount = normalizedQuantity;
        totalPrice = normalizedQuantity * (effectivePrice / Math.max(spAmount, 1));
    } else {
        // Non-weighable: userQuantity is a pack count from the basket UI's
        // +/- buttons, NOT a weight. Charge for each pack at the shelf
        // price; round any fractional input up to the next whole pack
        // (you can't buy half an ice cream).
        packsNeeded = Math.ceil(userQuantity);
        actualAmount = packsNeeded * spAmount;
        totalPrice = packsNeeded * effectivePrice;
    }
    totalPrice = Math.round(totalPrice * 100) / 100;

    return {
        productId,
        productName,
        quantity: userQuantity,
        matchMode,
        storeProductName: chosen.storeProductName,
        storeProductAmount: spAmount,
        storeProductUnit: spUnit,
        packsNeeded,
        actualAmount,
        price: parseFloat(String(chosen.price)),
        promoPrice: chosen.promoPrice ? parseFloat(String(chosen.promoPrice)) : null,
        effectivePrice,
        totalPrice,
        isWeighable,
        isMissing: false,
        isFallback: chosen.isFallback === 1 || chosen.isFallback === true,
        isSubstituted: flags.isSubstituted,
        resolvedProductId: Number(chosen.productId),
        storeProductId: Number(chosen.id),
        isCrossChainAverage: flags.isCrossChainAverage,
    };
}

function missingAtStore(
    productId: number,
    productName: string,
    userQuantity: number,
    matchMode: MatchMode
): ItemResult {
    return {
        productId,
        productName,
        quantity: userQuantity,
        matchMode,
        storeProductName: null,
        storeProductAmount: null,
        storeProductUnit: null,
        packsNeeded: null,
        actualAmount: null,
        price: null,
        promoPrice: null,
        effectivePrice: null,
        totalPrice: null,
        isWeighable: false,
        isMissing: true,
        isFallback: false,
        isSubstituted: false,
        resolvedProductId: null,
        storeProductId: null,
        isCrossChainAverage: false,
    };
}

// ── normalization + Levenshtein (duplicated from import scripts for
//    self-containment; the calc service runs on every basket calculation
//    and we keep its helpers local to avoid cross-module coupling to
//    script internals) ────────────────────────────────────────────────

function normalizeName(s: string): string {
    if (!s) return '';
    return s
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function levenshteinRatio(a: string, b: string): number {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    if (la === 0 || lb === 0) return 0;
    const dp: number[] = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) dp[j] = j;
    for (let i = 1; i <= la; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= lb; j++) {
            const temp = dp[j];
            dp[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
                ? prev
                : 1 + Math.min(prev, dp[j - 1], dp[j]);
            prev = temp;
        }
    }
    return 1 - dp[lb] / Math.max(la, lb);
}
