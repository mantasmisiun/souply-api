import { getClosestStores } from '../models/storeModel';
import { getBasketProductIds } from '../models/basketModel';

const USER_LAT = 55.91130643124872;
const USER_LNG = 23.24787565545356;

interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    chainId: number;
    distance: number;
    total: number;
    isApproximated: boolean;
    items: ItemResult[];
}

interface ItemResult {
    productId: number;
    productName: string;
    quantity: number;
    price: number | null;
    promoPrice: number | null;
    effectivePrice: number | null;
    isApproximated: boolean;
    isFallback: boolean;
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
                basketItem.quantity,
                basketItem.name,
                store.id,
                store.chainId
            );

            itemResults.push(itemResult);

            if (itemResult.effectivePrice !== null) {
                total += itemResult.effectivePrice * parseFloat(basketItem.quantity);
            }

            if (itemResult.isApproximated) isApproximated = true;
        }

        results.push({
            storeId: store.id,
            storeName: store.name,
            chainName: store.chainName,
            chainId: store.chainId,
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
    quantity: number,
    productName: string,
    storeId: number,
    chainId: number
): Promise<ItemResult> => {
    const pool = (await import('../config/db')).default;

    // Find StoreProduct for this product in this chain
    const [spRows]: any = await pool.query(
        `SELECT sp.id, sp.storeProductName
         FROM StoreProduct sp
         WHERE sp.productId = ? AND sp.chainId = ?
         LIMIT 1`,
        [productId, chainId]
    );

    if (!spRows.length) {
        // No StoreProduct in this chain — approximate using average from other stores
        const [avgRows]: any = await pool.query(
            `SELECT AVG(COALESCE(p.promoPrice, p.price)) as avgPrice
            FROM Price p
            JOIN StoreProduct sp ON p.storeProductId = sp.id
            JOIN Store s ON p.storeId = s.id
            JOIN (
                SELECT id FROM Store
                ORDER BY (
                    6371 * ACOS(
                        COS(RADIANS(?)) * COS(RADIANS(latitude)) *
                        COS(RADIANS(longitude) - RADIANS(?)) +
                        SIN(RADIANS(?)) * SIN(RADIANS(latitude))
                    )
                ) ASC LIMIT 10
            ) closest ON s.id = closest.id
            WHERE sp.productId = ?
            AND p.id = (
                SELECT MAX(p2.id) FROM Price p2
                WHERE p2.storeProductId = p.storeProductId
                AND p2.storeId = p.storeId
            )`,
            [55.91130643124872, 23.24787565545356, 55.91130643124872, productId]
        );

        const avgPrice = avgRows[0]?.avgPrice ? parseFloat(avgRows[0].avgPrice) : null;

        return {
            productId,
            productName,
            quantity,
            price: avgPrice,
            promoPrice: null,
            effectivePrice: avgPrice,
            isApproximated: true,
            isFallback: false,
        };
    }

    const storeProductId = spRows[0].id;

    // Get latest price for this StoreProduct in this store
    const [priceRows]: any = await pool.query(
        `SELECT price, promoPrice, isFallback
         FROM Price
         WHERE storeProductId = ? AND storeId = ?
         ORDER BY date DESC LIMIT 1`,
        [storeProductId, storeId]
    );

    if (!priceRows.length) {
        // No price for this store — calculate average from other stores
        const [avgRows]: any = await pool.query(
            `SELECT AVG(COALESCE(p.promoPrice, p.price)) as avgPrice
            FROM Price p
            JOIN StoreProduct sp ON p.storeProductId = sp.id
            JOIN Store s ON p.storeId = s.id
            JOIN (
                SELECT id FROM Store
                ORDER BY (
                    6371 * ACOS(
                        COS(RADIANS(?)) * COS(RADIANS(latitude)) *
                        COS(RADIANS(longitude) - RADIANS(?)) +
                        SIN(RADIANS(?)) * SIN(RADIANS(latitude))
                    )
                ) ASC LIMIT 10
            ) closest ON s.id = closest.id
            WHERE sp.productId = ?
            AND p.id = (
                SELECT MAX(p2.id) FROM Price p2
                WHERE p2.storeProductId = p.storeProductId
                AND p2.storeId = p.storeId
            )`,
            [55.91130643124872, 23.24787565545356, 55.91130643124872, productId]
        );
        const avgPrice = avgRows[0]?.avgPrice ? parseFloat(avgRows[0].avgPrice) : null;
        return {
            productId,
            productName,
            quantity,
            price: avgPrice,
            promoPrice: null,
            effectivePrice: avgPrice,
            isApproximated: true,
            isFallback: false,
        };
    }

    const price = parseFloat(priceRows[0].price);
    const promoPrice = priceRows[0].promoPrice ? parseFloat(priceRows[0].promoPrice) : null;
    const effectivePrice = promoPrice || price;

    return {
        productId,
        productName,
        quantity,
        price,
        promoPrice,
        effectivePrice,
        isApproximated: false,
        isFallback: priceRows[0].isFallback === 1,
    };
};