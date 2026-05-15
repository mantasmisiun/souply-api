import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    pickAmountQueueSpIds,
    hydrateAmountQueueRows,
} from '../models/adminAmountQueueModel.js';
import {
    claimSpIds,
    completeLease,
    releaseAdminBatch,
    getActiveLeasesForAdmin,
} from '../models/adminLeaseModel.js';
import { logAdminAction } from '../services/adminActionLog.js';

/**
 * Admin amounts-cleanup tab endpoints.
 *
 * Same auth + lease + audit chassis as adminImageController. The only
 * meaningful differences:
 *   - claim-batch runs the JS-side name parser to filter before leasing
 *   - confirm action writes amount + unit + isWeighable on the SP
 *   - no candidate strip; each card has exactly one suggestion
 */

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;

const VALID_UNITS = new Set(['g', 'kg', 'ml', 'l', 'vnt', 'rit']);

function adminIdOf(req: Request): string {
    return String(req.headers['x-admin-id']);
}

// ── GET /api/admin/amounts/queue ────────────────────────────────────
export const getAmountQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const leases = await getActiveLeasesForAdmin(adminId, 'amount');
        const rows = await hydrateAmountQueueRows(
            leases.map(l => l.spId),
            (req as any).locale,
        );
        res.json({ rows, leaseCount: leases.length });
    } catch (e) { next(e); }
};

// ── POST /api/admin/amounts/claim-batch ─────────────────────────────
export const claimAmountBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const requested = Number((req.body as any)?.size ?? DEFAULT_BATCH_SIZE);
        const size = Math.max(1, Math.min(MAX_BATCH_SIZE,
            Number.isFinite(requested) ? requested : DEFAULT_BATCH_SIZE));

        // Resume existing batch if any. Same one-batch-at-a-time
        // contract as the image queue.
        const existing = await getActiveLeasesForAdmin(adminId, 'amount');
        if (existing.length > 0) {
            const rows = await hydrateAmountQueueRows(
                existing.map(l => l.spId),
                (req as any).locale,
            );
            res.json({ rows, leaseCount: existing.length, resumed: true });
            return;
        }

        const spIds = await pickAmountQueueSpIds({ batchSize: size });
        if (spIds.length === 0) {
            res.json({ rows: [], leaseCount: 0, resumed: false });
            return;
        }

        const leases = await claimSpIds({
            adminId,
            queueKind: 'amount',
            spIds,
        });
        const rows = await hydrateAmountQueueRows(
            leases.map(l => l.spId),
            (req as any).locale,
        );
        res.json({ rows, leaseCount: leases.length, resumed: false });
    } catch (e) { next(e); }
};

// ── POST /api/admin/amounts/release-batch ───────────────────────────
export const releaseAmountBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const released = await releaseAdminBatch({ adminId, queueKind: 'amount' });
        res.json({ released });
    } catch (e) { next(e); }
};

// ── POST /api/admin/amounts/:spId/confirm ───────────────────────────
// Body: { amount, unit, isWeighable }
// Writes the three fields on the SP, logs the change to AdminAuditLog
// (with before/after for revert), and completes the lease. Also flips
// any pending ReceiptLineIssue.flags.amount=true row to 'resolved' so
// the same SP doesn't re-surface from the user-flagged side after the
// admin already acted on it.
export const confirmAmount = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const spId = Number(req.params.spId);
        const { amount, unit, isWeighable } = (req.body ?? {}) as {
            amount?: unknown;
            unit?: unknown;
            isWeighable?: unknown;
        };
        if (!Number.isFinite(spId)) {
            res.status(400).json({ error: 'invalid spId' });
            return;
        }
        const amountNum = typeof amount === 'number' ? amount : NaN;
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            res.status(400).json({ error: 'amount must be a positive number' });
            return;
        }
        if (typeof unit !== 'string' || !VALID_UNITS.has(unit)) {
            res.status(400).json({ error: 'unit must be one of g, kg, ml, l, vnt, rit' });
            return;
        }
        const isWeighableBool = !!isWeighable;
        const adminId = adminIdOf(req);

        // Read current values for the audit log before-snapshot.
        const [spRows]: any = await pool.query(
            `SELECT amount, unit, isWeighable FROM StoreProduct WHERE id = ? LIMIT 1`,
            [spId],
        );
        if (!spRows[0]) {
            res.status(404).json({ error: 'StoreProduct not found' });
            return;
        }
        const before = {
            amount: spRows[0].amount !== null && spRows[0].amount !== undefined
                ? parseFloat(String(spRows[0].amount))
                : null,
            unit: spRows[0].unit ?? null,
            isWeighable: !!Number(spRows[0].isWeighable),
        };

        // StoreProduct carries a unique key on (chainId, productId,
        // amount, unit). Two SPs of the same chain+product can't share
        // a size. When the parser-suggested size collides with an
        // existing sibling we surface a 409 and let the client treat
        // it as a skip — the card can't be "fixed" without merging
        // the two SPs, which is a separate flow.
        try {
            await pool.query(
                `UPDATE StoreProduct
                    SET amount = ?, unit = ?, isWeighable = ?
                  WHERE id = ?`,
                [amountNum, unit, isWeighableBool ? 1 : 0, spId],
            );
        } catch (err: any) {
            if (err?.code === 'ER_DUP_ENTRY') {
                await logAdminAction({
                    adminUserId: adminId,
                    action: 'amount_skip',
                    targetType: 'StoreProduct',
                    targetId: spId,
                    valueBefore: { reason: 'duplicate_size_in_chain' },
                });
                await completeLease({ adminId, queueKind: 'amount', spId });
                res.status(409).json({
                    error: 'duplicate_size',
                    message: 'Another StoreProduct in the same chain already has this amount + unit',
                });
                return;
            }
            throw err;
        }

        // No auto-resolve of ReceiptLineIssue from this tab — user-
        // flagged amount complaints now live exclusively in the Flags
        // tab. This tab handles heuristic mismatches only.

        await logAdminAction({
            adminUserId: adminId,
            action: 'amount_set',
            targetType: 'StoreProduct',
            targetId: spId,
            valueBefore: before,
            valueAfter: { amount: amountNum, unit, isWeighable: isWeighableBool },
        });
        await completeLease({ adminId, queueKind: 'amount', spId });

        res.json({ spId, amount: amountNum, unit, isWeighable: isWeighableBool });
    } catch (e) { next(e); }
};

// ── POST /api/admin/amounts/:spId/skip ──────────────────────────────
export const skipAmountCard = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const spId = Number(req.params.spId);
        if (!Number.isFinite(spId)) {
            res.status(400).json({ error: 'invalid spId' });
            return;
        }
        const adminId = adminIdOf(req);
        await logAdminAction({
            adminUserId: adminId,
            action: 'amount_skip',
            targetType: 'StoreProduct',
            targetId: spId,
        });
        await completeLease({ adminId, queueKind: 'amount', spId });
        res.json({ spId, skipped: true });
    } catch (e) { next(e); }
};
