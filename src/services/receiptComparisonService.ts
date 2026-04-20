import pool from '../config/db';
import { getReceiptById } from '../models/receiptModel';
import { getStoreById, getClosestStorePerChainToStore, ClosestChainStore } from '../models/storeModel';

interface RecognizedReceiptItem {
    storeProductId: number;
    quantity: number;
    unit: string | null;
}

interface ChainTotalResult {
    total: number;
    comparedItems: number;
    missingItems: number;
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
    comparedItems: number;
    missingItems: number;
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
                p.price, p.promoPrice, p.isFallback
         FROM StoreProduct sp
         JOIN (
             SELECT p1.storeProductId, p1.price, p1.promoPrice, p1.isFallback
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

const calculateChainTotal = async (
    targetStore: ClosestChainStore,
    recognizedItems: RecognizedReceiptItem[],
    productIdByStoreProductId: Map<number, number>
): Promise<ChainTotalResult> => {
    let total = 0;
    let comparedItems = 0;
    let missingItems = 0;

    for (const item of recognizedItems) {
        const productId = productIdByStoreProductId.get(item.storeProductId);
        if (!productId) {
            missingItems++;
            continue;
        }

        const itemTotal = await calculateItemTotalAtStore(
            productId,
            item.quantity,
            item.unit,
            targetStore.storeId,
            targetStore.chainId
        );

        if (itemTotal === null) {
            missingItems++;
            continue;
        }

        total += itemTotal;
        comparedItems++;
    }

    return {
        total: round2(total),
        comparedItems,
        missingItems,
    };
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

    const products = Array.isArray(parsedData?.products) ? parsedData.products : [];

    const recognizedItems: RecognizedReceiptItem[] = products
        .filter((p: any) => !!p?.matchConfirmed && Number(p?.storeProductId) > 0 && Number(p?.quantity) > 0)
        .map((p: any) => ({
            storeProductId: Number(p.storeProductId),
            quantity: Number(p.quantity),
            unit: p.unit ?? null,
        }));

    const excludedItems = products.length - recognizedItems.length;

    if (!recognizedItems.length) {
        return {
            currentChain: { total: 0 },
            alternatives: [],
            summary: {
                recognizedItems: 0,
                excludedItems,
                note: 'Review receipt items to improve comparison accuracy.',
            },
        };
    }

    const [currentStoreRows] = await getStoreById(receipt.storeId);
    const currentStore = currentStoreRows;
    if (!currentStore) {
        const err = new Error('Visited store not found');
        (err as any).statusCode = 404;
        throw err;
    }

    const closestPerChain = await getClosestStorePerChainToStore(receipt.storeId);
    const alternativeStores = closestPerChain.filter((s) => s.chainId !== currentStore.chainId);

    const sourceStoreProductIds = Array.from(new Set(recognizedItems.map((i) => i.storeProductId)));
    const [spRows]: any = await pool.query(
        `SELECT id, productId FROM StoreProduct WHERE id IN (?)`,
        [sourceStoreProductIds]
    );

    const productIdByStoreProductId = new Map<number, number>();
    for (const row of spRows) {
        productIdByStoreProductId.set(Number(row.id), Number(row.productId));
    }

    const currentStoreForCalc: ClosestChainStore = {
        storeId: currentStore.id,
        storeName: currentStore.name,
        storeAddress: currentStore.address,
        chainId: currentStore.chainId,
        chainName: currentStore.chainName,
        chainLogoUrl: currentStore.logoUrl || null,
        distance: 0,
    };

    const currentTotals = await calculateChainTotal(currentStoreForCalc, recognizedItems, productIdByStoreProductId);

    const alternatives: ComparisonChainResult[] = [];
    for (const altStore of alternativeStores) {
        const totals = await calculateChainTotal(altStore, recognizedItems, productIdByStoreProductId);

        alternatives.push({
            chainId: altStore.chainId,
            chainName: altStore.chainName,
            storeId: altStore.storeId,
            storeName: altStore.storeName,
            storeAddress: altStore.storeAddress,
            distanceKm: altStore.distance,
            total: totals.total,
            savings: round2(currentTotals.total - totals.total),
            comparedItems: totals.comparedItems,
            missingItems: totals.missingItems,
            note: totals.missingItems > 0 ? `${totals.missingItems} products not compared` : undefined,
            chainLogoUrl: altStore.chainLogoUrl,
        });
    }

    alternatives.sort((a, b) => a.total - b.total);

    return {
        currentChain: {
            chainId: currentStore.chainId,
            chainName: currentStore.chainName,
            storeId: currentStore.id,
            storeName: currentStore.name,
            storeAddress: currentStore.address,
            total: currentTotals.total,
            comparedItems: currentTotals.comparedItems,
            missingItems: currentTotals.missingItems,
            chainLogoUrl: currentStore.logoUrl || null,
        },
        alternatives,
        summary: {
            recognizedItems: recognizedItems.length,
            excludedItems,
            note: excludedItems > 0
                ? 'Some items were excluded. Review receipt items for more accurate comparison.'
                : undefined,
        },
    };
};