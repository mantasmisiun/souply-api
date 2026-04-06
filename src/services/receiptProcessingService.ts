import { getStoreChainByName, createStoreChain } from '../models/storeChainModel';
import { getStoreByNameAndAddress, createStore } from '../models/storeModel';
import { getStoreProductByNameAndChain, createStoreProduct } from '../models/storeProductModel';
import { createProduct, getProductByName } from '../models/productModel';
import { createPrice } from '../models/priceModel';
import { updateReceiptDetails } from '../models/receiptModel';
import { getAllCategories } from '../models/categoryModel';
import { assignCategoriesToProducts } from './ocrService';

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

    // Step 3 — Assign categories to all items in one gemma4 call
    const categories = await getAllCategories();
    const assignments = await assignCategoriesToProducts(parsedData.items, categories);

    // Step 4 — Process each item
    for (const item of parsedData.items) {
        const assignment = assignments.find(a => a.index === parsedData.items.indexOf(item));
        const categoryId = assignment?.categoryId ?? null;

        // Find or create StoreProduct
        let storeProduct = await getStoreProductByNameAndChain(item.name, chain.id);

        if (!storeProduct) {
            let baseProductName = item.name;
            let baseProductId = null;

            if (item.brandName) {
                baseProductName = item.name
                    .replace(item.brandName, '')
                    .replace(/\s{2,}/g, ' ')
                    .replace(/,\s*,/g, ',')
                    .replace(/\.\s*,/g, ',')
                    .replace(/,\s*$/g, '')
                    .replace(/\.\s*$/g, '')
                    .trim();

                let baseProduct = await getProductByName(baseProductName);
                if (!baseProduct) {
                    const newBaseProductId = await createProduct(categoryId!, null, baseProductName, null, item.isWeighable);
                    baseProduct = { id: newBaseProductId };
                }
                baseProductId = baseProduct.id;
            }

            const productId = await createProduct(categoryId!, baseProductId, item.name, null, item.isWeighable);
            const storeProductId = await createStoreProduct(productId, chain.id, item.name, item.brandName || null);
            storeProduct = { id: storeProductId };
        }

        // Step 5 — Create Price entry
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
                true
            );
        } catch (error: any) {
            if (error.code !== 'ER_DUP_ENTRY') {
                throw error;
            }
        }
    }

    // Step 6 — Update receipt with extracted details
    await updateReceiptDetails(
        receiptId,
        parsedData.receiptNo,
        new Date(parsedData.date),
        'completed'
    );

    return { chainId: chain.id, storeId: store.id };
};