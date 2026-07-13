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
 * the ledger. Returns the previous vote value AND whether that previous vote
 * was actually counted into the StoreProductMatch aggregate (`aggregated`
 * provenance) — burst votes write a row but skip the aggregate, so callers
 * must adjust deltas by what was REALLY counted, not by what the row said.
 *
 * `aggregated` records whether THIS write will be counted (the caller applies
 * the matching delta via applyVoteTransitionDeltas).
 */
export const upsertMatchVote = async (
    userId: string,
    spIdA: number,
    spIdB: number,
    vote: MatchVote,
    dwellMs: number | null,
    receiptId: number | null,
    aggregated: boolean,
    conn?: Connection
): Promise<{ previousVote: MatchVote | null; previousAggregated: boolean }> => {
    const db = conn || pool;
    if (spIdA >= spIdB) {
        throw new Error('upsertMatchVote requires spIdA < spIdB — use orderPair() first');
    }

    const [existing]: any = await db.query(
        `SELECT vote, aggregated FROM StoreProductMatchVote
          WHERE userId = ? AND spIdA = ? AND spIdB = ? LIMIT 1`,
        [userId, spIdA, spIdB]
    );
    const previousVote: MatchVote | null = existing[0]?.vote ?? null;
    const previousAggregated: boolean = !!existing[0]?.aggregated;

    if (previousVote === null) {
        await db.query(
            `INSERT INTO StoreProductMatchVote
               (userId, spIdA, spIdB, vote, dwellMs, receiptId, aggregated)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, spIdA, spIdB, vote, dwellMs, receiptId, aggregated ? 1 : 0]
        );
    } else if (previousVote !== vote || previousAggregated !== aggregated) {
        await db.query(
            `UPDATE StoreProductMatchVote
                SET vote = ?, dwellMs = ?, receiptId = ?, aggregated = ?
              WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [vote, dwellMs, receiptId, aggregated ? 1 : 0, userId, spIdA, spIdB]
        );
    }
    return { previousVote, previousAggregated };
};

/**
 * Provenance-aware aggregate transition — the ONE place the "what was counted vs
 * what is now counted" math lives, shared by every vote-writing service.
 *
 *   previousVote/previousAggregated — from upsertMatchVote's return.
 *   newVote — the vote now on the row, or NULL when it is NOT being counted
 *             (burst write, or a deletion).
 *
 * Decrements the old contribution only if it was actually counted; increments the
 * new one only when it isn't already counted at the same value. Handles every
 * burst↔non-burst re-vote combination without double-counting or going negative.
 */
