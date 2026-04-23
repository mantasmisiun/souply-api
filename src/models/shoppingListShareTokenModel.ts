import { randomBytes } from 'crypto';
import pool from '../config/db.js';

// Share tokens are short-lived handoff secrets (default 10 min). Long
// enough for a user to pass their phone around, short enough that a
// leaked screenshot stops working quickly.
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface ShareTokenRow {
    id: number;
    listId: number;
    token: string;
    createdBy: string;
    expiresAt: string;
    claimedAt: string | null;
    claimedBy: string | null;
}

export const createShareToken = async (
    listId: number,
    createdBy: string,
    ttlMs: number = DEFAULT_TTL_MS
): Promise<{ token: string; expiresAt: Date }> => {
    // 24 bytes of randomness → 48 hex chars — well short of the VARCHAR(64)
    // column limit and far beyond brute-force reach for a 10-min window.
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs);
    await pool.query(
        'INSERT INTO ShoppingListShareToken (listId, token, createdBy, expiresAt) VALUES (?, ?, ?, ?)',
        [listId, token, createdBy, expiresAt]
    );
    return { token, expiresAt };
};

export const getShareTokenByToken = async (token: string): Promise<ShareTokenRow | null> => {
    const [rows]: any = await pool.query(
        'SELECT * FROM ShoppingListShareToken WHERE token = ? LIMIT 1',
        [token]
    );
    return rows[0] ?? null;
};

export const markShareTokenClaimed = async (
    token: string,
    claimedBy: string
): Promise<boolean> => {
    // Single-flight claim. The claimedAt IS NULL predicate ensures only
    // the first concurrent claim wins; the rest get affectedRows=0 and
    // the caller treats that as "already claimed".
    const [result]: any = await pool.query(
        `UPDATE ShoppingListShareToken
            SET claimedAt = NOW(), claimedBy = ?
          WHERE token = ? AND claimedAt IS NULL AND expiresAt > NOW()`,
        [claimedBy, token]
    );
    return result.affectedRows > 0;
};
