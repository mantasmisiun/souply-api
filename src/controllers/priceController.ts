import { Request, Response, NextFunction } from 'express';
import { createPrice, getLatestPriceByStoreProduct, getLatestPricesAcrossStores, getActivePromoPrices, getPriceHistoryForStoreProduct } from '../models/priceModel';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export const addPrice = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { storeProductId, storeId, userId, price, promoPrice, promoEnd, isFallback, date, priceVerified } = req.body;
        if (!storeProductId || !storeId || !price || !date) {
            res.status(400).json({ error: 'storeProductId, storeId, price and date are required' });
            return;
        }
        const resolvedUserId = userId || SYSTEM_USER_ID;
        const resolvedPriceVerified = resolvedUserId === SYSTEM_USER_ID ? true : (priceVerified || false);
        const id = await createPrice(
            storeProductId,
            storeId,
            resolvedUserId,
            price,
            promoPrice || null,
            promoEnd || null,
            isFallback || false,
            new Date(date),
            resolvedPriceVerified
        );
        res.status(201).json({ id, storeProductId, storeId, userId: resolvedUserId, price, promoPrice, promoEnd, date, isFallback, priceVerified: resolvedPriceVerified });
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
        const priceHistory = await getPriceHistoryForStoreProduct(storeProductId);
        res.json(priceHistory);
    } catch (error) {
        next(error);
    }
};