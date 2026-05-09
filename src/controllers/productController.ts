import { Request, Response, NextFunction } from 'express';
import { createProduct, searchProduct, getProductById, getProductsByCategory, getProductsByCategoryWithAmounts, getAllProductsByL2WithAmounts } from '../models/productModel.js';

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
        const created = await getProductById(id);
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
        const products = await searchProduct(query);
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
        const product = await getProductById(id);
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
        const products = await getProductsByCategory(categoryId);
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
        const products = await getProductsByCategoryWithAmounts(categoryId, mode, userId);
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
        const products = await getAllProductsByL2WithAmounts(categoryId, mode, userId);
        res.json(products);
    } catch (error) {
        next(error);
    }
};