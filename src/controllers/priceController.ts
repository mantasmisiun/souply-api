import { Request, Response, NextFunction } from 'express';
import { createPrice, getLatestPriceByStoreProduct, getLatestPricesAcrossStores, getActivePromoPrices, getPriceHistoryForStoreProduct } from '../models/priceModel';

export const addPrice = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { storeProductId, storeId, price, promoPrice, promoEnd, isFallback, date, priceVerified, receiptId } = req.body;

        if (!storeProductId || !storeId || !price || !date) {
            res.status(400).json({ error: 'storeProductId, storeId, price and date are required' });
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