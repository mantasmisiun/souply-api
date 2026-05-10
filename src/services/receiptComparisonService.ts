import pool from '../config/db.js';
import { getReceiptById } from '../models/receiptModel.js';
import { getStoreById, getClosestStorePerChainToStore, ClosestChainStore } from '../models/storeModel.js';

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
             SELECT storeProductId, storeId, price, promoPrice,
                    ROW_NUMBER() OVER (PARTITION BY storeProductId, storeId ORDER BY id DESC) AS rn
             FROM Price
             WHERE storeId IN (?)
               AND priceVerified = 1
         ) lp ON lp.storeProductId = sp.id AND lp.rn = 1
         WHERE sp.productId IN (?)`,
        [storeIds, productIds]
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
    const packsNeeded = Math.ceil(normalizedQty / best.normalizedAmount);
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
    const altStoreIds = allStores
        .filter(s => s.storeId !== currentStoreId)
        .map(s => s.storeId);
    const priceCache = await batchGetLatestVerifiedPricesForStores(recognizedProductIds, altStoreIds);

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
            const options = priceCache.get(store.storeId)?.get(productId!) ?? [];
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

export const getReceiptComparison = async (receiptId: number) => {
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
    const alternativeStores = closestPerChain.filter((s) => s.chainId !== currentStore.chainId);

    const currentStoreForCalc: ClosestChainStore = {
        storeId: currentStore.id,
        storeName: currentStore.name,
        storeAddress: currentStore.address,
        chainId: currentStore.chainId,
        chainName: currentStore.chainName,
        chainLogoUrl: currentStore.logoUrl || null,
        distance: 0,
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
    if (recognizedStoreProductIds.length) {
        const [spRows]: any = await pool.query(
            `SELECT id, productId FROM StoreProduct WHERE id IN (?)`,
            [recognizedStoreProductIds]
        );
        for (const row of spRows) {
            productIdByStoreProductId.set(Number(row.id), Number(row.productId));
        }
    }

    const baskets = await buildStoreBaskets(
        validItems,
        productIdByStoreProductId,
        allStores,
        currentStore.id,
    );

    const currentBasket = baskets.get(currentStore.id)!;

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
