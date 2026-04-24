import { Request, Response, NextFunction } from 'express';
import {
  createStoreProduct, getStoreProductsByProductId, getStoreProductsForCluster, getStoreProductsByChainId,
  getStoreProductByName, getStoreProductByProductAndChain,
  searchStoreProductsByChain as searchByChain,
  searchUnifiedProductsByChain as searchUnifiedByChain,
  updateStoreProductImageUrl,
} from '../models/storeProductModel.js';
import { getProductsByCategoryWithAmounts, getAllProductsByL2WithAmounts } from '../models/productModel.js';
import {
    getStoreProductsByChainWithProductData,
    getStoreProductsCrossChainWithProductData,
} from '../models/storeProductModel.js';
import { findBestProductMatches } from '../utils/productMatcher.js';

export const addStoreProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { productId, chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl } = req.body;
        if (!productId || !chainId || !storeProductName) {
            res.status(400).json({ error: 'productId, chainId, and storeProductName are required' });
            return;
        }
        const id = await createStoreProduct(
            productId,
            chainId,
            storeProductName,
            brandName || null,
            isWeighable || false,
            amount || null,
            unit || null,
            imageUrl || null
        );
        res.status(201).json({ id, productId, chainId, storeProductName, isWeighable, amount, unit, imageUrl: imageUrl || null });
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
        // ?mode=base expands the query to the whole BaseProduct cluster
        // (head + variants) for the detail view. Default 'sku' keeps the
        // original single-Product behavior for old clients.
        const mode = req.query.mode === 'base' ? 'base' : 'sku';
        const storeProducts = mode === 'base'
            ? await getStoreProductsForCluster(productId)
            : await getStoreProductsByProductId(productId);
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

        let matches = findBestProductMatches(name, amount, unit, candidates);
        let crossChain = false;
        console.log(`Same-chain matches above threshold: ${matches.length}`);

        // Cross-chain fallback. When a chain has no scraped catalog yet
        // (Norfa has no public product-listing endpoint we could scrape
        // the way we did Barbora / Rimi / IKI), every match against
        // chainId returns zero. Fall back to one representative
        // StoreProduct per Product across the OTHER chains — the
        // matcher scores those. The resolver later reuses the matched
        // Product id when creating a new chain-specific StoreProduct,
        // which is how cross-chain product identity bootstraps itself
        // organically as receipts get processed.
        if (matches.length === 0) {
            const crossCandidates = await getStoreProductsCrossChainWithProductData(chainId);
            console.log(`Cross-chain candidates fetched: ${crossCandidates.length}`);
            matches = findBestProductMatches(name, amount, unit, crossCandidates);
            crossChain = matches.length > 0;
            console.log(
                `Cross-chain matches above threshold: ${matches.length}${crossChain ? ' (cross-chain fallback)' : ''}`
            );
        }

        res.json({ matches, crossChain });
    } catch (error) {
        next(error);
    }
};
export const searchUnifiedStoreProductsByChain = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chainId = Number(req.query.chainId);
        const name = typeof req.query.name === 'string' ? req.query.name : '';
        const categoryIdRaw = req.query.categoryId;
        const categoryId =
            typeof categoryIdRaw === 'string' && categoryIdRaw.trim().length > 0
                ? Number(categoryIdRaw)
                : null;

        if (isNaN(chainId)) {
            res.status(400).json({ error: 'chainId is required' });
            return;
        }

        if (!name.trim() && !Number.isFinite(categoryId)) {
            res.status(400).json({ error: 'name or categoryId is required' });
            return;
        }

        const result = await searchUnifiedByChain(chainId, name, categoryId);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

export const getStoreProductUploadUrl = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { filename, mimeType } = req.body;
    if (!filename) {
      res.status(400).json({ error: 'filename is required' });
      return;
    }

    const { getPresignedProductImageUploadUrl } = await import('../services/storageService.js');
    const { uploadUrl, filePath } = await getPresignedProductImageUploadUrl(
      filename,
      mimeType || 'image/jpeg'
    );
    res.json({ uploadUrl, filePath });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/store-products/:id/image
 * Body: { filePath }  // MinIO path returned by the upload-url helper.
 *
 * Sets StoreProduct.imageUrl to the public URL corresponding to that path
 * and returns it so the mobile can update its thumbnail immediately.
 */
export const setStoreProductImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid store product ID' });
      return;
    }
    const { filePath } = req.body ?? {};
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'filePath is required' });
      return;
    }
    // getPresignedProductImageUploadUrl already returns the full public URL
    // as `filePath` — we just persist it verbatim.
    await updateStoreProductImageUrl(id, filePath);
    res.json({ id, imageUrl: filePath });
  } catch (error) {
    next(error);
  }
};
