import { getClosestStores, getStoresByIdsWithDistance } from '../models/storeModel.js';
import { getBasketProductIds, getBasketOwnerId } from '../models/basketModel.js';
import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import { toCanonicalAmount, type CanonicalMeta } from './canonicalUnit.js';
import {
    fetchAllSpMetadata,
    computeCanonicalByProduct,
    type SpMetaRow,
} from './productCanonical.js';
import { findBestProductMatches, type MatchCandidate } from '../utils/productMatcher.js';
import { getCachedChainCandidates } from '../models/storeProductModel.js';
import { stemQuery } from '../utils/searchStem.js';
import { fetchLinkedSets } from '../models/linkedProductModel.js';

const VILNIUS_LAT = 54.6872;
const VILNIUS_LNG = 25.2797;
const NEPRISKIRTA_CATEGORY_ID = MatchThresholds.nepriskirtaCategoryId;
// Size of the nearest-store reference pool used to build the tier-3/tier-4
// fallback caches when only specific stores are priced (e.g. a map-tap via
// /store-prices). Mirrors getClosestStores(…, 10) used by the full list calc.
const APPROX_POOL_SIZE = 12;
// Confidence floor for an auto-applied Tier-3 substitute (the advanced typed
// matcher's 0..1 scale — NOT the old Levenshtein ratio). Conservative: a
// substitute enters a price total unreviewed, so it must be a solid name match.
// Tunable.
const TIER3_MIN_CONFIDENCE = 0.65;

type MatchMode = 'sku' | 'base';

export interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    chainId: number;
    chainLogoUrl: string | null;
    chainMiniLogoUrl: string | null;
    storeAddress: string;
    latitude: number | null;
    longitude: number | null;
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
    /** Owner/viewer of the basket (User.id — a UUID string). Enables the PERSONAL
     *  merge tier (Tier-2a): products this user voted 'same' price directly, ahead
     *  of global merges/clusters. Absent → personal tier skipped (global only). */
    userId?: string;
    /** When provided, calculate only for these specific stores (candidate pool
     *  from client-side location filtering). Falls back to 10-closest when
     *  absent, preserving the existing single-store flow. */
    storeIds?: number[];
    /** When provided, skip the `Basket` table read and price these items
     *  directly. Used by the šablonai share-snapshot pipeline so a virtual
     *  template can be priced without first persisting a temp basket. */
    items?: Array<{
        productId: number;
        quantity: number;
        matchMode?: 'sku' | 'base';
        name?: string;
        /** The creator's intended variant (from the template item's anchor
         *  snapshot). When present, resolution prefers in-cluster SPs whose
         *  pack size matches before falling back to the whole cluster. */
        anchorAmount?: number | null;
        anchorUnit?: string | null;
    }>;
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
    /** Map<storeId, Map<basketProductId, SpRow[]>> — SPs of products the
     *  VIEWER personally voted 'same' as the basket item. Strong evidence
     *  (the user's own merge). Keyed by the basket item's productId. */
    personal: Map<number, Map<number, SpRow[]>>;
    /** Map<storeId, Map<basketProductId, SpRow[]>> — SPs of products
     *  hard-merged into the same effective Product (Product.mergedIntoId,
     *  community Wilson-promoted). Strong evidence. Keyed by basket productId. */
    merge: Map<number, Map<number, SpRow[]>>;
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

const emptyLinked = () => ({ personal: new Map<number, Set<number>>(), merge: new Map<number, Set<number>>() });

