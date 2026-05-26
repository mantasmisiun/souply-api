import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { auditLog } from '../models/adminInviteModel.js';

/**
 * Gate for superadmin-only endpoints (role = 'superadmin').
 *
 * Inherits all behaviour from requireAdmin:
 *   - Missing X-Admin-Id header → 401
 *   - isAdmin = false → 403
 *   - role != 'superadmin' → 403
 *   - shadowBanned + write method → silently swallowed, audit logged
 */
export const requireSuperAdmin = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    const adminId = req.headers['x-admin-id'];
    if (typeof adminId !== 'string' || adminId.trim() === '') {
        res.status(401).json({ error: 'X-Admin-Id header required' });
        return;
    }

    const [rows]: any = await pool.query(
        `SELECT isAdmin, shadowBanned, adminRole FROM User WHERE id = ? LIMIT 1`,
        [adminId.trim()],
    );
    const user = rows[0];

    if (!user?.isAdmin || user.adminRole !== 'superadmin') {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }

    if (user.shadowBanned) {
        const method = req.method.toUpperCase();
        if (method !== 'GET') {
            auditLog({
                userId: adminId.trim(),
                action: 'shadow_blocked',
                detail: { method, path: req.path, body: req.body },
            }).catch(() => {});
            res.json({});
            return;
        }
    }

    next();
};
