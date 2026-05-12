import pool from '../config/db.js';

/**
 * Return the set of SP pair keys that `userId` has already voted on.
 * Format: "min(spIdA,spIdB)-max(spIdA,spIdB)" — matches the canonical key
 * used by buildSlot2Queue / buildSlot3Queue.
 *
 * StoreProductMatchVote stores pairs in canonical (spIdA < spIdB) order, so
 * we can CONCAT directly without LEAST/GREATEST.
 */
export async function fetchVotedPairKeys(userId: string): Promise<Set<string>> {
    const [rows]: any = await pool.query(
        `SELECT CONCAT(spIdA, '-', spIdB) AS pairKey
           FROM StoreProductMatchVote
          WHERE userId = ?`,
        [userId],
    );
    return new Set((rows as any[]).map(r => String(r.pairKey)));
}
