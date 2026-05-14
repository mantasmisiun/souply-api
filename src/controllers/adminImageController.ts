import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    buildImageQueuePickSql,
    hydrateImageQueueRows,
    countOutstandingImageQueue,
} from '../models/adminImageQueueModel.js';
import {
    claimBatch,
    completeLease,
    releaseAdminBatch,
    getActiveLeasesForAdmin,
} from '../models/adminLeaseModel.js';
import { updateStoreProductImageUrl } from '../models/storeProductModel.js';
import { logAdminAction, markAuditReversed } from '../services/adminActionLog.js';

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;

/**
 * Admin image-cleanup tab endpoints.
 *
 * Auth: every route is gated by requireAdmin + adminRateLimit at the
 * router level. `req.headers['x-admin-id']` is always a valid admin id
 * by the time these handlers run.
 *
 * Action endpoints all share the same shape: small JSON body, single
 * DB write + audit log row + ImagePropagationLog row when applicable.
 * Any unexpected failure surfaces as 500 via next(error).
 */

function adminIdOf(req: Request): string {
    return String(req.headers['x-admin-id']);
}

// ── GET /api/admin/images/queue ─────────────────────────────────────
// Returns the admin's currently-active batch of leased cards. Empty
// when the admin hasn't claimed yet — client should call claim-batch
// after this returns an empty list.
export const getImageQueue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const leases = await getActiveLeasesForAdmin(adminId, 'image');
        const spIds = leases.map(l => l.spId);
        const rows = await hydrateImageQueueRows(spIds, (req as any).locale);
        const outstanding = await countOutstandingImageQueue();
        res.json({ rows, outstanding, leaseCount: leases.length });
    } catch (e) { next(e); }
};

// ── POST /api/admin/images/claim-batch ──────────────────────────────
// Atomically reserves the next N highest-priority cards for this admin.
// If the admin already has an active batch, returns it as-is (resumes)
// — prevents accidentally claiming a second batch while one is open.
//
// Body: { size?: number }   default 10, max 25
export const claimImageBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const requested = Number((req.body as any)?.size ?? DEFAULT_BATCH_SIZE);
        const size = Math.max(1, Math.min(MAX_BATCH_SIZE,
            Number.isFinite(requested) ? requested : DEFAULT_BATCH_SIZE));

        // Resume existing batch if any. The contract is "one batch per
        // admin at a time" — if the admin still has open leases, return
        // those instead of stacking another batch on top.
        const existing = await getActiveLeasesForAdmin(adminId, 'image');
        if (existing.length > 0) {
            const rows = await hydrateImageQueueRows(
                existing.map(l => l.spId),
                (req as any).locale,
            );
            const outstanding = await countOutstandingImageQueue();
            res.json({ rows, outstanding, leaseCount: existing.length, resumed: true });
            return;
        }

        const leases = await claimBatch({
            adminId,
            queueKind: 'image',
            batchSize: size,
            pickSql: buildImageQueuePickSql(),
        });
        const rows = await hydrateImageQueueRows(
            leases.map(l => l.spId),
            (req as any).locale,
        );
        const outstanding = await countOutstandingImageQueue();
        res.json({ rows, outstanding, leaseCount: leases.length, resumed: false });
    } catch (e) { next(e); }
};

// ── POST /api/admin/images/release-batch ────────────────────────────
// Releases every active lease this admin holds. Called when the admin
// taps "User panel" to leave the admin surface, so abandoned cards
// don't stay locked for the full 2h lease duration.
export const releaseImageBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = adminIdOf(req);
        const released = await releaseAdminBatch({ adminId, queueKind: 'image' });
        res.json({ released });
    } catch (e) { next(e); }
};

