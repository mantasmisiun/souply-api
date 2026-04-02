import { Request, Response } from 'express';
import { createProduct, searchProduct, getProductById, getProductsByCategory } from '../models/productModel';

export const addProduct = async (req: Request, res: Response) => {
    const { categoryId, baseProductId, name, imageUrl } = req.body;
    if (!categoryId || !name) {
        res.status(400).json({ error: 'Category ID and name are required' });
        return;
    }
    const id = await createProduct(categoryId, baseProductId || null, name, imageUrl || null);
    res.status(201).json({ id, categoryId, baseProductId, name, imageUrl });
};

export const searchProducts = async (req: Request, res: Response) => {
    const query = req.query.q as string;
    if (!query) {
        res.status(400).json({ error: 'Search query is required' });
        return;
    }
    const products = await searchProduct(query);
    res.json(products);
};

export const fetchProductById = async (req: Request, res: Response) => {
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
};

export const fetchProductsByCategory = async (req: Request, res: Response) => {
    const categoryId = Number(req.params.categoryId);
    if (isNaN(categoryId)) {
        res.status(400).json({ error: 'Invalid category ID' });
        return;
    }
    const products = await getProductsByCategory(categoryId);
    res.json(products);
};