const batchFetchTier12Prices = async (
    storeIds: number[],
    chainIds: number[],
    productIds: number[],
    linked: { personal: Map<number, Set<number>>; merge: Map<number, Set<number>> } = emptyLinked(),
): Promise<Tier12Cache> => {
    const cache: Tier12Cache = { sku: new Map(), cluster: new Map(), personal: new Map(), merge: new Map() };
    if (!storeIds.length || !productIds.length) return cache;

    const buildSpRow = (sp: any, spId: number, spProductId: number, pd: any): SpRow => ({
        id: spId,
        productId: spProductId,
        storeProductName: sp.storeProductName,
        isWeighable: sp.isWeighable,
        amount: sp.amount,
        unit: sp.unit,
        price: pd.price,
        promoPrice: pd.promoPrice,
        isFallback: pd.isFallback,
    });

    // Step 1: exact (sku) + cluster (baseProductId) SPs — live products only.
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
    if (spRows.length) {
        const spIds = (spRows as any[]).map(r => Number(r.id));
        const priceMap = await fetchLatestPrices(spIds, storeIds);
        for (const sp of spRows as any[]) {
            const spId = Number(sp.id);
            const spProductId = Number(sp.productId);
            const baseProductId = sp.baseProductId !== null ? Number(sp.baseProductId) : null;
            const storePrices = priceMap.get(spId);
            if (!storePrices) continue;
            for (const [storeId, pd] of storePrices.entries()) {
                const spRow = buildSpRow(sp, spId, spProductId, pd);
                addToNestedMap(cache.sku, storeId, spProductId, spRow);
                if (baseProductId !== null && baseProductId !== spProductId) {
                    addToNestedMap(cache.cluster, storeId, baseProductId, spRow);
                }
            }
        }
    }

    // Step 2: linked-set SPs (personal + merge tiers). Invert item → linkedPid
    // into linkedPid → owning basket items, then fetch those SPs by productId.
    // NO mergedIntoId filter here — merge losers are exactly what we want, and
    // the fetch is already scoped to the explicit linked ids.
    const personalOwners = new Map<number, number[]>();
    const mergeOwners = new Map<number, number[]>();
    const invert = (byItem: Map<number, Set<number>>, owners: Map<number, number[]>) => {
        for (const [basketPid, set] of byItem) {
            for (const linkedPid of set) {
                const arr = owners.get(linkedPid) ?? [];
                arr.push(basketPid);
                owners.set(linkedPid, arr);
            }
        }
    };
    invert(linked.personal, personalOwners);
    invert(linked.merge, mergeOwners);
    const linkedPids = [...new Set([...personalOwners.keys(), ...mergeOwners.keys()])];
    if (linkedPids.length) {
        const [lRows]: any = await pool.query(
            `SELECT sp.id, sp.productId, sp.storeProductName, sp.isWeighable, sp.amount, sp.unit
             FROM StoreProduct sp
             WHERE sp.chainId IN (?) AND sp.productId IN (?)`,
            [chainIds, linkedPids],
        );
        if (lRows.length) {
            const lIds = (lRows as any[]).map(r => Number(r.id));
            const lPriceMap = await fetchLatestPrices(lIds, storeIds);
            for (const sp of lRows as any[]) {
                const spId = Number(sp.id);
                const spProductId = Number(sp.productId);
                const storePrices = lPriceMap.get(spId);
                if (!storePrices) continue;
                for (const [storeId, pd] of storePrices.entries()) {
                    const spRow = buildSpRow(sp, spId, spProductId, pd);
                    for (const basketPid of personalOwners.get(spProductId) ?? []) {
                        addToNestedMap(cache.personal, storeId, basketPid, spRow);
                    }
                    for (const basketPid of mergeOwners.get(spProductId) ?? []) {
                        addToNestedMap(cache.merge, storeId, basketPid, spRow);
                    }
                }
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
    userQuantity: number,
    canonical: CanonicalMeta | null,
    anchor: { amount: number; unit: string } | null = null,
): (SpRow & { effectivePrice: number }) | null {
    // "Definitely the product" — the item's own SKU plus the PERSONAL (viewer
    // voted 'same') and MERGE (hard-merged) tiers. All are the same product with
    // strong evidence, so they're unioned and priced by cheapest. Applies in both
    // match modes (a personal/global merge is the product regardless of sku/base).
    const direct = cache.sku.get(storeId)?.get(productId) ?? [];
    const personal = cache.personal.get(storeId)?.get(productId) ?? [];
    const merge = cache.merge.get(storeId)?.get(productId) ?? [];
    // Weaker "same base" name-similarity grouping — base mode only, as before.
    const cluster = matchMode === 'base'
        ? (cache.cluster.get(storeId)?.get(productId) ?? [])
        : [];
    return pickCheapestForQuantity(
        [...direct, ...personal, ...merge, ...cluster], userQuantity, canonical, anchor,
    );
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

    const stores = opts.storeIds?.length
        ? await getStoresByIdsWithDistance(opts.storeIds, lat, lng)
        : await getClosestStores(lat, lng, 10);
    // Allow callers (e.g. template share-snapshot) to bypass the
    // Basket-table read and price a virtual item list directly.
    const basketItems = opts.items
        ? opts.items.map(it => ({
              productId: Number(it.productId),
              quantity: Number(it.quantity),
              matchMode: it.matchMode ?? 'sku',
              name: it.name ?? '',
              anchorAmount: it.anchorAmount ?? null,
              anchorUnit: it.anchorUnit ?? null,
          }))
        : await getBasketProductIds(basketId);

    if (!basketItems.length) return [];

    // Owner of the basket → enables the PERSONAL merge tier. Explicit opts.userId
    // wins (virtual-item callers pass the viewer); otherwise read the basket owner.
    const userId = opts.userId ?? (opts.items ? undefined : (await getBasketOwnerId(basketId)) ?? undefined);

    // Drop stores with no coordinates (distance would be null).
    const validStores = (stores as any[]).filter(s => s.distance != null);

    const storeIds  = validStores.map((s: any) => Number(s.id));
    const chainIds  = [...new Set(validStores.map((s: any) => Number(s.chainId)))] as number[];
    const productIds = [...new Set(basketItems.map((i: any) => Number(i.productId)))] as number[];

    // Personal ('same' vote) + merge (hard-merged) product links per basket item.
    // Needed BOTH to widen each item's canonical unit family below AND to feed the
    // Tier-2 evidence ladder in the price cache further down.
    const linkedSets = await fetchLinkedSets(productIds, userId);
    const linkedPids = [...new Set([
        ...[...linkedSets.personal.values()].flatMap(s => [...s]),
        ...[...linkedSets.merge.values()].flatMap(s => [...s]),
    ])];

    // Pre-fetch SP metadata for every basket Product — AND its linked products —
    // across ALL chains. Used both to derive each Product's canonical unit/family
    // (single source of truth for the picker UI + the calc math) and to feed
    // tier-4 cross-chain averaging without an extra per-product SP query.
    const productSpData = await fetchAllSpMetadata([...new Set([...productIds, ...linkedPids])]);
    // Widen each basket Product's canonical family to span its linked products'
    // SPs, so a personal/merge-linked SP counts as in-family and stays eligible
    // for pricing (otherwise pickCheapestForQuantity drops it as an outlier).
    // Linked keys remain separate in productSpData, so tier-4 averaging and the
    // weighable-form vote below still see only each Product's OWN SPs.
    const canonicalInput = linkedPids.length ? new Map(productSpData) : productSpData;
    if (linkedPids.length) {
        for (const pid of productIds) {
            const extraPids = new Set<number>([
                ...(linkedSets.personal.get(pid) ?? []),
                ...(linkedSets.merge.get(pid) ?? []),
            ]);
            if (!extraPids.size) continue;
            const extra = [...extraPids].flatMap(lp => productSpData.get(lp) ?? []);
            if (extra.length) canonicalInput.set(pid, [...(productSpData.get(pid) ?? []), ...extra]);
        }
    }
    const canonicalByProduct = computeCanonicalByProduct(canonicalInput);

    // Each Product's dominant FORM (sold by weight vs fixed pack) — majority of
    // its SPs. Feeds the Tier-3 matcher's weighable/form gate so a by-weight item
    // never substitutes a fixed pack (or vice-versa), the worst substitute error.
    const isWeighableByProduct = new Map<number, boolean>();
    for (const [pid, sps] of productSpData) {
        if (!sps.length) continue;
        const w = sps.filter(sp => sp.isWeighable).length;
        isWeighableByProduct.set(Number(pid), w * 2 >= sps.length);
    }

    // Fallback price pool for tiers 3 & 4. These tiers (substitute + cross-chain
    // average) need a spread of nearby stores to draw prices from. We must NOT
    // tie that pool to the *target* stores: pricing a single store (e.g. a map
    // tap via /store-prices passes one storeId) would otherwise collapse the
    // pool to one store, so substitutes/averages find nothing and items wrongly
    // fall through to "missing" — making a tapped store's total disagree with
    // the same store in the 10-store list. So when specific stores are
    // requested, union them with the nearest stores to the search point to form
    // a stable reference pool, identical to what the list calc sees.
    let poolStoreIds = storeIds;
    let poolChainIds = chainIds;
    if (opts.storeIds?.length) {
        const nearby = ((await getClosestStores(lat, lng, APPROX_POOL_SIZE)) as any[])
            .filter(s => s.distance != null);
        const ids = new Set<number>(storeIds);
        const chains = new Set<number>(chainIds);
        for (const s of nearby) { ids.add(Number(s.id)); chains.add(Number(s.chainId)); }
        poolStoreIds = [...ids];
        poolChainIds = [...chains];
    }

    // Tier 1/2: single batch query — sync lookup inside the loop. Uses the
    // TARGET stores only — this is the store's own direct price. `linkedSets`
    // (computed above) adds the PERSONAL + MERGE "same product" tiers.
    const tier12Cache = await batchFetchTier12Prices(storeIds, chainIds, productIds, linkedSets);

    // Tier 3: one query per (chainId × productId) instead of per (storeId × productId).
    // Results keyed as "chainId:productId" → best-substitute SpRow per store.
    // Priced over the fallback pool so substitutes resolve regardless of how
    // many target stores were requested.
    const tier3Cache = await batchFetchTier3Substitutes(productIds, basketItems, poolStoreIds, poolChainIds, isWeighableByProduct);

    // Tier 4: cross-chain average per productId. Reuses the SP metadata
    // already loaded above — only the latest-prices query is per-product.
    // Averaged over the fallback pool (not the target stores) for consistency.
    const tier4Cache = new Map<number, (SpRow & { effectivePrice: number }) | null>();
    await Promise.all(
        productIds.map(async pid => {
            const canonical = canonicalByProduct.get(pid) ?? null;
            const spMeta = productSpData.get(pid) ?? [];
            tier4Cache.set(pid, await approximateCrossChain(pid, poolStoreIds, spMeta, canonical));
        })
    );

    const storeResults = await Promise.all(
        validStores.map(async (store: any): Promise<StoreResult> => {
            const itemResults = await Promise.all(
                basketItems.map((basketItem: any) => {
                    const pid = Number(basketItem.productId);
                    const anchorAmount = basketItem.anchorAmount != null
                        ? Number(basketItem.anchorAmount) : null;
                    const anchor = anchorAmount != null && Number.isFinite(anchorAmount)
                        ? { amount: anchorAmount, unit: String(basketItem.anchorUnit ?? '') }
                        : null;
                    return resolveItemAtStore(
                        pid,
                        parseFloat(basketItem.quantity),
                        String(basketItem.name),
                        basketItem.matchMode === 'base' ? 'base' : 'sku',
                        Number(store.id),
                        Number(store.chainId),
                        tier12Cache,
                        tier3Cache,
                        tier4Cache,
                        canonicalByProduct.get(pid) ?? null,
                        anchor,
                    );
                })
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
                chainMiniLogoUrl: store.miniLogoUrl || null,
                storeAddress: store.address,
                latitude: store.latitude != null ? Number(store.latitude) : null,
                longitude: store.longitude != null ? Number(store.longitude) : null,
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
    canonical: CanonicalMeta | null,
    anchor: { amount: number; unit: string } | null = null,
): Promise<ItemResult> {
    // Tier 1 / 2: served from the pre-fetched cache — no DB call. Pricing
    // is per-total: for non-weighable items with multiple pack sizes, the
    // cheapest per-pack-unit SP can be wasteful when the user wants a
    // small quantity (e.g. 4-pack at 0.40 beats 30-pack at 2.50 for a
    // basket of 5). pickCheapestForQuantity computes the actual basket
    // cost per SP and picks the cheapest total.
    const direct = getCheapestFromCache(tier12Cache, storeId, productId, matchMode, userQuantity, canonical, anchor);
    if (direct) {
        return priceItem(productId, userQuantity, productName, matchMode, direct,
            { isSubstituted: false, isCrossChainAverage: false }, canonical);
    }

    // Tier 3: pre-computed best substitute for this (chain, product) pair.
    const substitute = tier3Cache.get(`${chainId}:${productId}`) ?? null;
    if (substitute) {
        return priceItem(productId, userQuantity, productName, matchMode, substitute,
            { isSubstituted: true, isCrossChainAverage: false }, canonical);
    }

    // Tier 4: pre-computed cross-chain average — no DB call.
    const synthetic = tier4Cache.get(productId) ?? null;
    if (synthetic) {
        const priced = priceItem(productId, userQuantity, productName, matchMode, synthetic,
            { isSubstituted: false, isCrossChainAverage: true }, canonical);
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
    isWeighableByProduct: Map<number, boolean>,
): Promise<Map<string, (SpRow & { effectivePrice: number }) | null>> {
    const result = new Map<string, (SpRow & { effectivePrice: number }) | null>();
    if (!productIds.length || !chainIds.length || !storeIds.length) return result;

    // Chain candidate sets (SPs + learned canonical/rejected/similarity ALIASES),
    // fetched once per chain and reused across every basket item. Same source the
    // receipt matcher uses — so the basket now benefits from the vocabulary the
    // OCR pipeline learned about how each chain prints a product.
    const chainCandidates = new Map<number, MatchCandidate[]>();
    await Promise.all([...new Set(chainIds)].map(async cid => {
        chainCandidates.set(cid, await getCachedChainCandidates(cid));
    }));

    await Promise.all(chainIds.map(async chainId => {
        const candidates = chainCandidates.get(chainId) ?? [];
        // Pre-normalise candidate names ONCE per chain (not per item) so the
        // per-item stem prefilter below is cheap over the whole chain (~13k SPs).
        const normed = candidates.map(c => ({
            c,
            hay: normalizeName(c.storeProductName),
            aliasHay: (c.aliases ?? []).join(' '),
        }));

        await Promise.all(basketItems.map(async (bi: any) => {
            const productId = Number(bi.productId);
            const productName = String(bi.name);
            const key = `${chainId}:${productId}`;

            // Cheap recall prefilter: keep candidates whose name (or a learned
            // alias) contains one of the item's SIGNIFICANT stems — shrinks the
            // chain to a scorable set before the (heavier) advanced matcher, and
            // the stemming means "sūrelis" reaches "sūreliai/sūrelių".
            const stems = stemQuery(productName).filter(s => s.length >= 4);
            if (!stems.length) { result.set(key, null); return; }
            const pool2: MatchCandidate[] = [];
            for (const n of normed) {
                if (n.c.productId === productId) continue; // Tier 1/2 owns the exact product
                if (stems.some(st => n.hay.includes(st) || n.aliasHay.includes(st))) pool2.push(n.c);
            }
            if (!pool2.length) { result.set(key, null); return; }

            // Advanced TYPED match: aliases + LT stemming + token/anchor/subset/
            // abbrev lanes + the symmetric length penalty (branded-word case),
            // replacing the old first-token-LIKE + whole-string Levenshtein. The
            // item's form (weighable) gates out cross-form substitutes.
            const itemWeighable = isWeighableByProduct.get(productId) ?? null;
            const matches = findBestProductMatches(
                productName, null, null, pool2, TIER3_MIN_CONFIDENCE, 1, itemWeighable, { typed: true });
            const top = matches[0];
            if (!top) { result.set(key, null); return; }
            const topCand = pool2.find(c => c.id === top.storeProductId);
            if (!topCand) { result.set(key, null); return; }

            // Price the winner at any nearby store, cheapest.
            const priceMap = await fetchLatestPrices([Number(topCand.id)], storeIds);
            const storePrices = priceMap.get(Number(topCand.id));
            if (!storePrices?.size) { result.set(key, null); return; }
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
                id: Number(topCand.id),
                productId: Number(topCand.productId),
                storeProductName: topCand.storeProductName,
                isWeighable: topCand.isWeighable,
                amount: topCand.amount,
                unit: topCand.unit,
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
 * SP metadata is supplied by the caller (pre-fetched once for all basket
 * products in fetchAllSpMetadata). Outlier SPs (different unit family
 * than the Product's canonical) are excluded so cross-chain averaging
 * stays apples-to-apples.
 *
 * Pack size handling: SPs are bucketed by (canonical amount, isWeighable)
 * after normalising to the canonical unit. Largest bucket wins. This
 * means a Product with mostly 1L SPs and a stray 500ml SP averages over
 * the 1L bucket only.
 */
async function approximateCrossChain(
    productId: number,
    nearbyStoreIds: number[],
    spMeta: SpMetaRow[],
    canonical: CanonicalMeta | null,
): Promise<(SpRow & { effectivePrice: number }) | null> {
    if (!nearbyStoreIds.length || !spMeta.length) return null;

    // Filter to in-family SPs; outliers shouldn't influence the average.
    const inFamily = canonical
        ? spMeta.filter(sp => canonical.inFamilySpIds.has(sp.id))
        : spMeta;
    if (!inFamily.length) return null;

    const spIds = inFamily.map(sp => sp.id);
    const priceMap = await fetchLatestPrices(spIds, nearbyStoreIds);

    interface Bucket {
        canonAmount: number;
        unit: string;
        isWeighable: boolean;
        // storeId → cheapest effective price seen at that store
        prices: Map<number, number>;
    }
    const buckets = new Map<string, Bucket>();
    for (const sp of inFamily) {
        const storePrices = priceMap.get(sp.id);
        if (!storePrices) continue;
        const rawAmount = sp.amount == null ? 1 : parseFloat(String(sp.amount));
        const canonAmt = canonical
            ? (toCanonicalAmount(rawAmount, sp.unit ?? '', canonical) ?? rawAmount)
            : rawAmount;
        const isWeighable = !!sp.isWeighable;
        const key = `${canonAmt}|${isWeighable ? 1 : 0}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = {
                canonAmount: canonAmt,
                unit: canonical?.unit ?? (sp.unit ?? ''),
                isWeighable,
                prices: new Map(),
            };
            buckets.set(key, bucket);
        }
        for (const [storeId, pd] of storePrices.entries()) {
            if (pd.price == null) continue;
            // Cross-chain uses regular price (not promo) — a promo at one
            // chain doesn't imply the same discount at another.
            const eff = parseFloat(pd.price);
            const current = bucket.prices.get(storeId);
            if (current === undefined || eff < current) bucket.prices.set(storeId, eff);
        }
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
        amount: chosen.canonAmount,
        unit: chosen.unit,
        price: String(avgEffective),
        promoPrice: null,
        isFallback: false,
        effectivePrice: avgEffective,
    };
}

/**
 * Pick the SP that yields the lowest basket-line total for the user's
 * requested quantity.
 *
 *   Weighable: total = userQuantity × (effectivePrice / canonicalAmount)
 *              — picking per-canonical-unit is optimal because the cost
 *              scales linearly with weight.
 *
 *   Non-weighable: total = ceil(userQuantity / canonicalAmount) × price
 *                  — pack rounding means per-canonical-unit can be
 *                  wasteful for small quantities (4-pack at 0.40 may beat
 *                  30-pack at 2.50 when the user wants 5, even though the
 *                  30-pack is cheaper per egg). Compute the actual basket
 *                  cost per SP and pick the minimum.
 *
 * Outlier SPs (different unit family than the Product's canonical) are
 * excluded — they shouldn't compete against in-family SPs whose math the
 * user can reason about. If no SP is in-family (canonical=null), falls
 * back to legacy per-pack pricing without unit normalisation.
 */
export function pickCheapestForQuantity(
    rows: SpRow[],
    userQuantity: number,
    canonical: CanonicalMeta | null,
    anchor: { amount: number; unit: string } | null = null,
): (SpRow & { effectivePrice: number }) | null {
    const priced = rows.filter(r => r.price !== null);
    if (!priced.length) return null;

    const eligible = canonical
        ? priced.filter(r => canonical.inFamilySpIds.has(Number(r.id)))
        : priced;
    // Fall back to all-priced when canonical exists but no in-family SPs
    // are stocked at this store (rare — e.g. only outlier SPs available).
    let candidates = eligible.length > 0 ? eligible : priced;

    // Nearest-attribute preference: when the item carries an anchor (the
    // creator's intended variant), restrict to in-cluster SPs whose pack size
    // matches the anchor's before picking the cheapest — so a shared template
    // doesn't silently resolve to a different-size variant. Falls back to the
    // whole cluster when no SP at this store matches the anchor size.
    if (anchor && Number.isFinite(anchor.amount) && anchor.amount > 0) {
        const anchorCanon = canonical
            ? (toCanonicalAmount(anchor.amount, anchor.unit ?? '', canonical) ?? anchor.amount)
            : anchor.amount;
        if (anchorCanon > 0) {
            const nearest = candidates.filter(sp => {
                const raw = sp.amount ? parseFloat(String(sp.amount)) : 1;
                const canon = canonical
                    ? (toCanonicalAmount(raw, sp.unit ?? '', canonical) ?? raw)
                    : raw;
                return Math.abs(canon - anchorCanon) <= anchorCanon * 0.01; // ~same pack size
            });
            if (nearest.length > 0) candidates = nearest;
        }
    }

    let best: (SpRow & { effectivePrice: number }) | null = null;
    let bestTotal = Infinity;

    for (const sp of candidates) {
        const effectivePrice = sp.promoPrice
            ? parseFloat(String(sp.promoPrice))
            : parseFloat(String(sp.price));
        const rawAmount = sp.amount ? parseFloat(String(sp.amount)) : 1;
        const canonAmount = canonical
            ? (toCanonicalAmount(rawAmount, sp.unit ?? '', canonical) ?? rawAmount)
            : rawAmount;
        const isWeighable = sp.isWeighable === 1 || sp.isWeighable === true;

        const total = isWeighable
            ? userQuantity * (effectivePrice / Math.max(canonAmount, 1e-9))
            : Math.max(1, Math.ceil(userQuantity / Math.max(canonAmount, 1e-9))) * effectivePrice;

        if (total < bestTotal) {
            bestTotal = total;
            best = { ...sp, effectivePrice };
        }
    }
    return best;
}

/**
 * Back-compat wrapper for the legacy pickCheapest signature (per-unit
 * pricing, no quantity input). Used only by paths that pick a single
 * candidate from a one-element list — e.g. fetchNearestNameSubstitute
 * resolves the best name-similar SP then asks for its effectivePrice.
 * New call sites should use pickCheapestForQuantity.
 */
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
    flags: { isSubstituted: boolean; isCrossChainAverage: boolean },
    canonical: CanonicalMeta | null = null,
): ItemResult {
    const effectivePrice = chosen.effectivePrice;
    const spAmount = chosen.amount ? parseFloat(String(chosen.amount)) : 1;
    const spUnit = chosen.unit;
    const isWeighable = chosen.isWeighable === 1 || chosen.isWeighable === true;

    // Canonical amount = SP's amount expressed in the Product's canonical
    // unit. For fluid items: g/ml → ÷1000; kg/l pass through. For count:
    // matches when sub-unit matches (vnt vs vnt). When no canonical (e.g.
    // tier-3 substitute from a different Product), use the raw amount —
    // matches the legacy single-Product behaviour.
    const canonAmount = canonical && spUnit
        ? (toCanonicalAmount(spAmount, spUnit, canonical) ?? spAmount)
        : spAmount;

    let packsNeeded: number;
    let actualAmount: number;
    let totalPrice: number;
    if (isWeighable) {
        // Weighable: userQuantity is in canonical units (kg or l). Cost
        // scales linearly with weight at the per-canonical-unit price.
        packsNeeded = 1;
        actualAmount = userQuantity;
        totalPrice = userQuantity * (effectivePrice / Math.max(canonAmount, 1e-9));
    } else {
        // Non-weighable: userQuantity is in canonical units (kg, l, or
        // pack count). Round up to the nearest SP-pack multiple — you
        // can't buy half a pack.
        packsNeeded = Math.max(1, Math.ceil(userQuantity / Math.max(canonAmount, 1e-9)));
        actualAmount = packsNeeded * canonAmount;
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
