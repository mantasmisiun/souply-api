import { Request, Response, NextFunction } from 'express';
import { createProduct, searchProduct, getProductById, getProductsByCategory, getProductsByCategoryWithAmounts, getAllProductsByL2WithAmounts, getDiscountedProducts, getDiscountsSummaryUpdatedAt } from '../models/productModel.js';

export const addProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { categoryId, baseProductId, name } = req.body;
        if (!categoryId || !name) {
            res.status(400).json({ error: 'Category ID and name are required' });
            return;
        }
        const id = await createProduct(categoryId, baseProductId || null, name);
        // Re-read so the response reflects any baseProductId the model
        // auto-assigned when the caller passed null.
        const created = await getProductById(id, req.locale);
        res.status(201).json(created);
    } catch (error) {
        next(error);
    }
};

export const searchProducts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const query = req.query.q as string;
        if (!query) {
            res.status(400).json({ error: 'Search query is required' });
            return;
        }
        const products = await searchProduct(query, req.locale);
        res.json(products);
    } catch (error) {
        next(error);
    }
};

export const fetchProductById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid product ID' });
            return;
        }
        const product = await getProductById(id, req.locale);
        if (!product) {
            res.status(404).json({ error: 'Product not found' });
            return;
        }
        res.json(product);
    } catch (error) {
        next(error);
    }
};

export const fetchProductsByCategory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const categoryId = Number(req.params.categoryId);
        if (isNaN(categoryId)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const products = await getProductsByCategory(categoryId, req.locale);
        res.json(products);
    } catch (error) {
        next(error);
    }
};

const parseMode = (raw: unknown): 'base' | 'sku' => (raw === 'sku' ? 'sku' : 'base');

export const fetchProductsByCategoryWithAmounts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const categoryId = Number(req.params.categoryId);
        if (isNaN(categoryId)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const mode = parseMode(req.query.mode);
        const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
        const products = await getProductsByCategoryWithAmounts(categoryId, mode, userId, req.locale);
        res.json(products);
    } catch (error) {
        next(error);
    }
};

export const fetchAllProductsByL2WithAmounts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const categoryId = Number(req.params.categoryId);
        if (isNaN(categoryId)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const mode = parseMode(req.query.mode);
        const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
        const products = await getAllProductsByL2WithAmounts(categoryId, mode, userId, req.locale);
        res.json(products);
    } catch (error) {
        next(error);
    }
};

export const fetchDiscountedProducts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const l2CategoryId = req.query.l2CategoryId ? Number(req.query.l2CategoryId) : undefined;
        const search = typeof req.query.search === 'string' && req.query.search.trim()
            ? req.query.search.trim()
            : undefined;
        const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : undefined;
        const offset = req.query.offset ? Number(req.query.offset) : 0;

        // Weak ETag from summary's last refresh + filter params. Same input,
        // same hash; any scrape/cron refresh bumps it. Lets the client skip
        // the JSON body on pull-to-refresh when nothing has changed.
        const ts = await getDiscountsSummaryUpdatedAt();
        // Locale is part of the key: EN and LT bodies differ (names/images), so
        // they must never share a cache entry.
        const etag = `W/"d-${ts}-${req.locale}-${l2CategoryId ?? ''}-${search ?? ''}-${limit ?? ''}-${offset}"`;
        if (req.headers['if-none-match'] === etag) {
            res.status(304).end();
            return;
        }

        const products = await getDiscountedProducts({ l2CategoryId, search, limit, offset, locale: req.locale });
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
        res.json(products);
    } catch (error) {
        next(error);
    }
};