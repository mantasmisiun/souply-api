import { Request, Response } from 'express';
import { createStoreProduct, getStoreProductsByProductId, getStoreProductsByStoreId, getStoreProductByName } from '../models/storeProductModel';

export const addStoreProduct = async (req: Request, res: Response) => {
    const { productId, storeId, storeProductName } = req.body;
    if (!productId || !storeId || !storeProductName) {
        res.status(400).json({ error: 'All fields are required' });
        return;
    }
    const id = await createStoreProduct(productId, storeId, storeProductName);
    res.status(201).json({ id, productId, storeId, storeProductName });
};

// Controller to get store products by product ID
export const fetchStoreProductsByProductId = async (req: Request, res: Response) => {
    const productId = Number(req.params.productId);
    if (isNaN(productId)) {
        res.status(400).json({ error: 'Invalid product ID' });
        return;
    }
    const storeProducts = await getStoreProductsByProductId(productId);
    res.json(storeProducts);
};

// Controller to get store products by store ID
export const fetchStoreProductsByStoreId = async (req: Request, res: Response) => {
    const storeId = Number(req.params.storeId);
    if (isNaN(storeId)) {
        res.status(400).json({ error: 'Invalid store ID' });
        return;
    }
    const storeProducts = await getStoreProductsByStoreId(storeId);
    res.json(storeProducts);
};

// Controller to get store products by name
export const fetchStoreProductByName = async (req: Request, res: Response) => {
    const { name } = req.query;
    if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Name query parameter is required and must be a string' });
        return;
    }
    const storeProducts = await getStoreProductByName(name);
    res.json(storeProducts);
};