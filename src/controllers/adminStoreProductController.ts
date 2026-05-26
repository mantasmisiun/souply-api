import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { logAdminAction } from '../services/adminActionLog.js';
import { fetchImageCandidatesBySpIds } from '../models/adminImageQueueModel.js';

function adminIdOf(req: Request): string {
    return String(req.headers['x-admin-id'] ?? '').trim();
}

async function requireSuperadmin(req: Request, res: Response): Promise<boolean> {
    const adminId = adminIdOf(req);
    const [rows]: any = await pool.query(
        `SELECT adminRole FROM User WHERE id = ? LIMIT 1`, [adminId],
    );
    if ((rows as any[])[0]?.adminRole !== 'superadmin') {
        res.status(403).json({ error: 'Superadmin role required' });
        return false;
    }
    return true;
}

/**
 * GET /api/admin/products/:id
 * Returns product details + all SPs with latest price and image candidates.
 */
export const getAdminProductDetail = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const productId = Number(req.params.id);
        if (!Number.isFinite(productId) || productId <= 0) {
            res.status(400).json({ error: 'Invalid product id' });
            return;
        }

        const [[productRow]]: any = await pool.query(
            `SELECT p.id, p.name, p.categoryId,
                    GROUP_CONCAT(c.name ORDER BY c.id SEPARATOR ' > ') AS categoryPath
               FROM Product p
               LEFT JOIN (
                   SELECT c3.id, c3.name FROM Category c3
                   UNION ALL
                   SELECT c2.id, c2.name FROM Category c2
                   UNION ALL
                   SELECT c1.id, c1.name FROM Category c1
               ) c ON c.id = p.categoryId
              WHERE p.id = ? AND p.mergedIntoId IS NULL
              GROUP BY p.id`,
            [productId],
        );
        if (!productRow) {
            res.status(404).json({ error: 'Product not found' });
            return;
        }

        // Simpler category path fetch
        const [[catPathRow]]: any = await pool.query(
            `SELECT
                CONCAT_WS(' > ',
                    (SELECT c1.name FROM Category c1 WHERE c1.id = (
                        SELECT c2.parentCategoryId FROM Category c2 WHERE c2.id = (
                            SELECT c3.parentCategoryId FROM Category c3 WHERE c3.id = p.categoryId
                        )
                    )),
                    (SELECT c2.name FROM Category c2 WHERE c2.id = (
                        SELECT c3.parentCategoryId FROM Category c3 WHERE c3.id = p.categoryId
                    )),
                    (SELECT c3.name FROM Category c3 WHERE c3.id = p.categoryId)
                ) AS categoryPath
               FROM Product p
              WHERE p.id = ? LIMIT 1`,
            [productId],
        );

        const [spRows]: any = await pool.query(
            `SELECT sp.id, sp.storeProductName, sp.chainId, sc.name AS chainName,
                    sc.logoUrl, sp.imageUrl, sp.amount, sp.unit, sp.isWeighable
               FROM StoreProduct sp
               LEFT JOIN StoreChain sc ON sc.id = sp.chainId
              WHERE sp.productId = ?
              ORDER BY sp.chainId, sp.id`,
            [productId],
        );

        const spIds = (spRows as any[]).map((r: any) => Number(r.id));

        type PriceRow = { price: number; promoPrice: number | null; date: string };

        const latestPrices = new Map<number, PriceRow>();
        const priceHistoryMap = new Map<number, PriceRow[]>();

        if (spIds.length > 0) {
            const [allPriceRows]: any = await pool.query(
                `SELECT storeProductId, price, promoPrice, date
                   FROM Price
                  WHERE storeProductId IN (?)
                  ORDER BY storeProductId, date ASC`,
                [spIds],
            );
            for (const r of allPriceRows as any[]) {
                const spId = Number(r.storeProductId);
                const row: PriceRow = {
                    price: Number(r.price),
                    promoPrice: r.promoPrice != null ? Number(r.promoPrice) : null,
                    date: r.date,
                };
                if (!priceHistoryMap.has(spId)) priceHistoryMap.set(spId, []);
                priceHistoryMap.get(spId)!.push(row);
                latestPrices.set(spId, row);
            }
        }

        // Image candidates
        const candidatesBySpId = await fetchImageCandidatesBySpIds(spIds);

        const storeProducts = (spRows as any[]).map((sp: any) => ({
            id: Number(sp.id),
            storeProductName: sp.storeProductName,
            chainId: Number(sp.chainId),
            chainName: sp.chainName,
            logoUrl: sp.logoUrl,
            imageUrl: sp.imageUrl,
            amount: sp.amount,
            unit: sp.unit,
            isWeighable: Boolean(sp.isWeighable),
            latestPrice: latestPrices.get(Number(sp.id)) ?? null,
            priceHistory: priceHistoryMap.get(Number(sp.id)) ?? [],
            imageCandidates: candidatesBySpId.get(Number(sp.id)) ?? [],
        }));

        res.json({
            product: {
                id: Number(productRow.id),
                name: productRow.name,
                categoryId: productRow.categoryId,
                categoryPath: catPathRow?.categoryPath ?? null,
            },
            storeProducts,
        });
    } catch (e) { next(e); }
};

