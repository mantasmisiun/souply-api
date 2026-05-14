import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';

/**
 * Rolling 1-hour write-action limit per admin. 200 actions/hour matches
 * the cap specced in admin-panel.md. Counted via `AdminAuditLog` rows
 * — reads (queue fetch, audit list) aren't logged and so don't count.
 *
 * On breach: 429 + telegram-worthy server log line. The admin doesn't
 * get auto-frozen at this layer (that's a future feature); the limit
 * just protects the DB from a runaway admin script.
 */

const MAX_ACTIONS_PER_HOUR = 200;

export const adminRateLimit = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    const adminId = req.headers['x-admin-id'];
    if (typeof adminId !== 'string' || !adminId.trim()) {
        // requireAdmin runs before this — if we got here without a header
        // it means the route wiring is wrong. Surface as 500 not 401 so
        // it's obvious in logs.
        res.status(500).json({ error: 'adminRateLimit reached without X-Admin-Id' });
        return;
    }
    const [rows]: any = await pool.query(
        `SELECT COUNT(*) AS n FROM AdminAuditLog
          WHERE adminUserId = ?
            AND createdAt > NOW() - INTERVAL 1 HOUR`,
        [adminId.trim()],
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n >= MAX_ACTIONS_PER_HOUR) {
        console.warn(`[adminRateLimit] admin=${adminId} hit ${n}/${MAX_ACTIONS_PER_HOUR}/h — rejecting`);
        res.status(429).json({ error: 'Admin action rate limit exceeded', retryAfterMinutes: 60 });
        return;
    }
    next();
};
