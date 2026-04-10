import { Request, Response, NextFunction } from 'express';
import { createStoreProduct, getStoreProductsByProductId, getStoreProductsByChainId, getStoreProductByName, getStoreProductByProductAndChain } from '../models/storeProductModel';

export const addStoreProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { productId, chainId, storeProductName, brandName } = req.body;
        if (!productId || !chainId || !storeProductName) {
            res.status(400).json({ error: 'All fields are required' });
            return;
        }
        const id = await createStoreProduct(productId, chainId, storeProductName, brandName || null);
        res.status(201).json({ id, productId, chainId, storeProductName });
    } catch (error) {
        next(error);
    }
};

export const fetchStoreProductsByProductId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const productId = Number(req.params.productId);
        if (isNaN(productId)) {
            res.status(400).json({ error: 'Invalid product ID' });
            return;
        }
        const storeProducts = await getStoreProductsByProductId(productId);
        res.json(storeProducts);
    } catch (error) {
        next(error);
    }
};

export const fetchStoreProductsByChainId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chainId = Number(req.params.chainId);
        if (isNaN(chainId)) {
            res.status(400).json({ error: 'Invalid chain ID' });
            return;
        }
        const storeProducts = await getStoreProductsByChainId(chainId);
        res.json(storeProducts);
    } catch (error) {
        next(error);
    }
};

export const fetchStoreProductByName = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name } = req.query;
        if (!name || typeof name !== 'string') {
            res.status(400).json({ error: 'Name query parameter is required and must be a string' });
            return;
        }
        const storeProducts = await getStoreProductByName(name);
        res.json(storeProducts);
    } catch (error) {
        next(error);
    }
};

export const fetchStoreProductByProductAndChain = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { productId, chainId } = req.query;
        if (!productId || !chainId) {
            res.status(400).json({ error: 'Both productId and chainId are required' });
            return;
        }
        const storeProduct = await getStoreProductByProductAndChain(Number(productId), Number(chainId));
        if (!storeProduct) {
            res.status(404).json({ error: 'Store product not found' });
            return;
        }
        res.json(storeProduct);
    } catch (error) {
        next(error);
    }
};