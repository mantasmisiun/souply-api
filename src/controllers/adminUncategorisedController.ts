import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    pickUncategorisedProductIds,
    hydrateUncategorisedRows,
    checkProductDeleteBlockers,
} from '../models/adminUncategorisedQueueModel.js';
import {
    claimSpIds,
    completeLease,
    releaseAdminBatch,
    getActiveLeasesForAdmin,
} from '../models/adminLeaseModel.js';
import { logAdminAction } from '../services/adminActionLog.js';

/**
 * Admin Uncategorised-tab endpoints (Tab 4 — Nepriskirti).
 *
 * Per-Product queue. The lease layer is the generic one — we stash
 * `Product.id` in `AdminCardLease.spId` (single bigint, doubles as
 * productId for this queueKind, same pattern the flag queue uses).
 *
 * Actions:
 *   confirm — assign category (+ optional name edit)
 *   delete  — remove the Product (FK-safe pre-check, 409 on blockers)
 *   skip    — defer 90 days (audit-driven anti-resurface)
 */

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;

function adminIdOf(req: Request): string {
    return String(req.headers['x-admin-id']);
}

// ── GET /api/admin/uncategorised/queue ─────────────────────────────
export const getUncategorisedQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const leases = await getActiveLeasesForAdmin(adminId, 'uncategorised');
        const productIds = leases.map(l => l.spId);
        const rows = await hydrateUncategorisedRows(productIds, (req as any).locale);
        res.json({ rows, leaseCount: leases.length });
    } catch (e) { next(e); }
};

// ── POST /api/admin/uncategorised/claim-batch ───────────────────────
export const claimUncategorisedBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const requested = Number((req.body as any)?.size ?? DEFAULT_BATCH_SIZE);
        const size = Math.max(1, Math.min(MAX_BATCH_SIZE,
            Number.isFinite(requested) ? requested : DEFAULT_BATCH_SIZE));

        // Resume existing batch if any. Same one-at-a-time contract.
        const existing = await getActiveLeasesForAdmin(adminId, 'uncategorised');
        if (existing.length > 0) {
            const rows = await hydrateUncategorisedRows(
                existing.map(l => l.spId),
                (req as any).locale,
            );
            res.json({ rows, leaseCount: existing.length, resumed: true });
            return;
        }

        const ids = await pickUncategorisedProductIds({ batchSize: size });
        if (ids.length === 0) {
            res.json({ rows: [], leaseCount: 0, resumed: false });
            return;
        }
        const leases = await claimSpIds({
            adminId,
            queueKind: 'uncategorised',
            spIds: ids,
        });
        const rows = await hydrateUncategorisedRows(
            leases.map(l => l.spId),
            (req as any).locale,
        );
        res.json({ rows, leaseCount: leases.length, resumed: false });
    } catch (e) { next(e); }
};

// ── POST /api/admin/uncategorised/release-batch ─────────────────────
export const releaseUncategorisedBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const released = await releaseAdminBatch({ adminId, queueKind: 'uncategorised' });
        res.json({ released });
    } catch (e) { next(e); }
};