/**
 * DELETE /api/admin/store-products/:spId
 * Force-deletes a SP: removes Price, BasketItem, ShoppingListItem rows
 * for this SP, then the SP itself. If no SPs remain on the parent
 * Product, the Product is deleted too.
 */
export const deleteAdminStoreProduct = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!await requireSuperadmin(req, res)) return;
        const adminId = adminIdOf(req);
        const spId = Number(req.params.spId);
        if (!Number.isFinite(spId) || spId <= 0) {
            res.status(400).json({ error: 'Invalid spId' });
            return;
        }

        const [[spRow]]: any = await pool.query(
            `SELECT sp.id, sp.productId, sp.storeProductName, sp.imageUrl,
                    p.name AS productName
               FROM StoreProduct sp
               JOIN Product p ON p.id = sp.productId
              WHERE sp.id = ? LIMIT 1`,
            [spId],
        );
        if (!spRow) {
            res.status(404).json({ error: 'StoreProduct not found' });
            return;
        }
        const productId = Number(spRow.productId);

        await pool.query(`DELETE FROM Price WHERE storeProductId = ?`, [spId]);
        try { await pool.query(`DELETE FROM BasketItem WHERE storeProductId = ?`, [spId]); } catch { /* ignore */ }
        try { await pool.query(`DELETE FROM ShoppingListItem WHERE storeProductId = ?`, [spId]); } catch { /* ignore */ }
        await pool.query(`DELETE FROM StoreProduct WHERE id = ?`, [spId]);

        await logAdminAction({
            adminUserId: adminId,
            action: 'sp_delete',
            targetType: 'StoreProduct',
            targetId: spId,
            valueBefore: { storeProductName: spRow.storeProductName, productId, productName: spRow.productName },
        });

        // Remove parent Product if no SPs remain
        const [[countRow]]: any = await pool.query(
            `SELECT COUNT(*) AS n FROM StoreProduct WHERE productId = ?`, [productId],
        );
        let productDeleted = false;
        if (Number(countRow.n) === 0) {
            await pool.query(`DELETE FROM Product WHERE id = ?`, [productId]);
            productDeleted = true;
        }

        res.json({ spId, productDeleted, productId });
    } catch (e) { next(e); }
};

/**
 * PATCH /api/admin/store-products/:spId
 * Edit SP fields: storeProductName, amount, unit, isWeighable, imageUrl.
 * Only provided fields are updated.
 */
export const editAdminStoreProduct = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!await requireSuperadmin(req, res)) return;
        const adminId = adminIdOf(req);
        const spId = Number(req.params.spId);
        if (!Number.isFinite(spId) || spId <= 0) {
            res.status(400).json({ error: 'Invalid spId' });
            return;
        }

        const [[before]]: any = await pool.query(
            `SELECT id, storeProductName, amount, unit, isWeighable, imageUrl
               FROM StoreProduct WHERE id = ? LIMIT 1`,
            [spId],
        );
        if (!before) {
            res.status(404).json({ error: 'StoreProduct not found' });
            return;
        }

        const body = req.body ?? {};
        const updates: Record<string, any> = {};

        if ('storeProductName' in body && typeof body.storeProductName === 'string') {
            updates.storeProductName = body.storeProductName.trim() || null;
        }
        if ('amount' in body) {
            const v = body.amount === null ? null : Number(body.amount);
            updates.amount = v !== null && Number.isFinite(v) ? v : null;
        }
        if ('unit' in body && (body.unit === null || typeof body.unit === 'string')) {
            updates.unit = body.unit;
        }
        if ('isWeighable' in body) {
            updates.isWeighable = body.isWeighable ? 1 : 0;
        }
        if ('imageUrl' in body && (body.imageUrl === null || typeof body.imageUrl === 'string')) {
            updates.imageUrl = body.imageUrl || null;
        }

        if (Object.keys(updates).length === 0) {
            res.status(400).json({ error: 'No valid fields to update' });
            return;
        }

        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        await pool.query(
            `UPDATE StoreProduct SET ${setClauses} WHERE id = ?`,
            [...Object.values(updates), spId],
        );

        await logAdminAction({
            adminUserId: adminId,
            action: 'sp_edit',
            targetType: 'StoreProduct',
            targetId: spId,
            valueBefore: {
                storeProductName: before.storeProductName,
                amount: before.amount,
                unit: before.unit,
                isWeighable: before.isWeighable,
                imageUrl: before.imageUrl,
            },
            valueAfter: updates,
        });

        res.json({ spId, updated: updates });
    } catch (e) { next(e); }
};

