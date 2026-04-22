import pool from '../config/db.js';

type Connection = typeof pool | any;

export type MatchVote = 'identical' | 'similar' | 'different';

export interface MatchAggregate {
    spIdA: number;
    spIdB: number;
    identicalVotes: number;
    similarVotes: number;
    differentVotes: number;
}

/**
 * Normalize a pair into canonical (smaller, larger) order. The whole voting
 * system is symmetric so we store each pair once; callers pass arbitrary
 * order and this helper sorts it.
 */
export function orderPair(a: number, b: number): { spIdA: number; spIdB: number } {
    return a < b ? { spIdA: a, spIdB: b } : { spIdA: b, spIdB: a };
}

/**
 * Upsert a user's vote for a pair. Unique index on (userId, spIdA, spIdB)
 * means a repeat vote from the same user overwrites rather than stuffing
 * the ledger. Returns the previous vote value (if any) so the caller can
 * adjust the aggregate counts by the net delta instead of recomputing.
 */
export const upsertMatchVote = async (
    userId: string,
    spIdA: number,
    spIdB: number,
    vote: MatchVote,
    dwellMs: number,
    receiptId: number | null,
    conn?: Connection
): Promise<{ previousVote: MatchVote | null }> => {
    const db = conn || pool;
    if (spIdA >= spIdB) {
        throw new Error('upsertMatchVote requires spIdA < spIdB — use orderPair() first');
    }

    const [existing]: any = await db.query(
        `SELECT vote FROM StoreProductMatchVote
          WHERE userId = ? AND spIdA = ? AND spIdB = ? LIMIT 1`,
        [userId, spIdA, spIdB]
    );
    const previousVote: MatchVote | null = existing[0]?.vote ?? null;

    if (previousVote === null) {
        await db.query(
            `INSERT INTO StoreProductMatchVote
               (userId, spIdA, spIdB, vote, dwellMs, receiptId)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, spIdA, spIdB, vote, dwellMs, receiptId]
        );
    } else if (previousVote !== vote) {
        await db.query(
            `UPDATE StoreProductMatchVote
                SET vote = ?, dwellMs = ?, receiptId = ?, createdAt = CURRENT_TIMESTAMP
              WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [vote, dwellMs, receiptId, userId, spIdA, spIdB]
        );
    }
    return { previousVote };
};

/**
 * Apply a vote delta to the aggregate counts. Pass +1 for a newly-cast vote
 * and -1 for a retraction. When a user changes their vote from A to B in one
 * motion, call this twice: -1 for A, +1 for B. Upserts the aggregate row if
 * it doesn't exist yet.
 */
export const applyAggregateDelta = async (
    spIdA: number,
    spIdB: number,
    vote: MatchVote,
    delta: number,
    conn?: Connection
): Promise<void> => {
    if (spIdA >= spIdB) {
        throw new Error('applyAggregateDelta requires spIdA < spIdB');
    }
    if (delta === 0) return;
    const db = conn || pool;
    const column =
        vote === 'identical' ? 'identicalVotes' :
        vote === 'similar'   ? 'similarVotes'   :
                               'differentVotes';

    // INSERT ... ON DUPLICATE KEY UPDATE keeps this single-round-trip.
    await db.query(
        `INSERT INTO StoreProductMatch (spIdA, spIdB, ${column})
             VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ${column} = ${column} + VALUES(${column})`,
        [spIdA, spIdB, delta]
    );
};

export const getMatchAggregate = async (
    spIdA: number,
    spIdB: number,
    conn?: Connection
): Promise<MatchAggregate | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT spIdA, spIdB, identicalVotes, similarVotes, differentVotes
           FROM StoreProductMatch
          WHERE spIdA = ? AND spIdB = ? LIMIT 1`,
        [spIdA, spIdB]
    );
    return rows[0] ?? null;
};

/**
 * Delete a user's vote and return what it was (for aggregate reversal).
 */
export const deleteMatchVote = async (
    userId: string,
    spIdA: number,
    spIdB: number,
    conn?: Connection
): Promise<{ deletedVote: MatchVote | null }> => {
    const db = conn || pool;
    if (spIdA >= spIdB) {
        throw new Error('deleteMatchVote requires spIdA < spIdB');
    }

    const [existing]: any = await db.query(
        `SELECT vote FROM StoreProductMatchVote
          WHERE userId = ? AND spIdA = ? AND spIdB = ? LIMIT 1`,
        [userId, spIdA, spIdB]
    );
    if (existing.length === 0) {
        return { deletedVote: null };
    }
    await db.query(
        `DELETE FROM StoreProductMatchVote
           WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
        [userId, spIdA, spIdB]
    );
    return { deletedVote: existing[0].vote as MatchVote };
};

/**
 * Rate-limit helper: how many votes has this user cast in the last `windowSec`?
 */
export const countRecentVotes = async (
    userId: string,
    windowSec: number,
    conn?: Connection
): Promise<number> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT COUNT(*) AS c FROM StoreProductMatchVote
          WHERE userId = ? AND createdAt >= (NOW() - INTERVAL ? SECOND)`,
        [userId, windowSec]
    );
    return rows[0]?.c ?? 0;
};
