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

const getLatestVerifiedOptions = async (
    productId: number,
    storeId: number,
    chainId: number
) => {
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.storeProductName, sp.isWeighable, sp.amount, sp.unit,
                p.price, p.promoPrice
         FROM StoreProduct sp
         JOIN (
             SELECT p1.storeProductId, p1.price, p1.promoPrice
             FROM Price p1
             WHERE p1.storeId = ?
               AND p1.priceVerified = 1
               AND p1.id = (
                   SELECT MAX(p2.id)
                   FROM Price p2
                   WHERE p2.storeProductId = p1.storeProductId
                     AND p2.storeId = p1.storeId
                     AND p2.priceVerified = 1
               )
         ) p ON p.storeProductId = sp.id
         WHERE sp.productId = ? AND sp.chainId = ?`,
        [storeId, productId, chainId]
    );
    return rows;
};

const calculateItemTotalAtStore = async (
    productId: number,
    quantity: number,
    inputUnit: string | null,
    storeId: number,
    chainId: number
): Promise<number | null> => {
    const options = await getLatestVerifiedOptions(productId, storeId, chainId);
    if (!options.length) return null;

    let best: any = null;
    let bestPricePerUnit = Infinity;

    for (const option of options) {
        const effectivePrice = option.promoPrice !== null ? parseFloat(option.promoPrice) : parseFloat(option.price);
        const amount = option.amount ? parseFloat(option.amount) : 1;
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const pricePerUnit = effectivePrice / amount;
        if (pricePerUnit < bestPricePerUnit) {
            bestPricePerUnit = pricePerUnit;
            best = { ...option, effectivePrice, amount };
        }
    }

    if (!best) return null;

    const isWeighable = best.isWeighable === 1 || best.isWeighable === true;
    const normalizedQty = normalizeQuantityToStoreUnit(quantity, inputUnit, best.unit);

    if (!Number.isFinite(normalizedQty) || normalizedQty <= 0) return null;

    if (isWeighable) {
        return round2(normalizedQty * bestPricePerUnit);
    }

    const packsNeeded = Math.ceil(normalizedQty / best.amount);
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

    for (const item of items) {
        if (!(item.price > 0) || !(item.quantity > 0)) continue;

        // Use promoPrice (what the user actually paid) when present; otherwise price.
        const effectiveUnitPrice = item.promoPrice !== null && item.promoPrice > 0
            ? item.promoPrice
            : item.price;
        const lineTotal = round2(effectiveUnitPrice * item.quantity);
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

        const known = new Map<number, number>();
        known.set(currentStoreId, lineTotal);

        for (const store of allStores) {
            if (store.storeId === currentStoreId) continue;
            const t = await calculateItemTotalAtStore(
                productId!,
                item.quantity,
                item.unit,
                store.storeId,
                store.chainId,
            );
            if (t !== null) {
                known.set(store.storeId, t);
            }
        }

        const values = Array.from(known.values());
        const imputed = round2(values.reduce((a, b) => a + b, 0) / values.length);

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

    const [currentStore] = await getStoreById(receipt.storeId);
    if (!currentStore) {
        const err = new Error('Visited store not found');
        (err as any).statusCode = 404;
        throw err;
    }

    const closestPerChain = await getClosestStorePerChainToStore(receipt.storeId);
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