/**
 * POST /api/admin/store-products/:spId/move
 * Move a SP to a different Product.
 * Body: { mode: 'existing', productId: number }
 *     | { mode: 'new', name: string, categoryId: number }
 *
 * If the old Product is left with no SPs, it is deleted.
 */
export const moveAdminStoreProduct = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!await requireSuperadmin(req, res)) return;
        const adminId = adminIdOf(req);
        const spId = Number(req.params.spId);
        if (!Number.isFinite(spId) || spId <= 0) {
            res.status(400).json({ error: 'Invalid spId' });
            return;
        }

        const [[spRow]]: any = await pool.query(
            `SELECT id, productId, storeProductName FROM StoreProduct WHERE id = ? LIMIT 1`,
            [spId],
        );
        if (!spRow) {
            res.status(404).json({ error: 'StoreProduct not found' });
            return;
        }
        const oldProductId = Number(spRow.productId);

        const body = req.body ?? {};
        let targetProductId: number;
        let targetProductName: string;

        if (body.mode === 'existing') {
            const pid = Number(body.productId);
            if (!Number.isFinite(pid) || pid <= 0) {
                res.status(400).json({ error: 'Invalid productId' });
                return;
            }
            const [[pRow]]: any = await pool.query(
                `SELECT id, name FROM Product WHERE id = ? AND mergedIntoId IS NULL LIMIT 1`, [pid],
            );
            if (!pRow) {
                res.status(404).json({ error: 'Target product not found' });
                return;
            }
            targetProductId = Number(pRow.id);
            targetProductName = pRow.name;
        } else if (body.mode === 'new') {
            if (typeof body.name !== 'string' || !body.name.trim()) {
                res.status(400).json({ error: 'name required for mode=new' });
                return;
            }
            const categoryId = Number(body.categoryId);
            if (!Number.isFinite(categoryId) || categoryId <= 0) {
                res.status(400).json({ error: 'categoryId required for mode=new' });
                return;
            }
            // Verify it's a leaf (L3) category
            const [[childCheck]]: any = await pool.query(
                `SELECT id FROM Category WHERE parentCategoryId = ? LIMIT 1`, [categoryId],
            );
            if (childCheck) {
                res.status(400).json({ error: 'categoryId must be a leaf (L3) category' });
                return;
            }
            const [insertResult]: any = await pool.query(
                `INSERT INTO Product (name, categoryId) VALUES (?, ?)`,
                [body.name.trim(), categoryId],
            );
            targetProductId = Number(insertResult.insertId);
            targetProductName = body.name.trim();
        } else {
            res.status(400).json({ error: 'mode must be "existing" or "new"' });
            return;
        }

        await pool.query(`UPDATE StoreProduct SET productId = ? WHERE id = ?`, [targetProductId, spId]);

        await logAdminAction({
            adminUserId: adminId,
            action: 'sp_move',
            targetType: 'StoreProduct',
            targetId: spId,
            valueBefore: { productId: oldProductId },
            valueAfter: { productId: targetProductId, productName: targetProductName, mode: body.mode },
        });

        // Remove old Product if it now has no SPs
        const [[countRow]]: any = await pool.query(
            `SELECT COUNT(*) AS n FROM StoreProduct WHERE productId = ?`, [oldProductId],
        );
        let oldProductDeleted = false;
        if (Number(countRow.n) === 0) {
            await pool.query(`DELETE FROM Product WHERE id = ?`, [oldProductId]);
            oldProductDeleted = true;
        }

        res.json({
            spId,
            targetProductId,
            targetProductName,
            oldProductDeleted,
            oldProductId,
        });
    } catch (e) { next(e); }
};
