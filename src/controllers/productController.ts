import { Request, Response, NextFunction } from 'express';
import { createProduct, searchProduct, getProductById, getProductsByCategory } from '../models/productModel';

export const addProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { categoryId, baseProductId, name, imageUrl, isWeighable } = req.body;
        if (!categoryId || !name) {
            res.status(400).json({ error: 'Category ID and name are required' });
            return;
        }
        const id = await createProduct(categoryId, baseProductId || null, name, imageUrl || null, isWeighable || false);
        res.status(201).json({ id, categoryId, baseProductId, name, imageUrl, isWeighable });
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