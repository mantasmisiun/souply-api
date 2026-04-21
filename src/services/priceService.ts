import { createPrice, getPriceByStoreProductAndStore, updateFallbackPrice } from '../models/priceModel.js';
import { getStoresByChainId } from '../models/storeModel.js';

export const propagateFallbackPrices = async (
    storeProductId: number,
    sourceStoreId: number,
    chainId: number,
    price: number,
    promoPrice: number | null,
    date: Date
): Promise<void> => {
    // Get all other stores in the same chain
    const stores = await getStoresByChainId(chainId);
    const otherStores = stores.filter((s: any) => s.id !== sourceStoreId);

    for (const store of otherStores) {
        const existingPrice = await getPriceByStoreProductAndStore(storeProductId, store.id);

        if (!existingPrice) {
            // No price exists — insert fallback
            await createPrice(
                storeProductId,
                store.id,
                price,
                promoPrice,
                null,
                true,
                date,
                false,
                null
            );
        } else if (existingPrice.isFallback === 1) {
            // Existing fallback price — update it
            await updateFallbackPrice(existingPrice.id, price, promoPrice, date);
        }
        // isFallback === 0 → skip
    }
};