import pool from '../config/db.js';

type Connection = typeof pool | any;

/**
 * Apply a delta to the cross-baseProduct link counter for the pair
 * (bpIdA, bpIdB). Sorts into canonical order at the write boundary so the
 * row exists exactly once regardless of how the caller passes the IDs.
 *
 * `delta` is typically ±1 — a "similar" swipe increments, changing away
 * from / undoing a "similar" swipe decrements. We clamp with GREATEST to
 * avoid negatives even if an undo arrives when the counter has already been
 * reset (e.g. an admin cleared the row).
 */
export const applyBaseProductLinkDelta = async (
    bpIdA: number,
    bpIdB: number,
    delta: number,
    conn?: Connection
): Promise<void> => {
    if (bpIdA === bpIdB) return; // same base → not a cross-link
    if (delta === 0) return;

    if (bpIdA > bpIdB) {
        const tmp = bpIdA;
        bpIdA = bpIdB;
        bpIdB = tmp;
    }

    const db = conn || pool;
    // Bind the delta twice — once for the INSERT's clamped initial value,
    // once for the UPDATE clause. We can't use VALUES(similarVoteCount) here
    // because MySQL returns the post-expression value (so a clamped INSERT
    // of GREATEST(0, -1) leaks as 0 into VALUES(), nullifying the update).
    await db.query(
        `INSERT INTO BaseProductLink (bpIdA, bpIdB, similarVoteCount)
             VALUES (?, ?, GREATEST(0, ?))
         ON DUPLICATE KEY UPDATE
             similarVoteCount = GREATEST(0, similarVoteCount + ?)`,
        [bpIdA, bpIdB, delta, delta]
    );
};

export interface BaseProductLink {
    bpIdA: number;
    bpIdB: number;
    similarVoteCount: number;
    lastVoteAt: Date;
}

/**
 * Fetch one cross-baseProduct link (for admin review).
 */
export const getBaseProductLink = async (
    bpIdA: number,
    bpIdB: number,
    conn?: Connection
): Promise<BaseProductLink | null> => {
    if (bpIdA > bpIdB) {
        const tmp = bpIdA;
        bpIdA = bpIdB;
        bpIdB = tmp;
    }
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT bpIdA, bpIdB, similarVoteCount, lastVoteAt
           FROM BaseProductLink
          WHERE bpIdA = ? AND bpIdB = ? LIMIT 1`,
        [bpIdA, bpIdB]
    );
    return rows[0] ?? null;
};

/**
 * All links above a vote count, sorted desc. For the admin "which
 * baseProducts should I manually merge?" review list.
 */
export const listBaseProductLinksAboveThreshold = async (
    minVotes: number,
    limit: number = 50
): Promise<BaseProductLink[]> => {
    const [rows]: any = await pool.query(
        `SELECT bpIdA, bpIdB, similarVoteCount, lastVoteAt
           FROM BaseProductLink
          WHERE similarVoteCount >= ?
          ORDER BY similarVoteCount DESC
          LIMIT ?`,
        [minVotes, limit]
    );
    return rows;
};