// ── POST /api/admin/uncategorised/:productId/confirm ────────────────
// Body: { categoryId: number, name?: string }
// categoryId is required (whole point of the tab). Optional name
// edit lets the admin fix typos / dupes in the same pass.
export const confirmUncategorisedProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const productId = Number(req.params.productId);
        const { categoryId, name } = (req.body ?? {}) as {
            categoryId?: unknown;
            name?: unknown;
        };
        if (!Number.isFinite(productId)) {
            res.status(400).json({ error: 'invalid productId' });
            return;
        }
        const catId = Number(categoryId);
        if (!Number.isFinite(catId) || catId <= 0) {
            res.status(400).json({ error: 'categoryId is required' });
            return;
        }
        const adminId = adminIdOf(req);

        const [[before]]: any = await pool.query(
            `SELECT categoryId, name FROM Product WHERE id = ? LIMIT 1`,
            [productId],
        );
        if (!before) {
            res.status(404).json({ error: 'product not found' });
            return;
        }

        const updates: { col: string; val: any }[] = [];
        const beforeVals: Record<string, unknown> = {};
        const afterVals: Record<string, unknown> = {};

        if (Number(before.categoryId ?? 0) !== catId) {
            updates.push({ col: 'categoryId', val: catId });
            beforeVals.categoryId = before.categoryId ?? null;
            afterVals.categoryId = catId;
        }
        if (typeof name === 'string') {
            const trimmed = name.trim();
            if (trimmed.length > 0 && trimmed !== String(before.name ?? '').trim()) {
                updates.push({ col: 'name', val: trimmed });
                beforeVals.name = before.name;
                afterVals.name = trimmed;
            }
        }
        if (updates.length > 0) {
            await pool.query(
                `UPDATE Product SET ${updates.map(u => `${u.col} = ?`).join(', ')} WHERE id = ?`,
                [...updates.map(u => u.val), productId],
            );
        }

        await logAdminAction({
            adminUserId: adminId,
            action: 'uncategorised_set',
            targetType: 'Product',
            targetId: productId,
            valueBefore: beforeVals,
            valueAfter: afterVals,
        });
        await completeLease({ adminId, queueKind: 'uncategorised', spId: productId });

        res.json({ productId, applied: afterVals });
    } catch (e) { next(e); }
};

// ── POST /api/admin/uncategorised/:productId/delete ─────────────────
// FK-safe pre-check. If any Prices / BasketItems / ShoppingListItems
// reference this Product (via its SPs) → 409 with counts so the admin
// knows what to clean up first (typically via the Flags tab's
// re-link flow). Clean delete cascades to SPs via existing schema FKs.
export const deleteUncategorisedProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const productId = Number(req.params.productId);
        if (!Number.isFinite(productId)) {
            res.status(400).json({ error: 'invalid productId' });
            return;
        }
        const adminId = adminIdOf(req);

        const blockers = await checkProductDeleteBlockers(productId);
        const totalBlockers = blockers.prices + blockers.basketItems + blockers.shoppingListItems;
        if (totalBlockers > 0) {
            res.status(409).json({
                error: 'blocked',
                blockers,
                message: 'Cannot delete — referenced by receipts / baskets / shopping lists. Re-link via Žymos first.',
            });
            return;
        }

        const [[before]]: any = await pool.query(
            `SELECT name, categoryId FROM Product WHERE id = ? LIMIT 1`,
            [productId],
        );
        if (!before) {
            res.status(404).json({ error: 'product not found' });
            return;
        }

        // Delete orphaned SPs first so we don't trip on FK constraints
        // that might not be ON DELETE CASCADE for every reference.
        // After the blocker check above, the only SP-side rows that
        // can still exist are the ones with no Prices / Basket / List
        // refs — safe to drop.
        await pool.query(`DELETE FROM StoreProduct WHERE productId = ?`, [productId]);
        await pool.query(`DELETE FROM Product WHERE id = ?`, [productId]);

        await logAdminAction({
            adminUserId: adminId,
            action: 'uncategorised_delete',
            targetType: 'Product',
            targetId: productId,
            valueBefore: { name: before.name, categoryId: before.categoryId },
        });
        await completeLease({ adminId, queueKind: 'uncategorised', spId: productId });

        res.json({ productId, deleted: true });
    } catch (e) { next(e); }
};

// ── POST /api/admin/uncategorised/:productId/skip ───────────────────
export const skipUncategorisedProduct = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const productId = Number(req.params.productId);
        if (!Number.isFinite(productId)) {
            res.status(400).json({ error: 'invalid productId' });
            return;
        }
        const adminId = adminIdOf(req);
        await logAdminAction({
            adminUserId: adminId,
            action: 'uncategorised_skip',
            targetType: 'Product',
            targetId: productId,
        });
        await completeLease({ adminId, queueKind: 'uncategorised', spId: productId });
        res.json({ productId, skipped: true });
    } catch (e) { next(e); }
};
