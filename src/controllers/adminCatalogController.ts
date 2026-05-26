import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { mergeProducts } from '../services/productMergeService.js';
import { logAdminAction } from '../services/adminActionLog.js';

/**
 * POST /admin/products/merge
 * Body: { productIds: number[] }  — at least 2, all must be unmerged.
 * Header: X-Admin-Id (handled by requireAdmin middleware upstream).
 *
 * Superadmin-only: merge is irreversible (soft-delete chain), so the
 * extra role check guards against a regular admin calling this endpoint
 * even if they somehow craft the request manually.
 */
export const mergeProductsHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const adminId = String(req.headers['x-admin-id'] ?? '').trim();

        const [userRows]: any = await pool.query(
            `SELECT adminRole FROM User WHERE id = ? LIMIT 1`,
            [adminId],
        );
        if ((userRows as any[])[0]?.adminRole !== 'superadmin') {
            res.status(403).json({ error: 'Superadmin role required for product merge' });
            return;
        }

        const { productIds } = req.body ?? {};
        if (
            !Array.isArray(productIds) ||
            productIds.length < 2 ||
            productIds.some((id: any) => !Number.isInteger(id) || id <= 0)
        ) {
            res.status(400).json({ error: 'productIds must be an array of at least 2 positive integers' });
            return;
        }

        const result = await mergeProducts(productIds as number[], adminId);
        res.json(result);
    } catch (error: any) {
        next(error);
    }
};

/**
 * POST /admin/products/move
 * Body: { productIds: number[], categoryId: number }
 * Superadmin-only.
 */
export const moveProductsHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const adminId = String(req.headers['x-admin-id'] ?? '').trim();

        const [userRows]: any = await pool.query(
            `SELECT adminRole FROM User WHERE id = ? LIMIT 1`,
            [adminId],
        );
        if ((userRows as any[])[0]?.adminRole !== 'superadmin') {
            res.status(403).json({ error: 'Superadmin role required for product move' });
            return;
        }

        const { productIds, categoryId } = req.body ?? {};
        if (
            !Array.isArray(productIds) ||
            productIds.length < 1 ||
            productIds.some((id: any) => !Number.isInteger(id) || id <= 0)
        ) {
            res.status(400).json({ error: 'productIds must be a non-empty array of positive integers' });
            return;
        }
        if (!Number.isInteger(categoryId) || categoryId <= 0) {
            res.status(400).json({ error: 'categoryId must be a positive integer' });
            return;
        }

        // Verify destination is a leaf category (L3 — no children).
        const [childRows]: any = await pool.query(
            `SELECT id FROM Category WHERE parentCategoryId = ? LIMIT 1`,
            [categoryId],
        );
        if ((childRows as any[]).length > 0) {
            res.status(400).json({ error: 'Destination must be a leaf (L3) category' });
            return;
        }

        // Fetch old category IDs for audit log.
        const [oldRows]: any = await pool.query(
            `SELECT id, categoryId FROM Product WHERE id IN (?)`,
            [productIds],
        );

        await pool.query(
            `UPDATE Product SET categoryId = ? WHERE id IN (?)`,
            [categoryId, productIds],
        );

        for (const row of oldRows as any[]) {
            await logAdminAction({
                adminUserId: adminId,
                action: 'product_move',
                targetType: 'Product',
                targetId: Number(row.id),
                valueBefore: { categoryId: row.categoryId },
                valueAfter: { categoryId },
            });
        }

        res.json({ movedCount: (oldRows as any[]).length });
    } catch (error: any) {
        next(error);
    }
};

/**
 * PATCH /admin/products/:id/name
 * Body: { name: string }
 * Superadmin-only.
 */
export const renameProductHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const adminId = String(req.headers['x-admin-id'] ?? '').trim();

        const [userRows]: any = await pool.query(
            `SELECT adminRole FROM User WHERE id = ? LIMIT 1`,
            [adminId],
        );
        if ((userRows as any[])[0]?.adminRole !== 'superadmin') {
            res.status(403).json({ error: 'Superadmin role required for product rename' });
            return;
        }

        const productId = Number(req.params.id);
        if (!Number.isInteger(productId) || productId <= 0) {
            res.status(400).json({ error: 'Invalid product id' });
            return;
        }

        const { name } = req.body ?? {};
        if (typeof name !== 'string' || !name.trim()) {
            res.status(400).json({ error: 'name must be a non-empty string' });
            return;
        }
        const trimmed = name.trim();

        const [oldRows]: any = await pool.query(
            `SELECT id, name FROM Product WHERE id = ? AND mergedIntoId IS NULL LIMIT 1`,
            [productId],
        );
        if ((oldRows as any[]).length === 0) {
            res.status(404).json({ error: 'Product not found' });
            return;
        }
        const oldName = (oldRows as any[])[0].name;

        await pool.query(`UPDATE Product SET name = ? WHERE id = ?`, [trimmed, productId]);

        await logAdminAction({
            adminUserId: adminId,
            action: 'product_rename',
            targetType: 'Product',
            targetId: productId,
            valueBefore: { name: oldName },
            valueAfter: { name: trimmed },
        });

        res.json({ id: productId, name: trimmed });
    } catch (error: any) {
        next(error);
    }
};