export const applyVoteTransitionDeltas = async (
    spIdA: number,
    spIdB: number,
    previousVote: MatchVote | null,
    previousAggregated: boolean,
    newVote: MatchVote | null,
    conn?: Connection
): Promise<void> => {
    const prevCounted = previousVote !== null && previousAggregated;
    if (prevCounted && previousVote !== newVote) {
        await applyAggregateDelta(spIdA, spIdB, previousVote!, -1, conn);
    }
    if (newVote !== null && !(prevCounted && previousVote === newVote)) {
        await applyAggregateDelta(spIdA, spIdB, newVote, +1, conn);
    }
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

    // INSERT ... ON DUPLICATE KEY UPDATE keeps this single-round-trip. GREATEST(0, …)
    // clamps both paths: a decrement can never take a count negative (residual
    // pre-provenance histories) and a fresh row can never be created at -1.
    await db.query(
        `INSERT INTO StoreProductMatch (spIdA, spIdB, ${column})
             VALUES (?, ?, GREATEST(0, ?))
         ON DUPLICATE KEY UPDATE ${column} = GREATEST(0, ${column} + VALUES(${column}))`,
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
 * Delete a user's vote and return what it was PLUS whether it was actually counted
 * into the aggregate — the caller reverses the aggregate/link contributions only
 * when `deletedAggregated` is true (a burst row was never counted).
 */
export const deleteMatchVote = async (
    userId: string,
    spIdA: number,
    spIdB: number,
    conn?: Connection
): Promise<{ deletedVote: MatchVote | null; deletedAggregated: boolean }> => {
    const db = conn || pool;
    if (spIdA >= spIdB) {
        throw new Error('deleteMatchVote requires spIdA < spIdB');
    }

    const [existing]: any = await db.query(
        `SELECT vote, aggregated FROM StoreProductMatchVote
          WHERE userId = ? AND spIdA = ? AND spIdB = ? LIMIT 1`,
        [userId, spIdA, spIdB]
    );
    if (existing.length === 0) {
        return { deletedVote: null, deletedAggregated: false };
    }
    await db.query(
        `DELETE FROM StoreProductMatchVote
           WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
        [userId, spIdA, spIdB]
    );
    return { deletedVote: existing[0].vote as MatchVote, deletedAggregated: !!existing[0].aggregated };
};

export interface VoteHistoryRow {
    spIdA: number;
    spIdB: number;
    vote: MatchVote;
    dwellMs: number | null;
    createdAt: Date;
    updatedAt: Date;
    nameA: string;
    imageUrlA: string | null;
    chainNameA: string;
    chainLogoUrlA: string | null;
    nameB: string;
    imageUrlB: string | null;
    chainNameB: string;
    chainLogoUrlB: string | null;
}

export interface VoteHistoryOpts {
    limit?: number;
    cursor?: string;   // opaque: base64(JSON({ d: updatedAt ISO, id: spIdA }))
    search?: string;
    vote?: MatchVote;
}

export interface VoteHistoryPage {
    votes: VoteHistoryRow[];
    nextCursor: string | null;
}

/**
 * Paginated vote history for a user. Sorted newest-updated-first with spIdA
 * as a tiebreak so the cursor is stable even when two rows share the same
 * updatedAt second.
 *
 * Fetches limit+1 rows to cheaply detect whether a next page exists without
 * a separate COUNT query.
 */
export const getVoteHistory = async (
    userId: string,
    opts: VoteHistoryOpts = {},
    conn?: Connection,
): Promise<VoteHistoryPage> => {
    const db = conn || pool;
    const limit = Math.min(opts.limit ?? 15, 50);

    const conditions: string[] = ['v.userId = ?'];
    const params: any[] = [userId];

    if (opts.search?.trim()) {
        const term = `%${opts.search.trim()}%`;
        conditions.push('(spA.storeProductName LIKE ? OR spB.storeProductName LIKE ?)');
        params.push(term, term);
    }

    if (opts.vote) {
        conditions.push('v.vote = ?');
        params.push(opts.vote);
    }

    if (opts.cursor) {
        try {
            const { d, id } = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8'));
            conditions.push('(v.updatedAt < ? OR (v.updatedAt = ? AND v.spIdA > ?))');
            params.push(d, d, id);
        } catch { /* ignore malformed cursor — just return from the start */ }
    }

    params.push(limit + 1);

    const [rows]: any = await db.query(
        `SELECT
             v.spIdA, v.spIdB, v.vote, v.dwellMs, v.createdAt, v.updatedAt,
             spA.storeProductName AS nameA,
             spA.imageUrl         AS imageUrlA,
             scA.name             AS chainNameA,
             scA.logoUrl          AS chainLogoUrlA,
             spB.storeProductName AS nameB,
             spB.imageUrl         AS imageUrlB,
             scB.name             AS chainNameB,
             scB.logoUrl          AS chainLogoUrlB
           FROM StoreProductMatchVote v
           JOIN StoreProduct spA ON spA.id = v.spIdA
           JOIN StoreChain   scA ON scA.id = spA.chainId
           JOIN StoreProduct spB ON spB.id = v.spIdB
           JOIN StoreChain   scB ON scB.id = spB.chainId
          WHERE ${conditions.join(' AND ')}
          ORDER BY v.updatedAt DESC, v.spIdA ASC
          LIMIT ?`,
        params,
    );

    const hasMore = rows.length > limit;
    const votes: VoteHistoryRow[] = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && votes.length > 0) {
        const last = votes[votes.length - 1];
        const d = last.updatedAt instanceof Date
            ? last.updatedAt.toISOString()
            : String(last.updatedAt);
        nextCursor = Buffer.from(JSON.stringify({ d, id: last.spIdA })).toString('base64url');
    }

    return { votes, nextCursor };
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
