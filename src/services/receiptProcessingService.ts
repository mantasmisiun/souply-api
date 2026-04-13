import { getStoreChainByName, createStoreChain } from '../models/storeChainModel';
import { getStoreByNameAndAddress, createStore } from '../models/storeModel';
import { getStoreProductByNameAndChain, createStoreProduct } from '../models/storeProductModel';
import { createProduct } from '../models/productModel';
import { createPrice } from '../models/priceModel';
import { updateReceiptDetails, updateReceiptStore } from '../models/receiptModel';
import { getAllCategories } from '../models/categoryModel';
import { assignCategoriesToProducts } from './ocrService';
import { propagateFallbackPrices } from './priceService';
import pool from '../config/db';

export const processReceipt = async (receiptId: number, parsedData: any) => {
    const connection = await (pool as any).getConnection();

    try {
        await connection.beginTransaction();

        // Step 1 — Find or create StoreChain
        let chain = await getStoreChainByName(parsedData.chainName, connection);
        if (!chain) {
            const chainId = await createStoreChain(parsedData.chainName, null, connection);
            chain = { id: chainId, name: parsedData.chainName };
        }

        // Step 2 — Find or create Store
        let store = await getStoreByNameAndAddress(parsedData.storeName, parsedData.storeAddress, connection);
        if (!store) {
            const storeId = await createStore(chain.id, parsedData.storeName, parsedData.storeAddress, 0, 0, connection);
            store = { id: storeId, name: parsedData.storeName };
        }

        // Step 3 — Assign categories (outside transaction — read only)
        const categories = await getAllCategories();
        const assignments = await assignCategoriesToProducts(parsedData.items, categories);

        // Step 4 — Process each item
        for (const item of parsedData.items) {
            if (!item.price) {
                throw new Error(`Produkto "${item.name}" kaina nenurodyta`);
            }

            const assignment = assignments.find(a => a.index === parsedData.items.indexOf(item));
            const categoryId = assignment?.categoryId ?? null;

            let storeProduct = await getStoreProductByNameAndChain(item.name, chain.id, connection);

            if (!storeProduct) {
                const productId = await createProduct(categoryId!, null, item.name, null, item.isWeighable, connection);
                const storeProductId = await createStoreProduct(productId, chain.id, item.name, item.brandName || null, connection);
                storeProduct = { id: storeProductId };
            }

            try {
                await createPrice(
                    storeProduct.id,
                    store.id,
                    item.price,
                    item.promoPrice || null,
                    null,
                    false,
                    new Date(parsedData.date),
                    true,
                    receiptId,
                    connection
                );
            } catch (error: any) {
                if (error.code !== 'ER_DUP_ENTRY') {
                    throw error;
                }
            }

            // Propagate fallback prices to other stores in the same chain
            await propagateFallbackPrices(
                storeProduct.id,
                store.id,
                chain.id,
                item.price,
                item.promoPrice || null,
                new Date(parsedData.date)
            );
        }

        // Step 5 — Update receipt
        await updateReceiptDetails(receiptId, parsedData.receiptNo, new Date(parsedData.date), 'completed', undefined, connection);
        await updateReceiptStore(receiptId, store.id, connection);

        await connection.commit();
        return { chainId: chain.id, storeId: store.id };

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

export const processReceiptManual = async (receiptId: number, parsedData: any) => {
    const connection = await (pool as any).getConnection();

    try {
        await connection.beginTransaction();

        // Step 1 — Find or create StoreChain
        let chain = await getStoreChainByName(parsedData.chainName, connection);
        if (!chain) {
            const chainId = await createStoreChain(parsedData.chainName, null, connection);
            chain = { id: chainId, name: parsedData.chainName };
        }

        // Step 2 — Find or create Store
        let store = await getStoreByNameAndAddress(parsedData.storeName, parsedData.storeAddress, connection);
        if (!store) {
            const storeId = await createStore(chain.id, parsedData.storeName, parsedData.storeAddress, 0, 0, connection);
            store = { id: storeId, name: parsedData.storeName };
        }

        // Step 3 — Process each item using user-provided categoryId
        for (const item of parsedData.items) {
            if (!item.price) {
                throw new Error(`Produkto "${item.name}" kaina nenurodyta`);
            }

            const categoryId = item.categoryId;
            if (!categoryId) {
                throw new Error(`Produkto "${item.name}" kategorija nenurodyta`);
            }

            let storeProduct = await getStoreProductByNameAndChain(item.name, chain.id, connection);

            if (!storeProduct) {
                const productId = await createProduct(categoryId, null, item.name, null, item.isWeighable, connection);
                const storeProductId = await createStoreProduct(productId, chain.id, item.name, item.brandName || null, connection);
                storeProduct = { id: storeProductId };
            }

            try {
                await createPrice(
                    storeProduct.id,
                    store.id,
                    item.price,
                    item.promoPrice || null,
                    null,
                    false,
                    new Date(parsedData.date),
                    true,
                    receiptId,
                    connection
                );
            } catch (error: any) {
                if (error.code !== 'ER_DUP_ENTRY') {
                    throw error;
                }
            }

            // Propagate fallback prices to other stores in the same chain
            await propagateFallbackPrices(
                storeProduct.id,
                store.id,
                chain.id,
                item.price,
                item.promoPrice || null,
                new Date(parsedData.date)
            );
        }

        // Step 4 — Update receipt
        await updateReceiptDetails(
            receiptId,
            parsedData.receiptNo,
            new Date(parsedData.date),
            'completed',
            parsedData,
            connection
        );
        await updateReceiptStore(receiptId, store.id, connection);

        await connection.commit();
        return { chainId: chain.id, storeId: store.id };

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};