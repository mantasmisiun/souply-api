import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
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
        const { productId, chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl, userId } = req.body;
        if (!productId || !chainId || !storeProductName) {
            res.status(400).json({ error: 'productId, chainId, and storeProductName are required' });
            return;
        }

        // Gate: regular users can't write `imageUrl` directly — same rule
        // as setStoreProductImage. Admin path passes through unchanged.
        // Non-admin uploads go to PendingImageUpload after the SP is
        // created, so the SP starts imageless and admin approval is
        // required before the image goes public.
        let directImageUrl: string | null = imageUrl ?? null;
        let pendingUploadFilePath: string | null = null;

        if (directImageUrl && userId) {
            const [adminRows]: any = await pool.query(
                `SELECT isAdmin FROM User WHERE id = ? LIMIT 1`, [userId],
            );
            const isAdmin = !!adminRows[0]?.isAdmin;
            if (!isAdmin) {
                pendingUploadFilePath = directImageUrl;
                directImageUrl = null;
            }
        } else if (directImageUrl && !userId) {
            // Unknown caller — treat as non-admin and quarantine.
            pendingUploadFilePath = directImageUrl;
            directImageUrl = null;
        }

        const id = await createStoreProduct(
            productId,
            chainId,
            storeProductName,
            brandName || null,
            isWeighable || false,
            amount || null,
            unit || null,
            directImageUrl,
        );

        if (pendingUploadFilePath) {
            await pool.query(
                `INSERT INTO PendingImageUpload (spId, uploadedBy, filePath, status)
                 VALUES (?, ?, ?, 'pending')`,
                [id, userId ?? 'unknown', pendingUploadFilePath],
            );
        }

        res.status(201).json({
            id,
            productId,
            chainId,
            storeProductName,
            isWeighable,
            amount,
            unit,
            imageUrl: directImageUrl,
            imageQueued: !!pendingUploadFilePath,
        });
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
        // Optional: personalise the SP set to the caller's equivalence
        // component (unions swiped-equivalent SPs, incl. 688-bucket orphans).
        const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;
        const storeProducts = mode === 'base'
            ? await getStoreProductsForCluster(productId, userId)
            : await getStoreProductsByProductId(productId, userId);
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

        const candidates = await getStoreProductsByChainWithProductData(chainId, req.locale);

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
            const crossCandidates = await getStoreProductsCrossChainWithProductData(chainId, req.locale);
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
 * Body: { filePath, userId }  // MinIO path + uploader (non-admin path).
 *       { filePath, adminId } // admin bypass — direct publish.
 *
 * Routing:
 *   - Regular users: file lands in `PendingImageUpload` with status='pending'.
 *     The admin image-cleanup tab surfaces these alongside cross-chain
 *     candidates. Client should toast "Nuotrauka išsiųsta peržiūrai".
 *   - Admin users: bypass the pending queue and publish straight to
 *     `StoreProduct.imageUrl` (logged in ImagePropagationLog as
 *     `sourceType='admin_upload'`). Same endpoint to keep client logic
 *     simple — the only routing input is whether the caller is an admin.
 *
 * The admin path checks `isAdmin` server-side; the client can't escalate
 * by claiming to be an admin in the body.
 */
export const setStoreProductImage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid store product ID' });
      return;
    }
    const { filePath, userId } = (req.body ?? {}) as { filePath?: unknown; userId?: unknown };
    if (typeof filePath !== 'string' || !filePath) {
      res.status(400).json({ error: 'filePath is required' });
      return;
    }
    if (typeof userId !== 'string' || !userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    // Admin gate: a caller is treated as admin only if isAdmin=1 in the DB.
    // The pending-queue path is the default for everyone else.
    const [adminRows]: any = await pool.query(
      `SELECT isAdmin FROM User WHERE id = ? LIMIT 1`, [userId],
    );
    const isAdmin = !!adminRows[0]?.isAdmin;

    if (isAdmin) {
      // Admin bypass — publish straight to the SP, log the propagation.
      const [spRows]: any = await pool.query(
        `SELECT imageUrl FROM StoreProduct WHERE id = ? LIMIT 1`, [id],
      );
      const fromImageUrl = spRows[0]?.imageUrl ?? null;
      await updateStoreProductImageUrl(id, filePath);
      await pool.query(
        `INSERT INTO ImagePropagationLog
            (spId, sourceType, sourceSpId, fromImageUrl, toImageUrl, actor)
         VALUES (?, 'admin_upload', NULL, ?, ?, ?)`,
        [id, fromImageUrl, filePath, userId],
      );
      res.json({ id, imageUrl: filePath, queued: false });
      return;
    }

    // Regular user path — land in pending queue. The SP's existing image
    // (or empty placeholder) keeps showing until an admin approves.
    await pool.query(
      `INSERT INTO PendingImageUpload (spId, uploadedBy, filePath, status)
       VALUES (?, ?, ?, 'pending')`,
      [id, userId, filePath],
    );
    res.json({ id, queued: true });
  } catch (error) {
    next(error);
  }
};
