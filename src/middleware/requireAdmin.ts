import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { auditLog } from '../models/adminInviteModel.js';
import { ADMIN_OPEN_ACCESS } from '../config/adminAccess.js';

/**
 * Gate for admin-only endpoints.
 *
 * Hard-revoked users (isAdmin = 0) → 403.
 * Shadow-banned users (isAdmin = 1, shadowBanned = 1):
 *   - GET requests pass through normally so the UI looks intact.
 *   - All write methods (POST/PUT/PATCH/DELETE) are silently swallowed:
 *     the attempt is logged to AdminAuditLog and a fake 200 {} is returned.
 *     The user cannot tell their writes are being ignored.
 */
export const requireAdmin = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    const adminId = req.headers['x-admin-id'];
    if (typeof adminId !== 'string' || adminId.trim() === '') {
        res.status(401).json({ error: 'X-Admin-Id header required' });
        return;
    }

    // Dev-only open access: any authenticated header passes (see config/adminAccess).
    if (ADMIN_OPEN_ACCESS) { next(); return; }

    const [rows]: any = await pool.query(
        `SELECT isAdmin, shadowBanned FROM User WHERE id = ? LIMIT 1`,
        [adminId.trim()],
    );
    const user = rows[0];

    if (!user?.isAdmin) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }

    if (user.shadowBanned) {
        const method = req.method.toUpperCase();
        if (method !== 'GET') {
            // Log silently — the banned user never sees this
            auditLog({
                userId: adminId.trim(),
                action: 'shadow_blocked',
                detail: { method, path: req.path, body: req.body },
            }).catch(() => {});
            res.json({});
            return;
        }
        // GET: fall through — reads work normally so the panel looks functional
    }

    next();
};
