import { getClosestStores, getStoresByIdsWithDistance } from '../models/storeModel.js';
import { getBasketProductIds, getBasketOwnerId } from '../models/basketModel.js';
import pool from '../config/db.js';
import { toCanonicalAmount, type CanonicalMeta } from './canonicalUnit.js';
import {
    fetchAllSpMetadata,
    computeCanonicalByProduct,
    type SpMetaRow,
} from './productCanonical.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../utils/productMatcher.js';
import { getCachedChainCandidates } from '../models/storeProductModel.js';
import { stemQuery } from '../utils/searchStem.js';
import { fetchLinkedSets } from '../models/linkedProductModel.js';

const VILNIUS_LAT = 54.6872;
const VILNIUS_LNG = 25.2797;
// Size of the nearest-store reference pool used to build the tier-3/tier-4
// fallback caches when only specific stores are priced (e.g. a map-tap via
// /store-prices). Mirrors getClosestStores(…, 10) used by the full list calc.
const APPROX_POOL_SIZE = 12;
// Confidence floor for an auto-applied Tier-3 substitute (the advanced typed
// matcher's 0..1 scale — NOT the old Levenshtein ratio). Conservative: a
// substitute enters a price total unreviewed, so it must be a solid name match.
// Tunable.
const TIER3_MIN_CONFIDENCE = 0.65;
// Saver mode trades precision for price: a looser substitute bar so more
// "similar" products qualify, and the cheapest of them competes with the exact
// product. Still above the matcher's noise floor (0.4) + the form/weighable gate
// so it stays same-category-ish, not garbage. Tunable.
const SAVER_MIN_CONFIDENCE = 0.5;
// Saver prefilter cap: most-relevant N candidates (by stem-hit count) fed to the
// matcher per (chain × item). Bounds the cost of running the fuzzy matcher for
// EVERY item (saver has no coverage gate) without dropping the genuinely similar
// ones a common word would otherwise bury. Tunable.
const SAVER_POOL_CAP = 150;

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
    /** SAVER mode: the goal shifts from "price the exact product" to "find the
     *  absolute cheapest acceptable substitute". Widens every store's candidate
     *  pool — always includes the base cluster, admits looser name-similar
     *  substitutes, and lets the cheapest of {exact, personal, merge, cluster,
     *  substitute} win instead of the exact product always taking precedence. */
    saver?: boolean;
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

/**
 * Latest effective (promo-aware) price per SP across ALL stores — one value
 * each. Used only as the Tier-4 global fallback when a product is stocked
 * nowhere in the nearby pool, so a knowable price still beats a €0 hole.
 */
