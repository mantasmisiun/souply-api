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
    getCachedChainCandidates,
    getCachedCrossChainCandidates,
    getStoreProductsCrossChainWithProductData,
} from '../models/storeProductModel.js';
import { findBestProductMatches, explainMatch, normalizeProductName, type MatchCandidate } from '../utils/productMatcher.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

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
            ? await getStoreProductsForCluster(productId, userId, req.locale)
            : await getStoreProductsByProductId(productId, userId, req.locale);
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
        const products = await getProductsByCategoryWithAmounts(categoryId, 'base', undefined, req.locale);
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
        // Optional weighable gate: '1'/'true' = by-weight line, '0'/'false' =
        // packaged. Absent → null (no gate, legacy clients unaffected).
        const weighableRaw = req.query.weighable as string | undefined;
        const ocrIsWeighable =
            weighableRaw === undefined || weighableRaw === ''
                ? null
                : weighableRaw === '1' || weighableRaw.toLowerCase() === 'true';

        if (isNaN(chainId) || !name) {
            res.status(400).json({ error: 'chainId and name query params are required' });
            return;
        }

        const amount = amountRaw !== undefined && amountRaw !== '' ? parseFloat(amountRaw) : null;

        const candidates: MatchCandidate[] = await getCachedChainCandidates(chainId, req.locale);
        const aliasCount = candidates.reduce((n, c) => n + (c.aliases?.length ?? 0), 0);

        // Log 3 — MATCH derivation: the candidates + their scores, and WHY the top one
        // won (which name — catalog vs a learned alias — and which lane carried it), so
        // the whole match step (incl. the vocabulary feedback loop) is inspectable.
        console.log(`=== MATCH ${JSON.stringify(name)} (chain ${chainId}, amount=${amount}, unit=${unit}, weighable=${ocrIsWeighable}) ===`);
        console.log(`  candidates=${candidates.length}  canonical-aliases-in-chain=${aliasCount}`);

        let matches = findBestProductMatches(name, amount, unit, candidates, undefined, undefined, ocrIsWeighable);
        let crossChain = false;

        if (matches.length > 0) {
            console.log('  top same-chain:');
            matches.slice(0, 3).forEach((m, i) =>
                console.log(`    ${i + 1}) SP ${m.storeProductId} ${JSON.stringify(m.name)} conf=${m.confidence.toFixed(2)} catalog=${m.isCatalog ? 'yes' : 'no'}`));
            const top = matches[0];
            const topCand = candidates.find((c) => c.id === top.storeProductId);
            const prov = topCand ? explainMatch(name, topCand) : null;
            const nq = normalizeProductName(name);
            const scoped = candidates.find((c) => c.similarityAliases?.includes(nq)); // did a 'similar' alias L2-scope the search?
            const suppressedNote = topCand?.rejectedAliases?.includes(nq)
                ? "  [NOTE: this OCR also has a REJECTED alias for this SP]" : '';
            const via = !prov ? '?'
                : prov.via === 'learned-alias' ? `LEARNED ALIAS ${JSON.stringify(prov.aliasText)} lane=${prov.lane} [vocab feedback working]`
                : prov.via === 'catalog-name' ? `catalog-name lane=${prov.lane}`
                : 'unclear';
            console.log(
                `  → picked SP ${top.storeProductId} (conf ${top.confidence.toFixed(2)}) via ${via}` +
                `${prov?.healed ? ' [OCR space-heal fired]' : ''}` +
                `${scoped ? `  [L2-scoped by a 'similar' alias → SP ${scoped.id}]` : ''}` +
                `${suppressedNote}  [cross-chain: no]`,
            );
        } else {
            // Cross-chain fallback. When a chain has no scraped catalog yet
            // (Norfa has no public product-listing endpoint we could scrape
            // the way we did Barbora / Rimi / IKI), every same-chain match returns
            // zero. Fall back to one representative StoreProduct per Product across the
            // OTHER chains — the matcher scores those. The resolver later reuses the
            // matched Product id when creating a new chain-specific StoreProduct, which
            // is how cross-chain product identity bootstraps itself as receipts process.
            // Cross-chain uses its OWN floor (RECOGNITION.match.minConfidenceCrossChain);
            // bump it to tighten weak cross-chain hits (e.g. the slyvos/paprikos shared word).
            const crossCandidates = await getCachedCrossChainCandidates(chainId, req.locale);
            matches = findBestProductMatches(name, amount, unit, crossCandidates, RECOGNITION.match.minConfidenceCrossChain, undefined, ocrIsWeighable);
            crossChain = matches.length > 0;
            console.log(`  same-chain: 0 above floor → CROSS-CHAIN fallback (${crossCandidates.length} candidates)`);
            if (matches.length > 0) {
                console.log('  top cross-chain:');
                matches.slice(0, 3).forEach((m, i) =>
                    console.log(`    ${i + 1}) SP ${m.storeProductId} ${JSON.stringify(m.name)} conf=${m.confidence.toFixed(2)}`));
                console.log(`  → picked SP ${matches[0].storeProductId} (conf ${matches[0].confidence.toFixed(2)}) via cross-chain (weak — client orphans it below auto-apply)`);
            } else {
                console.log('  → NO match — line stays UNMATCHED (no-mint: no SP created; recorded as a ReceiptItem observation)');
            }
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
