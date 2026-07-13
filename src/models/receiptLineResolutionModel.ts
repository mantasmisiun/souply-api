import pool from '../config/db.js';

/**
 * The per-line "ask-once" ledger (table ReceiptLineResolution, sql/receipt_line_resolution.sql).
 * The swipe queue suppresses any line that already has a row here, so a rejected
 * or auto-resolved item is never re-carded. See shared/SWIPE_QUEUE_REDESIGN.md.
 */

type Db = typeof pool | any;

export type ResolutionStatus = 'asked' | 'resolved_user' | 'resolved_system';

/**
 * Record that a line was ASKED (a card served, or a fast/burst swipe). INSERT
 * IGNORE so it never downgrades an already-resolved row — asked is the weakest
 * state and only matters when no stronger row exists yet.
 */
export const markLineAsked = async (receiptId: number, lineIdx: number, db: Db = pool): Promise<void> => {
    await db.query(
        'INSERT IGNORE INTO ReceiptLineResolution (receiptId, receiptLineIdx, status) VALUES (?, ?, ?)',
        [receiptId, lineIdx, 'asked'],
    );
};

/**
 * Record that a line was RESOLVED — by the user (a swipe) or by a system action.
 * Upserts so it upgrades an earlier 'asked' row and overwrites the reason.
 */
export const markLineResolved = async (
    receiptId: number,
    lineIdx: number,
    by: 'user' | 'system',
    via: string | null,
    db: Db = pool,
): Promise<void> => {
    const status: ResolutionStatus = by === 'user' ? 'resolved_user' : 'resolved_system';
    await db.query(
        `INSERT INTO ReceiptLineResolution (receiptId, receiptLineIdx, status, resolvedVia)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), resolvedVia = VALUES(resolvedVia)`,
        [receiptId, lineIdx, status, via],
    );
};

/**
 * The set of line indices already asked/resolved for a receipt — the one-shot
 * suppression set the queue filters against.
 */
export const getResolvedLineIdxSet = async (receiptId: number, db: Db = pool): Promise<Set<number>> => {
    const [rows]: any = await db.query(
        'SELECT receiptLineIdx FROM ReceiptLineResolution WHERE receiptId = ?',
        [receiptId],
    );
    return new Set((Array.isArray(rows) ? rows : []).map((r: any) => Number(r.receiptLineIdx)));
};
