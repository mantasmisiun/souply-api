import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';

/**
 * Gate for admin-only endpoints. Reads the X-Admin-Id request header and
 * verifies the user has isAdmin = 1 in the database. Returns 401 when the
 * header is missing and 403 when the user is not an admin or does not exist.
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
    const [rows]: any = await pool.query(
        `SELECT isAdmin FROM User WHERE id = ? LIMIT 1`, [adminId.trim()],
    );
    if (!rows[0]?.isAdmin) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    next();
};
