import { getClosestStores } from '../models/storeModel.js';
import { getBasketProductIds } from '../models/basketModel.js';
import pool from '../config/db.js';

const USER_LAT = 55.91130643124872;
const USER_LNG = 23.24787565545356;

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
    storeProductId: number | null;
    /** When matchMode='base', which specific Product in the cluster we
     *  resolved to at this store (the cheapest-per-unit one). NULL when
     *  missing or matchMode='sku'. */
    resolvedProductId: number | null;
}

/**
 * Compare a basket's per-store total across the 10 closest stores.
 *
 * For each BasketItem, the resolution depends on its matchMode:
 *   'sku'  — only this Product's StoreProducts at the store's chain are
 *            considered; cheapest per-unit wins.
 *   'base' — the cluster is expanded (head + variants), ALL StoreProducts
 *            from any cluster member at this chain compete for cheapest-
 *            per-unit. The winning Product id is reported back via
 *            resolvedProductId.
 *
 * When no SP at this chain has a priced row, the item is flagged MISSING
 * at that store — it contributes 0 to the total but is surfaced to the
 * user via `missingItemNames`. Stores are sorted: fewest missing first,
 * then by total ascending.
 */
export const calculateBasketForStores = async (basketId: number): Promise<StoreResult[]> => {
    const stores = await getClosestStores(USER_LAT, USER_LNG, 10);
    const basketItems = await getBasketProductIds(basketId);

    if (!basketItems.length) return [];

    const results: StoreResult[] = [];

    for (const store of stores) {
        const itemResults: ItemResult[] = [];
        const missingItemNames: string[] = [];
        let total = 0;
        let isApproximated = false;

        for (const basketItem of basketItems) {
            const matchMode: MatchMode =
                basketItem.matchMode === 'base' ? 'base' : 'sku';

            const itemResult = await calculateItemPrice(
                basketItem.productId,
                parseFloat(basketItem.quantity),
                basketItem.name,
                matchMode,
                store.id,
                store.chainId
            );

            itemResults.push(itemResult);

            if (itemResult.isMissing) {
                missingItemNames.push(itemResult.productName);
            } else if (itemResult.totalPrice !== null) {
                total += itemResult.totalPrice;
            }

            if (itemResult.isFallback) isApproximated = true;
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
            missingItemNames,
            items: itemResults,
        });
    }

    // Fewest missing first, then cheapest total. A full-coverage store at
    // €30 beats a partial-coverage store at €25 with 2 missing — the user
    // can't actually buy those 2 items there.
    return results.sort((a, b) => {
        if (a.missingItemNames.length !== b.missingItemNames.length) {
            return a.missingItemNames.length - b.missingItemNames.length;
        }
        return a.total - b.total;
    });
};

const calculateItemPrice = async (
    productId: number,
    userQuantity: number,
    productName: string,
    matchMode: MatchMode,
    storeId: number,
    chainId: number
): Promise<ItemResult> => {
    // Build the Product-scope filter:
    //   sku  → exactly this productId
    //   base → this productId (the cluster head) and every non-merged Product
    //           whose baseProductId points at it
    const productFilter =
        matchMode === 'base'
            ? `AND (prod.id = ? OR prod.baseProductId = ?) AND prod.mergedIntoId IS NULL`
            : `AND prod.id = ? AND prod.mergedIntoId IS NULL`;
    const productFilterParams =
        matchMode === 'base' ? [productId, productId] : [productId];

    const [spRows]: any = await pool.query(
        `SELECT sp.id, sp.productId AS resolvedProductId,
                sp.storeProductName, sp.isWeighable, sp.amount, sp.unit,
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

    const withPrices = (spRows as any[]).filter((r: any) => r.price !== null);

    if (!withPrices.length) {
        return missingAtStore(productId, productName, userQuantity, matchMode);
    }

    // Cheapest per unit across all cluster members' SPs (base mode) or just
    // this Product's SPs (sku mode).
    let bestOption: any = null;
    let bestPricePerUnit = Infinity;

    for (const sp of withPrices) {
        const effectivePrice = sp.promoPrice
            ? parseFloat(sp.promoPrice)
            : parseFloat(sp.price);
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

    // Normalize userQuantity to match the SP's unit. Same heuristic as the
    // pre-Phase-2 service: if user said "2" and SP is in grams, they meant
    // 2 kg = 2000 g; if user said "1500" and SP is in kg, they meant 1500 g
    // = 1.5 kg.
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
        matchMode,
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
        isMissing: false,
        isFallback: bestOption.isFallback === 1,
        storeProductId: bestOption.id,
        resolvedProductId:
            matchMode === 'base' ? Number(bestOption.resolvedProductId) : null,
    };
};

/** No SP with a price at this store/chain → item is missing here. */
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
        storeProductId: null,
        resolvedProductId: null,
    };
}
