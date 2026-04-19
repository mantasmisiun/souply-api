import { Request, Response, NextFunction } from 'express';
import { createStoreProduct, getStoreProductsByProductId, getStoreProductsByChainId, getStoreProductByName, getStoreProductByProductAndChain, searchStoreProductsByChain as searchByChain } from '../models/storeProductModel';
import { getProductsByCategoryWithAmounts, getAllProductsByL2WithAmounts } from '../models/productModel';
import { getStoreProductsByChainWithProductData } from '../models/storeProductModel';
import { findBestProductMatches } from '../utils/productMatcher';

export const addStoreProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { productId, chainId, storeProductName, brandName, isWeighable, amount, unit } = req.body;
        if (!productId || !chainId || !storeProductName) {
            res.status(400).json({ error: 'productId, chainId, and storeProductName are required' });
            return;
        }
        const id = await createStoreProduct(productId, chainId, storeProductName, brandName || null, isWeighable || false, amount || null, unit || null);
        res.status(201).json({ id, productId, chainId, storeProductName, isWeighable, amount, unit });
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

export const searchStoreProductsByChain = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name, chainId } = req.query;
        if (!name || typeof name !== 'string') {
            res.status(400).json({ error: 'Name query parameter is required and must be a string' });
            return;
        }
        if (chainId) {
            const results = await searchByChain(name, Number(chainId));
            res.json(results);
        } else {
            const results = await getStoreProductByName(name);
            res.json(results);
        }
    } catch (error) {
        next(error);
    }
};

export const fetchProductsByCategoryWithAmounts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const categoryId = Number(req.params.categoryId);
        if (isNaN(categoryId)) {
            res.status(400).json({ error: 'Invalid category ID' });
            return;
        }
        const products = await getProductsByCategoryWithAmounts(categoryId);
        res.json(products);
    } catch (error) {
        next(error);
    }
};

export const matchStoreProductByName = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chainId = Number(req.query.chainId);
        const name = req.query.name as string;
        const amountRaw = req.query.amount as string | undefined;
        const unit = (req.query.unit as string) || null;

        if (isNaN(chainId) || !name) {
            res.status(400).json({ error: 'chainId and name query params are required' });
            return;
        }

        const amount = amountRaw !== undefined && amountRaw !== '' ? parseFloat(amountRaw) : null;

        const candidates = await getStoreProductsByChainWithProductData(chainId);
        
        console.log('=== MATCH REQUEST ===');
        console.log(`chainId=${chainId}, name="${name}", amount=${amount}, unit=${unit}`);
        console.log(`Candidates fetched: ${candidates.length}`);
        if (candidates.length > 0) {
            console.log('First candidate:', JSON.stringify(candidates[0]));
            const alpro = candidates.filter((c: any) => c.storeProductName.toLowerCase().includes('alpro'));
            console.log(`ALPRO candidates: ${alpro.length}`);
            if (alpro.length > 0) console.log('First ALPRO:', JSON.stringify(alpro[0]));
        }
        
        const matches = findBestProductMatches(name, amount, unit, candidates);
        console.log(`Matches above threshold: ${matches.length}`);

        res.json({ matches });
    } catch (error) {
        next(error);
    }
};