// ── POST /api/admin/images/:spId/adopt-candidate ────────────────────
// Body: { imageUrl, sourceType, sourceSpId?, pendingUploadId? }
// Adopts a candidate image. Behaviour depends on sourceType:
//   - cross_chain_sibling / base_product_link / admin_upload → just write
//   - pending_upload → also flip the PendingImageUpload row to approved
export const adoptCandidate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const spId = Number(req.params.spId);
        const { imageUrl, sourceType, sourceSpId, pendingUploadId } = (req.body ?? {}) as {
            imageUrl?: unknown;
            sourceType?: unknown;
            sourceSpId?: unknown;
            pendingUploadId?: unknown;
        };
        if (!Number.isFinite(spId) || typeof imageUrl !== 'string' || !imageUrl) {
            res.status(400).json({ error: 'spId + imageUrl required' });
            return;
        }
        const validSourceTypes = ['cross_chain_sibling', 'base_product_link', 'pending_upload', 'admin_upload'];
        const srcType = String(sourceType ?? '');
        if (!validSourceTypes.includes(srcType)) {
            res.status(400).json({ error: 'invalid sourceType' });
            return;
        }
        const adminId = adminIdOf(req);

        // Read current image for the audit log + propagation log.
        const [spRows]: any = await pool.query(
            `SELECT imageUrl FROM StoreProduct WHERE id = ? LIMIT 1`, [spId],
        );
        if (!spRows[0]) {
            res.status(404).json({ error: 'StoreProduct not found' });
            return;
        }
        const fromImageUrl = spRows[0].imageUrl ?? null;

        await updateStoreProductImageUrl(spId, imageUrl);

        await pool.query(
            `INSERT INTO ImagePropagationLog
                (spId, sourceType, sourceSpId, fromImageUrl, toImageUrl, actor)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                spId,
                srcType === 'pending_upload' ? 'user_upload_approved' :
                srcType === 'admin_upload' ? 'admin_upload' :
                'admin_adopt_candidate',
                srcType === 'pending_upload' ? null
                    : (typeof sourceSpId === 'number' ? sourceSpId : null),
                fromImageUrl,
                imageUrl,
                adminId,
            ],
        );

        if (srcType === 'pending_upload' && Number.isFinite(pendingUploadId as number)) {
            await pool.query(
                `UPDATE PendingImageUpload
                    SET status = 'approved', resolvedBy = ?, resolvedAt = NOW()
                  WHERE id = ?`,
                [adminId, pendingUploadId],
            );
        }

        await logAdminAction({
            adminUserId: adminId,
            action: srcType === 'pending_upload'
                ? 'image_adopt_pending_upload'
                : srcType === 'admin_upload'
                    ? 'image_admin_upload'
                    : 'image_adopt_candidate',
            targetType: 'StoreProduct',
            targetId: spId,
            valueBefore: { imageUrl: fromImageUrl },
            valueAfter: { imageUrl },
        });
        await completeLease({ adminId, queueKind: 'image', spId });

        res.json({ spId, imageUrl });
    } catch (e) { next(e); }
};

// ── POST /api/admin/images/:spId/remove ─────────────────────────────
// Nulls out the SP's image. Used when a user-flagged image is wrong and
// no replacement is available (or admin wants to clear before deciding).
export const removeImage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const spId = Number(req.params.spId);
        if (!Number.isFinite(spId)) {
            res.status(400).json({ error: 'invalid spId' });
            return;
        }
        const adminId = adminIdOf(req);
        const [spRows]: any = await pool.query(
            `SELECT imageUrl FROM StoreProduct WHERE id = ? LIMIT 1`, [spId],
        );
        if (!spRows[0]) {
            res.status(404).json({ error: 'StoreProduct not found' });
            return;
        }
        const fromImageUrl = spRows[0].imageUrl ?? null;
        await pool.query(`UPDATE StoreProduct SET imageUrl = NULL WHERE id = ?`, [spId]);
        await logAdminAction({
            adminUserId: adminId,
            action: 'image_remove',
            targetType: 'StoreProduct',
            targetId: spId,
            valueBefore: { imageUrl: fromImageUrl },
            valueAfter: { imageUrl: null },
        });
        await completeLease({ adminId, queueKind: 'image', spId });
        res.json({ spId, imageUrl: null });
    } catch (e) { next(e); }
};

// ── POST /api/admin/images/:spId/skip ───────────────────────────────
// No DB change beyond the audit row — the client uses this to record
// that the admin saw the card and chose not to act, so the queue
// doesn't keep resurfacing it to the same admin in the same session.
// Stale cards across sessions are filtered client-side; nothing here
// prevents another admin from seeing it.
export const skipImageCard = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const spId = Number(req.params.spId);
        if (!Number.isFinite(spId)) {
            res.status(400).json({ error: 'invalid spId' });
            return;
        }
        const adminId = adminIdOf(req);
        await logAdminAction({
            adminUserId: adminId,
            action: 'image_skip',
            targetType: 'StoreProduct',
            targetId: spId,
        });
        await completeLease({ adminId, queueKind: 'image', spId });
        res.json({ spId, skipped: true });
    } catch (e) { next(e); }
};

// ── POST /api/admin/images/:spId/reject-pending ─────────────────────
// Body: { pendingUploadId }
export const rejectPendingUpload = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const spId = Number(req.params.spId);
        const { pendingUploadId } = (req.body ?? {}) as { pendingUploadId?: unknown };
        if (!Number.isFinite(spId) || !Number.isFinite(pendingUploadId as number)) {
            res.status(400).json({ error: 'spId + pendingUploadId required' });
            return;
        }
        const adminId = adminIdOf(req);
        const [puRows]: any = await pool.query(
            `SELECT spId, filePath, status FROM PendingImageUpload WHERE id = ? LIMIT 1`,
            [pendingUploadId],
        );
        if (!puRows[0]) {
            res.status(404).json({ error: 'PendingImageUpload not found' });
            return;
        }
        await pool.query(
            `UPDATE PendingImageUpload
                SET status = 'rejected', resolvedBy = ?, resolvedAt = NOW()
              WHERE id = ?`,
            [adminId, pendingUploadId],
        );
        await logAdminAction({
            adminUserId: adminId,
            action: 'image_reject_pending',
            targetType: 'PendingImageUpload',
            targetId: Number(pendingUploadId),
            valueBefore: { status: puRows[0].status, filePath: puRows[0].filePath },
            valueAfter: { status: 'rejected' },
        });
        // Rejecting a pending upload doesn't necessarily resolve the
        // whole card — the SP can still have other candidates. Don't
        // complete the lease here; the admin will do another action
        // (adopt, remove, or skip) to finish the card.
        res.json({ pendingUploadId, status: 'rejected' });
    } catch (e) { next(e); }
};

// ── POST /api/admin/issues/:issueKey/resolve ────────────────────────
// Body: { receiptId, receiptLineIdx, userId }  (composite PK of ReceiptLineIssue)
// Used by the card UI to close out the user-flagged issue after the
// admin takes action (adopt/remove/upload). Idempotent — re-resolving
// an already-resolved row is a no-op.
export const resolveReceiptLineIssue = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { receiptId, receiptLineIdx, userId } = (req.body ?? {}) as {
            receiptId?: unknown;
            receiptLineIdx?: unknown;
            userId?: unknown;
        };
        if (!Number.isFinite(receiptId as number) ||
            !Number.isFinite(receiptLineIdx as number) ||
            typeof userId !== 'string') {
            res.status(400).json({ error: 'receiptId + receiptLineIdx + userId required' });
            return;
        }
        const adminId = adminIdOf(req);
        await pool.query(
            `UPDATE ReceiptLineIssue
                SET status = 'resolved', resolvedBy = ?, resolvedAt = NOW()
              WHERE receiptId = ? AND receiptLineIdx = ? AND userId = ?
                AND status = 'pending'`,
            [adminId, receiptId, receiptLineIdx, userId],
        );
        // No audit row — this is a downstream effect of the adopt/remove
        // action that already logged. Logging twice would inflate the
        // rate-limit counter for what is one logical operation.
        res.json({ resolved: true });
    } catch (e) { next(e); }
};

// ── POST /api/admin/images/revert/:auditId ──────────────────────────
// Reverses an earlier admin or auto propagation. Reads the audit row +
// ImagePropagationLog, restores the previous imageUrl, marks both rows
// as reversed.
export const revertImageChange = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const auditId = Number(req.params.auditId);
        if (!Number.isFinite(auditId)) {
            res.status(400).json({ error: 'invalid auditId' });
            return;
        }
        const adminId = adminIdOf(req);
        const [auditRows]: any = await pool.query(
            `SELECT id, action, targetType, targetId, valueBefore, valueAfter, reversedAt
               FROM AdminAuditLog
              WHERE id = ? LIMIT 1`,
            [auditId],
        );
        const audit = auditRows[0];
        if (!audit) {
            res.status(404).json({ error: 'audit row not found' });
            return;
        }
        if (audit.reversedAt) {
            res.status(409).json({ error: 'already reversed' });
            return;
        }
        if (audit.targetType !== 'StoreProduct') {
            res.status(400).json({ error: 'audit row is not an image action' });
            return;
        }

        // mysql2 returns JSON columns as already-parsed values when the
        // server declares them JSON; fall through to JSON.parse when a
        // string sneaks in (older drivers / strict modes).
        const parseJson = (v: any) => {
            if (v == null) return null;
            if (typeof v === 'string') {
                try { return JSON.parse(v); } catch { return null; }
            }
            return v;
        };
        const before = parseJson(audit.valueBefore);
        const after = parseJson(audit.valueAfter);
        const restoreUrl = before?.imageUrl ?? null;

        const [spRows]: any = await pool.query(
            `SELECT imageUrl FROM StoreProduct WHERE id = ? LIMIT 1`, [audit.targetId],
        );
        if (!spRows[0]) {
            res.status(404).json({ error: 'StoreProduct not found' });
            return;
        }
        if (restoreUrl === null) {
            await pool.query(`UPDATE StoreProduct SET imageUrl = NULL WHERE id = ?`, [audit.targetId]);
        } else {
            await updateStoreProductImageUrl(audit.targetId, restoreUrl);
        }

        await markAuditReversed(auditId);
        // Also mark the matching ImagePropagationLog row if there is one
        // that points at the same toImageUrl.
        await pool.query(
            `UPDATE ImagePropagationLog
                SET reversedAt = NOW()
              WHERE spId = ? AND toImageUrl = ? AND reversedAt IS NULL
              ORDER BY id DESC LIMIT 1`,
            [audit.targetId, after?.imageUrl ?? ''],
        );

        await logAdminAction({
            adminUserId: adminId,
            action: 'image_revert',
            targetType: 'StoreProduct',
            targetId: Number(audit.targetId),
            valueBefore: { imageUrl: after?.imageUrl ?? null },
            valueAfter: { imageUrl: restoreUrl },
        });

        res.json({ spId: audit.targetId, imageUrl: restoreUrl });
    } catch (e) { next(e); }
};

// ── GET /api/admin/audit ────────────────────────────────────────────
// Paginated audit log, newest first. Used by the audit-log viewer.
export const getAuditLog = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const page = Number(req.query.page ?? 0);
        const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 50)));
        const [rows]: any = await pool.query(
            `SELECT id, adminUserId, action, targetType, targetId,
                    valueBefore, valueAfter, reversedAt, createdAt
               FROM AdminAuditLog
              ORDER BY id DESC
              LIMIT ? OFFSET ?`,
            [pageSize, page * pageSize],
        );
        res.json({ rows, page, pageSize });
    } catch (e) { next(e); }
};
