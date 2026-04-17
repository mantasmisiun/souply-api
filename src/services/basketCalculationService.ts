import { getClosestStores } from '../models/storeModel';
import { getBasketProductIds } from '../models/basketModel';
import pool from '../config/db';

const USER_LAT = 55.91130643124872;
const USER_LNG = 23.24787565545356;

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
    items: ItemResult[];
}

interface ItemResult {
    productId: number;
    productName: string;
    quantity: number;
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
    isApproximated: boolean;
    isFallback: boolean;
    storeProductId: number | null;
}

export const calculateBasketForStores = async (basketId: number): Promise<StoreResult[]> => {
    const stores = await getClosestStores(USER_LAT, USER_LNG, 10);
    const basketItems = await getBasketProductIds(basketId);

    if (!basketItems.length) return [];

    const results: StoreResult[] = [];

    for (const store of stores) {
        const itemResults: ItemResult[] = [];
        let total = 0;
        let isApproximated = false;

        for (const basketItem of basketItems) {
            const itemResult = await calculateItemPrice(
                basketItem.productId,
                parseFloat(basketItem.quantity),
                basketItem.name,
                store.id,
                store.chainId
            );

            itemResults.push(itemResult);

            if (itemResult.totalPrice !== null) {
                total += itemResult.totalPrice;
            }

            if (itemResult.isApproximated) isApproximated = true;
        }

        results.push({
            storeId: store.id,
            storeName: store.name,
            chainName: store.chainName,
            chainId: store.chainId,
            chainLogoUrl: store.logoUrl || null,
            storeAddress: store.address,
            distance: parseFloat(store.distance.toFixed(2)),
            total: Math.round(total * 100) / 100,
            isApproximated,
            items: itemResults,
        });
    }

    return results.sort((a, b) => a.total - b.total);
};

const calculateItemPrice = async (
    productId: number,
    userQuantity: number,
    productName: string,
    storeId: number,
    chainId: number
): Promise<ItemResult> => {

    const [spRows]: any = await pool.query(
        `SELECT sp.id, sp.storeProductName, sp.isWeighable, sp.amount, sp.unit,
                p.price, p.promoPrice, p.isFallback
         FROM StoreProduct sp
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
         WHERE sp.productId = ? AND sp.chainId = ?`,
        [storeId, productId, chainId]
    );

    if (!spRows.length) {
        return approximatePrice(productId, productName, userQuantity);
    }

    const withPrices = spRows.filter((r: any) => r.price !== null);

    if (!withPrices.length) {
        return approximatePrice(productId, productName, userQuantity);
    }

    // Find the cheapest option per unit
    let bestOption: any = null;
    let bestPricePerUnit = Infinity;

    for (const sp of withPrices) {
        const effectivePrice = sp.promoPrice ? parseFloat(sp.promoPrice) : parseFloat(sp.price);
        const amount = sp.amount ? parseFloat(sp.amount) : 1;
        const pricePerUnit = effectivePrice / amount;

        if (pricePerUnit < bestPricePerUnit) {
            bestPricePerUnit = pricePerUnit;
            bestOption = { ...sp, effectivePrice };
        }
    }

    const effectivePrice = bestOption.effectivePrice;
    const spAmount = bestOption.amount ? parseFloat(bestOption.amount) : 1;
    const spUnit = bestOption.unit;
    const isWeighable = bestOption.isWeighable === 1 || bestOption.isWeighable === true;

    // Normalize userQuantity to match StoreProduct unit
    let normalizedQuantity = userQuantity;
    if (spUnit === 'g' && userQuantity < 10) {
        normalizedQuantity = userQuantity * 1000;
    } else if (spUnit === 'kg' && userQuantity > 10) {
        normalizedQuantity = userQuantity / 1000;
    }

    let packsNeeded: number;
    let actualAmount: number;
    let totalPrice: number;

    if (isWeighable) {
        packsNeeded = 1;
        actualAmount = normalizedQuantity;
        totalPrice = normalizedQuantity * bestPricePerUnit;
    } else {
        packsNeeded = Math.ceil(normalizedQuantity / spAmount);
        actualAmount = packsNeeded * spAmount;
        totalPrice = packsNeeded * effectivePrice;
    }

    totalPrice = Math.round(totalPrice * 100) / 100;

    return {
        productId,
        productName,
        quantity: userQuantity,
        storeProductName: bestOption.storeProductName,
        storeProductAmount: spAmount,
        storeProductUnit: spUnit,
        packsNeeded,
        actualAmount,
        price: parseFloat(bestOption.price),
        promoPrice: bestOption.promoPrice ? parseFloat(bestOption.promoPrice) : null,
        effectivePrice,
        totalPrice,
        isWeighable,
        isApproximated: false,
        isFallback: bestOption.isFallback === 1,
        storeProductId: bestOption.id,
    };
};

const approximatePrice = async (
    productId: number,
    productName: string,
    userQuantity: number
): Promise<ItemResult> => {
    // Get all StoreProducts with their latest prices from the 10 closest stores
    const [rows]: any = await pool.query(
        `SELECT sp.amount, sp.unit, sp.isWeighable,
            COALESCE(p.promoPrice, p.price) as effectivePrice,
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
        [USER_LAT, USER_LNG, USER_LAT, productId]
    );

    if (!rows.length) {
        return {
            productId, productName, quantity: userQuantity,
            storeProductName: null, storeProductAmount: null, storeProductUnit: null,
            packsNeeded: null, actualAmount: null,
            price: null, promoPrice: null, effectivePrice: null, totalPrice: null,
            isWeighable: false, isApproximated: true, isFallback: false, storeProductId: null,
        };
    }

    // Group by storeId, find cheapest per kg in each store
    const storeMap = new Map<number, number>(); // storeId → cheapest pricePerKg

    for (const row of rows) {
        const price = parseFloat(row.effectivePrice);
        const amount = row.amount ? parseFloat(row.amount) : 1;
        const unit = row.unit;
        const storeId = row.storeId;

        let pricePerKg: number;
        if (row.isWeighable) {
            pricePerKg = price;
        } else if (unit === 'g') {
            pricePerKg = (price / amount) * 1000;
        } else if (unit === 'kg') {
            pricePerKg = price / amount;
        } else {
            pricePerKg = price;
        }

        const current = storeMap.get(storeId);
        if (current === undefined || pricePerKg < current) {
            storeMap.set(storeId, pricePerKg);
        }
    }

    let totalPricePerKg = 0;
    for (const pricePerKg of storeMap.values()) {
        totalPricePerKg += pricePerKg;
    }
    const count = storeMap.size;
    const avgPricePerKg = totalPricePerKg / count;

    // Normalize user quantity to kg
    let userKg = userQuantity;
    if (userQuantity > 10) {
        userKg = userQuantity / 1000; // user entered grams
    }

    const totalPrice = Math.round(avgPricePerKg * userKg * 100) / 100;

    return {
        productId,
        productName,
        quantity: userQuantity,
        storeProductName: null,
        storeProductAmount: null,
        storeProductUnit: null,
        packsNeeded: null,
        actualAmount: null,
        price: Math.round(avgPricePerKg * 100) / 100,
        promoPrice: null,
        effectivePrice: Math.round(avgPricePerKg * 100) / 100,
        totalPrice,
        isWeighable: false,
        isApproximated: true,
        isFallback: false,
        storeProductId: null,
    };
};