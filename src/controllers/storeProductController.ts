import { Request, Response } from 'express';
import { createStoreProduct, getStoreProductsByProductId, getStoreProductsByChainId, getStoreProductByName } from '../models/storeProductModel';

export const addStoreProduct = async (req: Request, res: Response) => {
    const { productId, chainId, storeProductName } = req.body;
    if (!productId || !chainId || !storeProductName) {
        res.status(400).json({ error: 'All fields are required' });
        return;
    }
    const id = await createStoreProduct(productId, chainId, storeProductName);
    res.status(201).json({ id, productId, chainId, storeProductName });
};

export const fetchStoreProductsByProductId = async (req: Request, res: Response) => {
    const productId = Number(req.params.productId);
    if (isNaN(productId)) {
        res.status(400).json({ error: 'Invalid product ID' });
        return;
    }
    const storeProducts = await getStoreProductsByProductId(productId);
    res.json(storeProducts);
};

export const fetchStoreProductsByChainId = async (req: Request, res: Response) => {
    const chainId = Number(req.params.chainId);
    if (isNaN(chainId)) {
        res.status(400).json({ error: 'Invalid chain ID' });
        return;
    }
    const storeProducts = await getStoreProductsByChainId(chainId);
    res.json(storeProducts);
};

export const fetchStoreProductByName = async (req: Request, res: Response) => {
    const { name } = req.query;
    if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Name query parameter is required and must be a string' });
        return;
    }
    const storeProducts = await getStoreProductByName(name);
    res.json(storeProducts);
};