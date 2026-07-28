import { Request, Response, NextFunction } from 'express';
import { createPrice, getLatestPriceByStoreProduct, getLatestPricesAcrossStores, getActivePromoPrices, getPriceHistoryForStoreProduct, getPriceHistoryForStoreProductAllStores, getPriceHistoryForStoreProductsAllStores } from '../models/priceModel.js';
import { getChainIdByStoreId } from '../models/storeModel.js';
import { getChainIdByStoreProductId } from '../models/storeProductModel.js';

export const addPrice = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { storeProductId, storeId, price, promoPrice, promoEnd, isFallback, date, priceVerified, receiptId } = req.body;

        if (!storeProductId || !storeId || !price || !date) {
            res.status(400).json({ error: 'storeProductId, storeId, price and date are required' });
            return;
        }
        const storeChainId = await getChainIdByStoreId(storeId);
        const productChainId = await getChainIdByStoreProductId(storeProductId);

        if (!storeChainId || !productChainId || storeChainId !== productChainId) {
            res.status(400).json({ error: 'Store and StoreProduct do not belong to the same chain' });
            return;
        }
        try {
            const id = await createPrice(
                storeProductId,
                storeId,
                price,
                promoPrice || null,
                promoEnd || null,
                isFallback || false,
                new Date(date),
                priceVerified || false,
                receiptId || null
            );

            // Propagate fallback prices to other stores in the same chain
            if (!isFallback) {
                const chainId = await getChainIdByStoreId(storeId);
                if (chainId) {
                    const { propagateFallbackPrices } = await import('../services/priceService.js');
                    await propagateFallbackPrices(
                        storeProductId,
                        storeId,
                        chainId,
                        price,
                        promoPrice || null,
                        new Date(date),
                        receiptId || null
                    );
                }
            }

            res.status(201).json({ id, storeProductId, storeId, price, promoPrice, promoEnd, date, isFallback, priceVerified, receiptId });
        } catch (error: any) {
            if (error.code === 'ER_DUP_ENTRY') {
                res.status(409).json({ error: 'Price entry already exists for this store product, store and date' });
                return;
            }
            throw error;
        }
    } catch (error) {
        next(error);
    }
};

export const fetchLatestPriceByStoreProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const storeProductId = Number(req.params.storeProductId);
        if (isNaN(storeProductId)) {
            res.status(400).json({ error: 'Invalid store product ID' });
            return;
        }
        const price = await getLatestPriceByStoreProduct(storeProductId);
        if (!price) {
            res.status(404).json({ error: 'Price not found for this store product' });
            return;
        }
        res.json(price);
    } catch (error) {
        next(error);
    }
};

export const fetchLatestPricesAcrossStores = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const productId = Number(req.params.productId);
        if (isNaN(productId)) {
            res.status(400).json({ error: 'Invalid product ID' });
            return;
        }
        const prices = await getLatestPricesAcrossStores(productId);
        res.json(prices);
    } catch (error) {
        next(error);
    }
};

export const fetchActivePromoPrices = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const prices = await getActivePromoPrices();
        res.json(prices);
    } catch (error) {
        next(error);
    }
};

export const fetchPriceHistoryForStoreProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const storeProductId = Number(req.params.storeProductId);
        if (isNaN(storeProductId)) {
            res.status(400).json({ error: 'Invalid store product ID' });
            return;
        }
        const storeId = Number(req.params.storeId);
        if (isNaN(storeId)) {
            res.status(400).json({ error: 'Invalid store ID' });
            return;
        }
        const priceHistory = await getPriceHistoryForStoreProduct(storeProductId, storeId);
        res.json(priceHistory);
    } catch (error) {
        next(error);
    }
};

export const fetchPriceHistoryAllStores = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const storeProductId = Number(req.params.storeProductId);
        if (isNaN(storeProductId)) {
            res.status(400).json({ error: 'Invalid store product ID' });
            return;
        }
        const history = await getPriceHistoryForStoreProductAllStores(storeProductId);
        res.json(history);
    } catch (error) {
        next(error);
    }
};

/** Max storeProductIds per bulk history request. Product detail needs 15-30
 *  (one per chain sibling SP); 50 gives headroom without opening a DoS-sized
 *  IN list on the unauthenticated price surface. */
export const BULK_HISTORY_MAX_IDS = 50;

/**
 * GET /prices/store-products/history?spIds=1,2,3 — bulk variant of the
 * single-SP history endpoint (perf audit #13): the product-detail screen used
 * to fire one request per store product, serially. Same (public) auth posture
 * and the same element shape as the single endpoint; response is
 * `{ histories: { [storeProductId]: rows[] } }` with a key for EVERY
 * requested id (empty array when the SP has no prices).
 */
export const fetchPriceHistoryBulk = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const raw = typeof req.query.spIds === 'string' ? req.query.spIds : '';
        const tokens = raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
        if (tokens.length === 0) {
            res.status(400).json({ error: 'spIds query parameter is required (comma-separated store product ids)' });
            return;
        }
        const ids = [...new Set(tokens.map(Number))];
        if (ids.some(n => !Number.isInteger(n) || n <= 0)) {
            res.status(400).json({ error: 'spIds must be a comma-separated list of positive integer store product ids' });
            return;
        }
        if (ids.length > BULK_HISTORY_MAX_IDS) {
            res.status(400).json({ error: `Too many store product ids: ${ids.length} (max ${BULK_HISTORY_MAX_IDS} per request)` });
            return;
        }
        const histories = await getPriceHistoryForStoreProductsAllStores(ids);
        res.json({ histories });
    } catch (error) {
        next(error);
    }
};