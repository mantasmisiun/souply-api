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

    // Stores and per-item lookups are independent within a store —
    // parallelize both dimensions. For a 15-item basket × 10 stores that
    // turns ~150 serial queries into ~10 concurrent batches of 15.
    const storeResults = await Promise.all(
        stores.map(async (store: any): Promise<StoreResult> => {
            const itemResults = await Promise.all(
                basketItems.map((basketItem: any) =>
                    resolveItemAtStore(
                        Number(basketItem.productId),
                        parseFloat(basketItem.quantity),
                        String(basketItem.name),
                        basketItem.matchMode === 'base' ? 'base' : 'sku',
                        Number(store.id),
                        Number(store.chainId),
                        lat,
                        lng
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
        if (a.missingItemNames.length !== b.missingItemNames.length) {
            return a.missingItemNames.length - b.missingItemNames.length;
        }
        return a.total - b.total;
    });
};

/**
 * Tiered resolution for a single basket item at a specific store. Returns
 * the best-effort ItemResult — never throws for "no data"; the missing/
 * substitution/average flags communicate quality.
 */
async function resolveItemAtStore(
    productId: number,
    userQuantity: number,
    productName: string,
    matchMode: MatchMode,
    storeId: number,
    chainId: number,
    userLat: number,
    userLng: number
): Promise<ItemResult> {
    // Tier 1 / 2: direct or cluster-expanded Product lookup at this chain.
    const direct = await fetchCheapestDirectSp(productId, storeId, chainId, matchMode);
    if (direct) {
        return priceItem(
            productId,
            userQuantity,
            productName,
            matchMode,
            direct,
            { isSubstituted: false, isCrossChainAverage: false }
        );
    }

    // Tier 3: name-similar SP in this chain.
    const substitute = await fetchNearestNameSubstitute(
        productId,
        productName,
        storeId,
        chainId
    );
    if (substitute) {
        return priceItem(
            productId,
            userQuantity,
            productName,
            matchMode,
            substitute,
            { isSubstituted: true, isCrossChainAverage: false }
        );
    }

    // Tier 4: cross-chain average. When chain coverage is zero, we borrow
    // the same Product's price from other chains' nearest-10 stores and
    // feed the basket a plausible-enough number rather than leaving a
    // hole. The UI still flags this with isApproximated+isCrossChainAverage.
    const synthetic = await approximateCrossChain(productId, userLat, userLng);
    if (synthetic) {
        // Run the synthetic SpRow through the same priceItem() path so the
        // pack-vs-weighable math stays consistent with Tiers 1-3. Then
        // overwrite the SP-specific fields with nulls — Tier 4 has no
        // concrete SP at this store.
        const priced = priceItem(productId, userQuantity, productName, matchMode, synthetic, {
            isSubstituted: false,
            isCrossChainAverage: true,
        });
        return {
            ...priced,
            storeProductName: null,
            storeProductId: null,
            resolvedProductId: null,
        };
    }

    return missingAtStore(productId, productName, userQuantity, matchMode);
}

interface SpRow {
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

async function fetchCheapestDirectSp(
    productId: number,
    storeId: number,
    chainId: number,
    matchMode: MatchMode
): Promise<(SpRow & { effectivePrice: number }) | null> {
    const productFilter =
        matchMode === 'base'
            ? 'AND (prod.id = ? OR prod.baseProductId = ?) AND prod.mergedIntoId IS NULL'
            : 'AND prod.id = ? AND prod.mergedIntoId IS NULL';
    const productFilterParams = matchMode === 'base' ? [productId, productId] : [productId];

    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.isWeighable, sp.amount, sp.unit,
                p.price, p.promoPrice, p.isFallback
           FROM StoreProduct sp
           JOIN Product prod ON prod.id = sp.productId
           LEFT JOIN (
               SELECT storeProductId, price, promoPrice, isFallback
                 FROM Price p1
                WHERE p1.storeId = ?
                  AND p1.id = (
                      SELECT MAX(p2.id) FROM Price p2
                       WHERE p2.storeProductId = p1.storeProductId
                         AND p2.storeId = p1.storeId
                  )
           ) p ON p.storeProductId = sp.id
          WHERE sp.chainId = ?
            ${productFilter}`,
        [storeId, chainId, ...productFilterParams]
    );
    return pickCheapest(rows as SpRow[]);
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
                 FROM Price p1
                WHERE p1.storeId = ?
                  AND p1.id = (
                      SELECT MAX(p2.id) FROM Price p2
                       WHERE p2.storeProductId = p1.storeProductId
                         AND p2.storeId = p1.storeId
                  )
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
    userLat: number,
    userLng: number
): Promise<(SpRow & { effectivePrice: number }) | null> {
    const [rows]: any = await pool.query(
        `SELECT sp.amount, sp.unit, sp.isWeighable,
                COALESCE(p.promoPrice, p.price) AS effectivePrice,
                p.price AS rawPrice,
                p.promoPrice,
                p.isFallback,
                p.storeId
           FROM Price p
           JOIN StoreProduct sp ON p.storeProductId = sp.id
           JOIN (
               SELECT id FROM Store
               ORDER BY (
                   6371 * ACOS(
                       COS(RADIANS(?)) * COS(RADIANS(latitude)) *
                       COS(RADIANS(longitude) - RADIANS(?)) +
                       SIN(RADIANS(?)) * SIN(RADIANS(latitude))
                   )
               ) ASC LIMIT 10
           ) closest ON p.storeId = closest.id
          WHERE sp.productId = ?
            AND p.id = (
                SELECT MAX(p2.id) FROM Price p2
                 WHERE p2.storeProductId = p.storeProductId
                   AND p2.storeId = p.storeId
            )`,
        [userLat, userLng, userLat, productId]
    );
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

function pickCheapest(rows: SpRow[]): (SpRow & { effectivePrice: number }) | null {
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

function priceItem(
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
