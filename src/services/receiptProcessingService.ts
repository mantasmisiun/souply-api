import { getStoreChainByName, createStoreChain } from '../models/storeChainModel';
import { getStoreByNameAndAddress, createStore } from '../models/storeModel';
import { getStoreProductByNameAndChain, createStoreProduct } from '../models/storeProductModel';
import { createProduct, getProductByName } from '../models/productModel';
import { createPrice } from '../models/priceModel';
import { updateReceiptDetails } from '../models/receiptModel';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export const processReceipt = async (receiptId: number, parsedData: any) => {
    // Step 1 — Find or create StoreChain
    let chain = await getStoreChainByName(parsedData.chainName);
    if (!chain) {
        const chainId = await createStoreChain(parsedData.chainName, null);
        chain = { id: chainId, name: parsedData.chainName };
    }

    // Step 2 — Find or create Store
    let store = await getStoreByNameAndAddress(parsedData.storeName, parsedData.storeAddress);
    if (!store) {
        const storeId = await createStore(chain.id, parsedData.storeName, parsedData.storeAddress, 0, 0);
        store = { id: storeId, name: parsedData.storeName };
    }

    // Step 3 — Process each item
    for (const item of parsedData.items) {
        // Find or create StoreProduct
        let storeProduct = await getStoreProductByNameAndChain(item.name, chain.id);
        
        if (!storeProduct) {
            let baseProductName = item.name;
            let baseProductId = null;

            if (item.brandName) {
                // Calculate base product name by removing brand name
                baseProductName = item.name
                    .replace(item.brandName, '')
                    .replace(/\s{2,}/g, ' ')
                    .replace(/,\s*,/g, ',')
                    .replace(/\.\s*,/g, ',')
                    .replace(/,\s*$/g, '')
                    .replace(/\.\s*$/g, '')
                    .trim();

                // Find or create base product
                let baseProduct = await getProductByName(baseProductName);
                if (!baseProduct) {
                    const newBaseProductId = await createProduct(1, null, baseProductName, null, item.isWeighable);
                    baseProduct = { id: newBaseProductId };
                }
                baseProductId = baseProduct.id;
            }

            // Create product — if no brand, it IS the base product (baseProductId: null)
            const productId = await createProduct(1, baseProductId, item.name, null, item.isWeighable);
            const storeProductId = await createStoreProduct(productId, chain.id, item.name, item.brandName || null);
            storeProduct = { id: storeProductId };
        }

        // Step 4 — Create Price entry
        try {
            await createPrice(
                storeProduct.id,
                store.id,
                SYSTEM_USER_ID,
                item.price,
                item.promoPrice || null,
                null,
                false,
                new Date(parsedData.date),
                true // priceVerified true for system user
            );
        } catch (error: any) {
            // Skip duplicate prices
            if (error.code !== 'ER_DUP_ENTRY') {
                throw error;
            }
        }
    }

    // Step 5 — Update receipt with extracted details
    await updateReceiptDetails(
        receiptId,
        parsedData.receiptNo,
        new Date(parsedData.date),
        'completed'
    );

    return { chainId: chain.id, storeId: store.id };
};