async function fetchLatestPricesAnyStore(spIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!spIds.length) return out;
    const [rows]: any = await pool.query(
        `SELECT p.storeProductId,
                CASE WHEN p.promoEnd > NOW() THEN p.promoPrice ELSE NULL END AS promoPrice,
                p.price
         FROM Price p
         INNER JOIN (
             SELECT storeProductId, MAX(id) AS maxId
             FROM Price WHERE storeProductId IN (?) GROUP BY storeProductId
         ) latest ON latest.maxId = p.id`,
        [spIds],
    );
    for (const r of rows as any[]) {
        const eff = r.promoPrice != null ? parseFloat(String(r.promoPrice))
            : (r.price != null ? parseFloat(String(r.price)) : NaN);
        if (Number.isFinite(eff)) out.set(Number(r.storeProductId), eff);
    }
    return out;
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
    saver = false,
): (SpRow & { effectivePrice: number }) | null {
    // "Definitely the product" — the item's own SKU plus the PERSONAL (viewer
    // voted 'same') and MERGE (hard-merged) tiers. All are the same product with
    // strong evidence, so they're unioned and priced by cheapest. Applies in both
    // match modes (a personal/global merge is the product regardless of sku/base).
    const direct = cache.sku.get(storeId)?.get(productId) ?? [];
    const personal = cache.personal.get(storeId)?.get(productId) ?? [];
    const merge = cache.merge.get(storeId)?.get(productId) ?? [];
    // Weaker "same base" name-similarity grouping — base mode always, and SAVER
    // mode for sku-mode items too (widen the pool to the whole cluster).
    const cluster = (matchMode === 'base' || saver)
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
    const saver = opts.saver === true;

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

    // Only compute Tier-3 substitutes where they can actually be USED. Tier-3 is
    // consulted at a store only when Tier-1/2 misses there — so a (chain, product)
    // pair whose product has a direct hit at EVERY target store of that chain will
    // never read its substitute. Skipping those pairs avoids running the advanced
    // matcher (the calc's hotspot) for the ~80%+ of items stocked everywhere.
    // SAVER exception: the substitute competes on price with the exact product,
    // so it must be computed even where Tier-1/2 already covers the item — the
    // coverage gate is bypassed and every (chain × product) pair is a candidate.
    const tier3Needed = new Set<string>();
    for (const store of validStores) {
        const sid = Number(store.id);
        const cid = Number(store.chainId);
        for (const bi of basketItems as any[]) {
            const pid = Number(bi.productId);
            const baseMode = saver || bi.matchMode === 'base';
            const covered = !saver && (
                (tier12Cache.sku.get(sid)?.get(pid)?.length ?? 0) > 0
                || (tier12Cache.personal.get(sid)?.get(pid)?.length ?? 0) > 0
                || (tier12Cache.merge.get(sid)?.get(pid)?.length ?? 0) > 0
                || (baseMode && (tier12Cache.cluster.get(sid)?.get(pid)?.length ?? 0) > 0));
            if (!covered) tier3Needed.add(`${cid}:${pid}`);
        }
    }

    // Tier 3: one query per (chainId × productId) instead of per (storeId × productId).
    // Results keyed as "chainId:productId" → best-substitute SpRow per store.
    // Priced over the fallback pool so substitutes resolve regardless of how
    // many target stores were requested.
    const tier3Cache = await batchFetchTier3Substitutes(productIds, basketItems, poolStoreIds, poolChainIds, isWeighableByProduct, tier3Needed, saver);

    // Tier 4: cross-chain average per productId. Reuses the SP metadata
    // already loaded above — only the latest-prices query is per-product.
    // Averaged over the fallback pool (not the target stores) for consistency.
    // Anchor per product (creator's intended pack size) steers bucket choice.
    const anchorByProduct = new Map<number, { amount: number; unit: string }>();
    for (const bi of basketItems as any[]) {
        const a = bi.anchorAmount != null ? Number(bi.anchorAmount) : null;
        if (a != null && Number.isFinite(a) && a > 0) {
            anchorByProduct.set(Number(bi.productId), { amount: a, unit: String(bi.anchorUnit ?? '') });
        }
    }
    // Batched pricing (was 1-2 queries PER product → floods the pool on large
    // baskets): gather every in-family SP id across all products, fetch nearby
    // prices in ONE query; the products that miss the nearby pool get ONE shared
    // any-store fallback query. Bucketing is then pure/sync per product.
    const inFamilyByProduct = new Map<number, number[]>();
    const allInFamilyIds = new Set<number>();
    for (const pid of productIds) {
        const canonical = canonicalByProduct.get(pid) ?? null;
        const spMeta = productSpData.get(pid) ?? [];
        const ids = (canonical ? spMeta.filter(sp => canonical.inFamilySpIds.has(sp.id)) : spMeta).map(sp => sp.id);
        inFamilyByProduct.set(pid, ids);
        for (const id of ids) allInFamilyIds.add(id);
    }
    const tier4NearbyMap = await fetchLatestPrices([...allInFamilyIds], poolStoreIds);
    const globalFallbackIds = new Set<number>();
    for (const pid of productIds) {
        const ids = inFamilyByProduct.get(pid) ?? [];
        if (!ids.some(id => (tier4NearbyMap.get(id)?.size ?? 0) > 0)) {
            for (const id of ids) globalFallbackIds.add(id);
        }
    }
    const tier4GlobalMap = globalFallbackIds.size
        ? await fetchLatestPricesAnyStore([...globalFallbackIds])
        : new Map<number, number>();

    const tier4Cache = new Map<number, (SpRow & { effectivePrice: number }) | null>();
    for (const pid of productIds) {
        const canonical = canonicalByProduct.get(pid) ?? null;
        const spMeta = productSpData.get(pid) ?? [];
        tier4Cache.set(pid, approximateCrossChain(
            pid, spMeta, canonical, anchorByProduct.get(pid) ?? null, tier4NearbyMap, tier4GlobalMap));
    }

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
                        saver,
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
    saver = false,
): Promise<ItemResult> {
    // Tier 1 / 2: served from the pre-fetched cache — no DB call. Pricing
    // is per-total: for non-weighable items with multiple pack sizes, the
    // cheapest per-pack-unit SP can be wasteful when the user wants a
    // small quantity (e.g. 4-pack at 0.40 beats 30-pack at 2.50 for a
    // basket of 5). pickCheapestForQuantity computes the actual basket
    // cost per SP and picks the cheapest total. SAVER mode also folds the
    // base cluster into this pool for sku-mode items (see getCheapestFromCache).
    const direct = getCheapestFromCache(tier12Cache, storeId, productId, matchMode, userQuantity, canonical, anchor, saver);
    const substitute = tier3Cache.get(`${chainId}:${productId}`) ?? null;

    if (saver) {
        // Precision is not the goal — the absolute cheapest acceptable option is.
        // Price BOTH the exact/near tiers and the substitute, then take whichever
        // yields the lower basket-line total. Falls through to Tier-4/missing only
        // when neither exists at this store.
        const options: ItemResult[] = [];
        if (direct) options.push(priceItem(productId, userQuantity, productName, matchMode, direct,
            { isSubstituted: false, isCrossChainAverage: false }, canonical));
        if (substitute) options.push(priceItem(productId, userQuantity, productName, matchMode, substitute,
            { isSubstituted: true, isCrossChainAverage: false }, canonical));
        if (options.length) {
            return options.reduce((a, b) => (b.totalPrice ?? Infinity) < (a.totalPrice ?? Infinity) ? b : a);
        }
    } else {
        // Normal mode: precision first — the exact/near product wins even when a
        // substitute is cheaper.
        if (direct) {
            return priceItem(productId, userQuantity, productName, matchMode, direct,
                { isSubstituted: false, isCrossChainAverage: false }, canonical);
        }
        if (substitute) {
            return priceItem(productId, userQuantity, productName, matchMode, substitute,
                { isSubstituted: true, isCrossChainAverage: false }, canonical);
        }
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
/** Per-chain normalized-candidate memo, keyed on the candidate array identity
 *  (stable within getCachedChainCandidates' TTL → recomputed only on refresh). */
const normedMemo = new WeakMap<any[], Array<{ c: MatchCandidate; hay: string; aliasHay: string }>>();

async function batchFetchTier3Substitutes(
    productIds: number[],
    basketItems: any[],
    storeIds: number[],
    chainIds: number[],
    isWeighableByProduct: Map<number, boolean>,
    /** `${chainId}:${productId}` pairs that actually need a substitute (Tier-1/2
     *  misses at some target store). Pairs absent here are skipped — their item
     *  is stocked at every store of the chain, so the substitute is never read. */
    tier3Needed: Set<string>,
    /** SAVER: looser confidence bar + keep several candidates per item, then
     *  return the CHEAPEST of them (not the highest-confidence one). */
    saver = false,
): Promise<Map<string, (SpRow & { effectivePrice: number }) | null>> {
    const result = new Map<string, (SpRow & { effectivePrice: number }) | null>();
    if (!productIds.length || !chainIds.length || !storeIds.length || !tier3Needed.size) return result;
    const minConf = saver ? SAVER_MIN_CONFIDENCE : TIER3_MIN_CONFIDENCE;
    const topN = saver ? 8 : 1;

    // Chain candidate sets (SPs + learned canonical/rejected/similarity ALIASES),
    // fetched once per chain and reused across every basket item. Same source the
    // receipt matcher uses — so the basket now benefits from the vocabulary the
    // OCR pipeline learned about how each chain prints a product.
    const chainCandidates = new Map<number, MatchCandidate[]>();
    await Promise.all([...new Set(chainIds)].map(async cid => {
        chainCandidates.set(cid, await getCachedChainCandidates(cid));
    }));

    // Phase A — MATCHING (CPU only, no DB). For every (chain × item) resolve the
    // best substitute candidate via the advanced matcher, and collect the SP ids
    // that need pricing. Sequential on purpose: this is CPU-bound, and firing a
    // price query per (chain × item) as before floods the connection pool on
    // large baskets (40 items × N chains ≫ queueLimit → "Queue limit reached").
    const winners = new Map<string, MatchCandidate[]>();
    const spIdsToPrice = new Set<number>();
    for (const chainId of chainIds) {
        // Skip the whole chain when nothing there needs a substitute — avoids the
        // ~13k-name normalization for chains fully covered by Tier-1/2.
        if (!(basketItems as any[]).some(bi => tier3Needed.has(`${chainId}:${Number(bi.productId)}`))) continue;
        const candidates = chainCandidates.get(chainId) ?? [];
        // Pre-normalise candidate names ONCE per chain (not per item) so the
        // per-item stem prefilter below is cheap over the whole chain (~13k SPs).
        // Memoised on the candidate array identity: getCachedChainCandidates
        // returns a stable ref within its TTL, so this is computed once per chain
        // per catalog-cache window and reused across every basket calc.
        let normed = normedMemo.get(candidates);
        if (!normed) {
            normed = candidates.map(c => ({
                c,
                hay: normalizeProductName(c.storeProductName),
                aliasHay: (c.aliases ?? []).join(' '),
            }));
            normedMemo.set(candidates, normed);
        }

        for (const bi of basketItems as any[]) {
            const productId = Number(bi.productId);
            const productName = String(bi.name);
            const key = `${chainId}:${productId}`;
            if (result.has(key) || winners.has(key)) continue; // duplicate product in basket
            if (!tier3Needed.has(key)) continue; // Tier-1/2 covers it everywhere → no substitute read

            // Cheap recall prefilter: keep candidates whose name (or a learned
            // alias) contains one of the item's SIGNIFICANT stems — shrinks the
            // chain to a scorable set before the (heavier) advanced matcher, and
            // the stemming means "sūrelis" reaches "sūreliai/sūrelių".
            const stems = stemQuery(productName).filter(s => s.length >= 4);
            if (!stems.length) { result.set(key, null); continue; }
            let pool2: MatchCandidate[] = [];
            if (saver) {
                // Saver runs the matcher for EVERY item (no coverage gate), so a
                // common word ("pienas") can prefilter to hundreds of loosely
                // related SPs and blow up the matcher. Score each by how many of
                // the item's stems it contains and keep the most relevant slice —
                // bounds cost while keeping the genuinely-similar (cheapest) ones.
                const scored: Array<{ c: MatchCandidate; hits: number }> = [];
                for (const n of normed) {
                    if (n.c.productId === productId) continue;
                    let hits = 0;
                    for (const st of stems) if (n.hay.includes(st) || n.aliasHay.includes(st)) hits++;
                    if (hits > 0) scored.push({ c: n.c, hits });
                }
                scored.sort((a, b) => b.hits - a.hits);
                pool2 = scored.slice(0, SAVER_POOL_CAP).map(s => s.c);
            } else {
                for (const n of normed) {
                    if (n.c.productId === productId) continue; // Tier 1/2 owns the exact product
                    if (stems.some(st => n.hay.includes(st) || n.aliasHay.includes(st))) pool2.push(n.c);
                }
            }
            if (!pool2.length) { result.set(key, null); continue; }

            // Advanced TYPED match: aliases + LT stemming + token/anchor/subset/
            // abbrev lanes + the symmetric length penalty (branded-word case),
            // replacing the old first-token-LIKE + whole-string Levenshtein. The
            // item's form (weighable) gates out cross-form substitutes.
            const itemWeighable = isWeighableByProduct.get(productId) ?? null;
            const matches = findBestProductMatches(
                productName, null, null, pool2, minConf, topN, itemWeighable, { typed: true });
            if (!matches.length) { result.set(key, null); continue; }
            // Normal: the single best match. Saver: keep every match above the
            // looser bar so Phase C can pick the cheapest of them.
            const cands: MatchCandidate[] = [];
            for (const m of matches) {
                const c = pool2.find(pc => pc.id === m.storeProductId);
                if (c) { cands.push(c); spIdsToPrice.add(Number(c.id)); }
            }
            if (!cands.length) { result.set(key, null); continue; }
            winners.set(key, cands);
        }
    }

    // Phase B — PRICING. One batched latest-price query for every winning SP
    // across the fallback pool, instead of a query per (chain × item).
    const priceMap = await fetchLatestPrices([...spIdsToPrice], storeIds);

    // Phase C — assemble. For each key pick the candidate (and its store price)
    // with the lowest effective price. Normal mode has one candidate → its
    // cheapest store price; saver has several → the cheapest across ALL of them.
    for (const [key, cands] of winners) {
        let winCand: MatchCandidate | null = null;
        let winPrice: any = null;
        let winEff = Infinity;
        for (const cand of cands) {
            const storePrices = priceMap.get(Number(cand.id));
            if (!storePrices?.size) continue;
            for (const pd of storePrices.values()) {
                if (pd.price == null) continue;
                const eff = pd.promoPrice ? parseFloat(pd.promoPrice) : parseFloat(pd.price);
                if (eff < winEff) { winEff = eff; winPrice = pd; winCand = cand; }
            }
        }
        if (!winCand || !winPrice) { result.set(key, null); continue; }
        result.set(key, {
            id: Number(winCand.id),
            productId: Number(winCand.productId),
            storeProductName: winCand.storeProductName,
            isWeighable: winCand.isWeighable,
            amount: winCand.amount,
            unit: winCand.unit,
            price: winPrice.price,
            promoPrice: winPrice.promoPrice,
            isFallback: winPrice.isFallback,
            effectivePrice: winEff,
        });
    }

    return result;
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
function approximateCrossChain(
    productId: number,
    spMeta: SpMetaRow[],
    canonical: CanonicalMeta | null,
    anchor: { amount: number; unit: string } | null,
    nearbyMap: Map<number, Map<number, { price: any; promoPrice: any; isFallback: any }>>,
    globalMap: Map<number, number>,
): (SpRow & { effectivePrice: number }) | null {
    if (!spMeta.length) return null;

    // Filter to in-family SPs; outliers shouldn't influence the average.
    const inFamily = canonical
        ? spMeta.filter(sp => canonical.inFamilySpIds.has(sp.id))
        : spMeta;
    if (!inFamily.length) return null;

    const canonAmountOf = (sp: SpMetaRow): number => {
        const raw = sp.amount == null ? 1 : parseFloat(String(sp.amount));
        return canonical ? (toCanonicalAmount(raw, sp.unit ?? '', canonical) ?? raw) : raw;
    };
    // Effective price = promo when active, else regular. fetchLatestPrices
    // already NULLs expired promos, so this reflects the shelf price a shopper
    // pays right now (Tier-5 change: was regular-only before).
    const effOf = (pd: { price: any; promoPrice: any }): number | null => {
        const p = pd.promoPrice != null ? parseFloat(String(pd.promoPrice))
            : (pd.price != null ? parseFloat(String(pd.price)) : NaN);
        return Number.isFinite(p) ? p : null;
    };

    interface Bucket {
        canonAmount: number;
        unit: string;
        isWeighable: boolean;
        // pricing-point key → cheapest effective price at that point
        prices: Map<number, number>;
    }
    // Group in-family SPs into pack-size buckets. `pricesOf(sp)` yields
    // [pointKey, effectivePrice] pairs — one per nearby store, or one global.
    const buildBuckets = (pricesOf: (sp: SpMetaRow) => Array<[number, number]>): Map<string, Bucket> => {
        const buckets = new Map<string, Bucket>();
        for (const sp of inFamily) {
            const pts = pricesOf(sp);
            if (!pts.length) continue;
            const canonAmt = canonAmountOf(sp);
            const key = `${canonAmt}|${sp.isWeighable ? 1 : 0}`;
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = { canonAmount: canonAmt, unit: canonical?.unit ?? (sp.unit ?? ''), isWeighable: !!sp.isWeighable, prices: new Map() };
                buckets.set(key, bucket);
            }
            for (const [k, eff] of pts) {
                const cur = bucket.prices.get(k);
                if (cur === undefined || eff < cur) bucket.prices.set(k, eff);
            }
        }
        return buckets;
    };
    const hasPrices = (bs: Map<string, Bucket>) => [...bs.values()].some(b => b.prices.size > 0);

    // Primary: the nearby fallback pool — cheapest effective price per store.
    // Prices are pre-fetched in ONE batch by the caller (no query here).
    let buckets = buildBuckets(sp => {
        const storePrices = nearbyMap.get(sp.id);
        if (!storePrices) return [];
        const out: Array<[number, number]> = [];
        for (const [storeId, pd] of storePrices.entries()) {
            const e = effOf(pd);
            if (e != null) out.push([storeId, e]);
        }
        return out;
    });

    // Global fallback (Tier-4b): not priced anywhere in the nearby pool. Rather
    // than mark it silently missing (a €0 hole in the basket total), estimate
    // from its latest price ANYWHERE — real data, still flagged approximate.
    // (globalMap is the batched any-store probe, populated only for the
    // products that missed the nearby pool.)
    if (!hasPrices(buckets)) {
        buckets = buildBuckets(sp => {
            const e = globalMap.get(sp.id);
            return e != null ? [[sp.id, e]] : [];
        });
    }

    // Bucket choice: the anchor's pack size when the creator set one (estimate
    // the intended variant), else the widest-covered size.
    const anchorCanon = anchor && Number.isFinite(anchor.amount) && anchor.amount > 0
        ? (canonical ? (toCanonicalAmount(anchor.amount, anchor.unit ?? '', canonical) ?? anchor.amount) : anchor.amount)
        : null;
    let chosen: Bucket | null = null;
    for (const b of buckets.values()) {
        if (!b.prices.size) continue;
        if (anchorCanon != null && Math.abs(b.canonAmount - anchorCanon) <= anchorCanon * 0.01) { chosen = b; break; }
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
        const isWeighable = sp.isWeighable === 1 || sp.isWeighable === true;
        // Null canonical ⇒ quantity is a pack count (client stepped by 1); one
        // pack = 1 unit for non-weighable, so a count isn't divided by a weight.
        const canonAmount = canonical
            ? (toCanonicalAmount(rawAmount, sp.unit ?? '', canonical) ?? rawAmount)
            : (isWeighable ? rawAmount : 1);

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
    // No canonical (product has no SP metadata → resolved via a tier-3 substitute):
    // the client had no canonicalStep, so it stepped by 1 and `quantity` is a PACK
    // COUNT, not a weight. Treat one pack = 1 unit so a count of 1 doesn't get
    // divided by the substitute's weight (e.g. ceil(1 / 0.08 kg) = 13 packs).
    // Weighable items keep their weight amount.
    const canonAmount = canonical && spUnit
        ? (toCanonicalAmount(spAmount, spUnit, canonical) ?? spAmount)
        : (isWeighable ? spAmount : 1);

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

