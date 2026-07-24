import pool from '../config/db.js';
import { getReceiptById } from '../models/receiptModel.js';
import { getStoreById, getClosestStorePerChainToStore, ClosestChainStore } from '../models/storeModel.js';
import { unitFamily, UnitFamily } from './canonicalUnit.js';
import { getPersonalEquivalentProductIds } from '../models/userEquivalenceModel.js';

interface ParsedReceiptItem {
    storeProductId: number | null;
    quantity: number;
    unit: string | null;
    price: number;
    promoPrice: number | null;
    matchConfirmed: boolean;
}

interface StoreBasket {
    total: number;
    knownItems: number;
    imputedItems: number;
    flatItems: number;
}

interface ComparisonChainResult {
    chainId: number;
    chainName: string;
    storeId: number;
    storeName: string;
    storeAddress: string;
    distanceKm: number;
    total: number;
    savings: number;
    knownItems: number;
    imputedItems: number;
    flatItems: number;
    note?: string;
    chainLogoUrl: string | null;
}

type SpOption = {
    isWeighable: boolean;
    amount: number | null;
    unit: string | null;
    price: number;
    promoPrice: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Default for the in-range cap. Lithuanian urban areas have meaningful
 * cross-chain alternatives within ~5 km; 10 km is a generous default that
 * still meaningfully prunes "drive 50 km to save 1 €" non-actionable
 * comparisons. The mobile passes this as a query param so the constant
 * is reachable from one place there too.
 */
const DEFAULT_MAX_DISTANCE_KM = 10;
/**
 * When the primary range has zero alternatives (rural / single-chain
 * pocket), we don't just give up — we ground a cluster around the
 * closest alternative anywhere, and include any other cross-chain
 * stores within 5 km of THAT anchor. Turns "no neighbours" into a
 * useful "the nearest cluster is 32 km away in Klaipėda, here's what
 * shops there charge".
 */
const CLUSTER_RADIUS_KM = 5;

/**
 * Great-circle distance between two lat/lng points in kilometres.
 * Used by the cluster-fallback path to compute distance from the
 * visited store to cluster members without an extra SQL round-trip.
 */
const haversineKm = (
    lat1: number, lng1: number, lat2: number, lng2: number,
): number => {
    const R = 6371;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const normalizeUnit = (unit: string | null | undefined): string | null => {
    if (!unit) return null;
    return unit.trim().toLowerCase();
};

const normalizeQuantityToStoreUnit = (
    quantity: number,
    inputUnit: string | null,
    storeUnit: string | null
): number => {
    const from = normalizeUnit(inputUnit);
    const to = normalizeUnit(storeUnit);

    if (!from || !to || from === to) return quantity;
    if (from === 'kg' && to === 'g') return quantity * 1000;
    if (from === 'g' && to === 'kg') return quantity / 1000;

    return quantity;
};

/**
 * Batch-fetch the latest verified price for every (storeId, productId) pair.
 * Returns Map<storeId, Map<productId, SpOption[]>> — one entry per SP that has
 * a verified price at that store. A productId may map to multiple SP options
 * when the chain carries the same product in different sizes.
 *
 * Uses a window function (ROW_NUMBER) so the DB evaluates one scan of the
 * Price index instead of one correlated subquery per (storeProductId, storeId).
 */
const batchGetLatestVerifiedPricesForStores = async (
    productIds: number[],
    storeIds: number[],
): Promise<Map<number, Map<number, SpOption[]>>> => {
    if (!productIds.length || !storeIds.length) return new Map();
    const [rows]: any = await pool.query(
        `SELECT sp.productId, sp.isWeighable, sp.amount, sp.unit,
                lp.storeId, lp.price, lp.promoPrice
         FROM StoreProduct sp
         JOIN (
             SELECT p.storeProductId, p.storeId, p.price, p.promoPrice,
                    ROW_NUMBER() OVER (PARTITION BY p.storeProductId, p.storeId ORDER BY p.id DESC) AS rn
             FROM Price p
             WHERE p.storeId IN (?)
               AND p.priceVerified = 1
               AND p.storeProductId IN (
                   SELECT id FROM StoreProduct WHERE productId IN (?)
               )
         ) lp ON lp.storeProductId = sp.id AND lp.rn = 1
         WHERE sp.productId IN (?)`,
        [storeIds, productIds, productIds]
    );
    const result = new Map<number, Map<number, SpOption[]>>();
    for (const row of rows) {
        const storeId = Number(row.storeId);
        const productId = Number(row.productId);
        if (!result.has(storeId)) result.set(storeId, new Map());
        const byProduct = result.get(storeId)!;
        if (!byProduct.has(productId)) byProduct.set(productId, []);
        byProduct.get(productId)!.push({
            isWeighable: !!row.isWeighable,
            amount: row.amount === null ? null : Number(row.amount),
            unit: row.unit ?? null,
            price: Number(row.price),
            promoPrice: row.promoPrice === null ? null : Number(row.promoPrice),
        });
    }
    return result;
};

const calculateItemTotalSync = (
    options: SpOption[],
    quantity: number,
    inputUnit: string | null,
): number | null => {
    if (!options.length) return null;
    let best: (SpOption & { effectivePrice: number; normalizedAmount: number }) | null = null;
    let bestPricePerUnit = Infinity;
    for (const option of options) {
        const effectivePrice = option.promoPrice !== null ? option.promoPrice : option.price;
        const normalizedAmount = option.amount !== null && option.amount > 0 ? option.amount : 1;
        if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) continue;
        const pricePerUnit = effectivePrice / normalizedAmount;
        if (pricePerUnit < bestPricePerUnit) {
            bestPricePerUnit = pricePerUnit;
            best = { ...option, effectivePrice, normalizedAmount };
        }
    }
    if (!best) return null;
    const normalizedQty = normalizeQuantityToStoreUnit(quantity, inputUnit, best.unit);
    if (!Number.isFinite(normalizedQty) || normalizedQty <= 0) return null;
    if (best.isWeighable) {
        return round2(normalizedQty * bestPricePerUnit);
    }
    // Pack rounding `ceil(qty / packSize)` only makes sense when the request
    // and the SP's pack size are the same kind of unit. When the pack is a
    // weight/volume (fluid family) but the request is NOT — e.g. a "1 vnt"
    // receipt line priced against a "0.010 g" Šafranas pack — `packSize` is a
    // sub-gram weight, and dividing gives ceil(1 / 0.010) = 100 packs = €229,
    // which detonates the whole comparison. In that case the quantity is a
    // COUNT of items, so buy `quantity` whole packs instead. (Count-family
    // packs like a 10-vnt egg tray still divide correctly via the else branch.)
    const inFam = unitFamily(inputUnit);
    const packFam = unitFamily(best.unit);
    const packsNeeded = (packFam === 'fluid' && inFam !== 'fluid')
        ? Math.max(1, Math.ceil(quantity))
        : Math.max(1, Math.ceil(normalizedQty / best.normalizedAmount));
    if (packsNeeded > 50) {
        console.warn(
            `[receiptComparison] suspicious packsNeeded=${packsNeeded} ` +
            `(qty=${quantity} ${inputUnit ?? '?'} vs pack ${best.normalizedAmount} ${best.unit ?? '?'}) ` +
            `→ €${round2(packsNeeded * best.effectivePrice)}; check for a unit/pack-size data error`,
        );
    }
    return round2(packsNeeded * best.effectivePrice);
};

/**
 * Build per-store baskets for the given receipt items.
 *
 * Recognised items (matchConfirmed + storeProductId resolvable to productId):
 *   - Visited store: receipt price × quantity.
 *   - Alt store that carries the product: cheapest per-unit option (with pack math / unit conversion).
 *   - Alt store that doesn't carry it: imputed = average of visited price and every alt that does carry it.
 *
 * Unrecognised items (no match): price × quantity added flat to every store, so they contribute
 * equally and don't distort savings.
 *
 * Invalid items (price <= 0 or quantity <= 0) are skipped entirely.
 */
const buildStoreBaskets = async (
    items: ParsedReceiptItem[],
    productIdByStoreProductId: Map<number, number>,
    allStores: ClosestChainStore[],
    currentStoreId: number,
    // BOOSTER (additive, never subtractive): the receipt owner's personal
    // 'same' equivalences, lineProductId → equivalent (cross-chain) productIds.
    // Their price points join the candidate pool so an owner-identified sibling
    // can supply a real alt-store price the global catalog alone would miss.
    personalEquivProductIds: Map<number, number[]> = new Map(),
    // Safeguard reference: lineProductId → its canonical unit family. An
    // equivalent option is only admitted when its own family matches (or the
    // reference family is unknown) — same guard the rest of the pricer uses.
    refFamilyByProduct: Map<number, UnitFamily | null> = new Map(),
): Promise<Map<number, StoreBasket>> => {
    const baskets = new Map<number, StoreBasket>();
    for (const store of allStores) {
        baskets.set(store.storeId, { total: 0, knownItems: 0, imputedItems: 0, flatItems: 0 });
    }

    const recognizedProductIds = Array.from(new Set(
        items
            .filter(i => i.matchConfirmed && i.storeProductId !== null)
            .map(i => productIdByStoreProductId.get(i.storeProductId!))
            .filter((id): id is number => id !== undefined)
    ));
    // Union in the owner's personal-equivalent products so the batch fetch also
    // pulls THEIR verified prices at the alt stores.
    const pricedProductIds = Array.from(new Set([
        ...recognizedProductIds,
        ...Array.from(personalEquivProductIds.values()).flat(),
    ]));
    const altStoreIds = allStores
        .filter(s => s.storeId !== currentStoreId)
        .map(s => s.storeId);
    const priceCache = await batchGetLatestVerifiedPricesForStores(pricedProductIds, altStoreIds);

    // Gather the priceable options for a product at a store: the product's own
    // options PLUS any owner-personal-equivalent product's options, gated to
    // the same canonical unit family. Personal edges only ADD candidates; the
    // global options are always kept.
    const optionsFor = (storeId: number, productId: number): SpOption[] => {
        const own = priceCache.get(storeId)?.get(productId) ?? [];
        const equiv = personalEquivProductIds.get(productId);
        if (!equiv || equiv.length === 0) return own;
        const refFamily = refFamilyByProduct.get(productId) ?? null;
        const merged = [...own];
        for (const eqPid of equiv) {
            const eqOpts = priceCache.get(storeId)?.get(eqPid) ?? [];
            for (const o of eqOpts) {
                // Safeguard: admit only a plausible same item — matching unit
                // family (when the reference family is known). Never fabricate a
                // price; these are real Price rows already in the cache.
                if (refFamily !== null && unitFamily(o.unit) !== refFamily) continue;
                merged.push(o);
            }
        }
        return merged;
    };

    for (const item of items) {
        if (!(item.price > 0) || !(item.quantity > 0)) continue;

        const effectiveUnitPrice = item.promoPrice !== null && item.promoPrice > 0
            ? item.promoPrice
            : item.price;
        const lineTotal = round2(effectiveUnitPrice * item.quantity);
        // Regular price used as the imputation baseline: a promo at the
        // visited store is specific to that chain's current campaign and
        // shouldn't drag down the estimated cost at stores that don't carry
        // the item.
        const regularLineTotal = round2(item.price * item.quantity);
        const productId = item.storeProductId !== null
            ? productIdByStoreProductId.get(item.storeProductId)
            : undefined;
        const isRecognised = item.matchConfirmed && productId !== undefined;

        if (!isRecognised) {
            for (const store of allStores) {
                const b = baskets.get(store.storeId)!;
                b.total = round2(b.total + lineTotal);
                b.flatItems++;
            }
            continue;
        }

        // known: actual price you'd pay at each store (promo where applicable).
        // forImputation: baseline for averaging — current store contributes its
        // regular price so a promo doesn't skew the estimate for stores that
        // don't stock this product.
        const known = new Map<number, number>();
        known.set(currentStoreId, lineTotal);
        const forImputation = new Map<number, number>();
        forImputation.set(currentStoreId, regularLineTotal);

        for (const store of allStores) {
            if (store.storeId === currentStoreId) continue;
            const options = optionsFor(store.storeId, productId!);
            const t = calculateItemTotalSync(options, item.quantity, item.unit);
            if (t !== null) {
                known.set(store.storeId, t);
                forImputation.set(store.storeId, t);
            }
        }

        const imputedValues = Array.from(forImputation.values());
        const imputed = round2(imputedValues.reduce((a, b) => a + b, 0) / imputedValues.length);

        for (const store of allStores) {
            const b = baskets.get(store.storeId)!;
            if (known.has(store.storeId)) {
                b.total = round2(b.total + known.get(store.storeId)!);
                b.knownItems++;
            } else {
                b.total = round2(b.total + imputed);
                b.imputedItems++;
            }
        }
    }

    return baskets;
};

export interface ReceiptComparisonOptions {
    /** Hard cap on alternative-store distance from the visited store.
     *  Falls back to DEFAULT_MAX_DISTANCE_KM when omitted. */
    maxDistanceKm?: number;
    /** Override for whose personal 'same' equivalences enrich the candidate
     *  price pool. Defaults to the receipt OWNER (uploaderUserId ?? userId) —
     *  NOT the viewer — because a ReceiptComparisonSnapshot is one shared row
     *  per receipt, so every trip member sees the same owner-informed result.
     *  Callers normally omit this; the owner is resolved from the receipt. */
    ownerUserId?: string | null;
}

export const getReceiptComparison = async (
    receiptId: number,
    opts: ReceiptComparisonOptions = {},
) => {
    const maxDistanceKm = opts.maxDistanceKm ?? DEFAULT_MAX_DISTANCE_KM;
    const receipt = await getReceiptById(receiptId);
    if (!receipt) {
        const err = new Error('Receipt not found');
        (err as any).statusCode = 404;
        throw err;
    }

    if (!receipt.storeId) {
        const err = new Error('Receipt store is not resolved');
        (err as any).statusCode = 400;
        throw err;
    }

    const parsedData = typeof receipt.parsedData === 'string'
        ? JSON.parse(receipt.parsedData)
        : receipt.parsedData;

    const rawProducts = Array.isArray(parsedData?.products) ? parsedData.products : [];

    const items: ParsedReceiptItem[] = rawProducts.map((p: any) => ({
        storeProductId: Number(p?.storeProductId) > 0 ? Number(p.storeProductId) : null,
        quantity: Number(p?.quantity),
        unit: p?.unit ?? null,
        price: Number(p?.price),
        promoPrice: p?.promoPrice !== null && p?.promoPrice !== undefined && !Number.isNaN(Number(p.promoPrice))
            ? Number(p.promoPrice)
            : null,
        matchConfirmed: !!p?.matchConfirmed,
    }));

    const validItems = items.filter((i) => i.price > 0 && i.quantity > 0);
    const invalidItems = items.length - validItems.length;
    const recognizedItems = validItems.filter((i) => i.matchConfirmed && i.storeProductId !== null).length;
    const unrecognizedItems = validItems.length - recognizedItems;

    if (!validItems.length) {
        return {
            currentChain: { total: 0 },
            alternatives: [],
            summary: {
                recognizedItems: 0,
                unrecognizedItems: 0,
                invalidItems,
                note: invalidItems > 0
                    ? 'Kvite nerasta tinkamų prekių palyginimui. Patikrinkite kvito duomenis.'
                    : undefined,
            },
        };
    }

    const [[currentStore], closestPerChain] = await Promise.all([
        getStoreById(receipt.storeId),
        getClosestStorePerChainToStore(receipt.storeId),
    ]);
    if (!currentStore) {
        const err = new Error('Visited store not found');
        (err as any).statusCode = 404;
        throw err;
    }
    const crossChainStores = closestPerChain.filter((s) => s.chainId !== currentStore.chainId);

    // B2.5: filter alternatives to within `maxDistanceKm` of the visited
    // store. When that pool is empty, ground a cluster around the closest
    // out-of-range alternative — pick stores within CLUSTER_RADIUS_KM of
    // it (still cross-chain only, still one per chain).
    let alternativeStores: ClosestChainStore[];
    const withinRange = crossChainStores.filter((s) => s.distance <= maxDistanceKm);
    if (withinRange.length > 0 || crossChainStores.length === 0) {
        alternativeStores = withinRange;
    } else {
        // crossChainStores is sorted per-chain, but not globally — find
        // the genuinely-closest alternative.
        const anchor = crossChainStores.reduce(
            (best, s) => (s.distance < best.distance ? s : best),
            crossChainStores[0],
        );
        // The anchor itself is always included (it IS the closest). The
        // rest of the cluster comes from a second per-chain query around
        // the anchor, kept to within CLUSTER_RADIUS_KM. Distances on the
        // returned alternatives are still relative to the *visited*
        // store — that's what the user cares about ("how far from where
        // I shopped"). The anchor-relative distance is internal.
        const aroundAnchor = await getClosestStorePerChainToStore(anchor.storeId);
        const visitedLat = currentStore.latitude;
        const visitedLng = currentStore.longitude;
        alternativeStores = aroundAnchor
            .filter((s) => s.chainId !== currentStore.chainId)
            .filter((s) => s.distance <= CLUSTER_RADIUS_KM)
            .map((s) => ({
                ...s,
                // Recompute distance from the visited store, since `s.distance`
                // currently means "distance from anchor".
                distance: parseFloat(
                    haversineKm(visitedLat, visitedLng, s.latitude, s.longitude).toFixed(2),
                ),
            }));
    }

    const currentStoreForCalc: ClosestChainStore = {
        storeId: currentStore.id,
        storeName: currentStore.name,
        storeAddress: currentStore.address,
        chainId: currentStore.chainId,
        chainName: currentStore.chainName,
        chainLogoUrl: currentStore.logoUrl || null,
        distance: 0,
        latitude: currentStore.latitude,
        longitude: currentStore.longitude,
    };

    const allStores = [currentStoreForCalc, ...alternativeStores];

    const recognizedStoreProductIds = Array.from(
        new Set(
            validItems
                .filter((i) => i.matchConfirmed && i.storeProductId !== null)
                .map((i) => i.storeProductId!)
        )
    );
    const productIdByStoreProductId = new Map<number, number>();
    // Reference canonical unit family per product, keyed off the receipt line's
    // OWN store product — the safeguard baseline for admitting personal-
    // equivalent options (must share the family).
    const refFamilyByProduct = new Map<number, UnitFamily | null>();
    if (recognizedStoreProductIds.length) {
        const [spRows]: any = await pool.query(
            `SELECT id, productId, unit FROM StoreProduct WHERE id IN (?)`,
            [recognizedStoreProductIds]
        );
        for (const row of spRows) {
            const productId = Number(row.productId);
            productIdByStoreProductId.set(Number(row.id), productId);
            if (!refFamilyByProduct.has(productId)) {
                refFamilyByProduct.set(productId, unitFamily(row.unit));
            } else if (refFamilyByProduct.get(productId) == null) {
                // Prefer the first non-null family seen for the product.
                refFamilyByProduct.set(productId, unitFamily(row.unit));
            }
        }
    }

    // Receipt-owner personal 'same' equivalences (BOOSTER, fail-open): key off
    // the OWNER, resolved from the receipt unless explicitly overridden. If the
    // lookup throws, fall back silently to today's global-only comparison.
    const ownerUserId = opts.ownerUserId
        ?? (receipt as any).uploaderUserId
        ?? (receipt as any).userId
        ?? null;
    let personalEquivProductIds = new Map<number, number[]>();
    const lineProductIds = Array.from(new Set(productIdByStoreProductId.values()));
    if (ownerUserId && lineProductIds.length) {
        try {
            personalEquivProductIds = await getPersonalEquivalentProductIds(
                String(ownerUserId),
                lineProductIds,
            );
        } catch (e) {
            console.warn(
                `[receiptComparison] personal-equivalence lookup failed for receipt ` +
                `${receiptId} (owner ${ownerUserId}); falling back to global-only. ` +
                `${(e as Error)?.message ?? e}`,
            );
            personalEquivProductIds = new Map();
        }
    }

    const baskets = await buildStoreBaskets(
        validItems,
        productIdByStoreProductId,
        allStores,
        currentStore.id,
        personalEquivProductIds,
        refFamilyByProduct,
    );

    const currentBasket = baskets.get(currentStore.id)!;

    // Receipt-level combo/set-deal discount (footer.comboDiscount, e.g. IKI's bare
    // "RINKINYS -1,90"): the VISITED store's real paid total is that much lower than the
    // line sum. Applied to the visited basket ONLY — whether another chain runs the same
    // set deal is unknown, so alternatives stay conservative (mirrors the promo-imputation
    // reasoning above). Without this the visited chain looks ~comboDiscount more expensive
    // than reality (receipt-229: 4.03 vs true 2.13 → "IKI most expensive").
    const comboRaw = Number(parsedData?.footer?.comboDiscount);
    const comboDiscount = Number.isFinite(comboRaw) && comboRaw > 0
        ? Math.min(round2(comboRaw), currentBasket.total)
        : 0;
    if (comboDiscount > 0) currentBasket.total = round2(currentBasket.total - comboDiscount);

    const alternatives: ComparisonChainResult[] = alternativeStores.map((altStore) => {
        const b = baskets.get(altStore.storeId)!;
        return {
            chainId: altStore.chainId,
            chainName: altStore.chainName,
            storeId: altStore.storeId,
            storeName: altStore.storeName,
            storeAddress: altStore.storeAddress,
            distanceKm: altStore.distance,
            total: b.total,
            savings: round2(currentBasket.total - b.total),
            knownItems: b.knownItems,
            imputedItems: b.imputedItems,
            flatItems: b.flatItems,
            note: b.imputedItems > 0
                ? `${b.imputedItems} produktų įvertinta apytiksliai`
                : undefined,
            chainLogoUrl: altStore.chainLogoUrl,
        };
    });

    alternatives.sort((a, b) => a.total - b.total);

    return {
        currentChain: {
            chainId: currentStore.chainId,
            chainName: currentStore.chainName,
            storeId: currentStore.id,
            storeName: currentStore.name,
            storeAddress: currentStore.address,
            total: currentBasket.total,
            knownItems: currentBasket.knownItems,
            imputedItems: currentBasket.imputedItems,
            flatItems: currentBasket.flatItems,
            // Additive: the applied combo/set-deal discount, so the UI can annotate the row
            // ("įsk. rinkinio nuolaidą −1,90 €"). Absent/0 on receipts without one.
            comboDiscount: comboDiscount > 0 ? comboDiscount : undefined,
            chainLogoUrl: currentStore.logoUrl || null,
        },
        alternatives,
        summary: {
            recognizedItems,
            unrecognizedItems,
            invalidItems,
            note: invalidItems > 0
                ? `${invalidItems} kvito eilučių praleista dėl netinkamų duomenų. Patikrinkite kvitą.`
                : undefined,
        },
    };
};
