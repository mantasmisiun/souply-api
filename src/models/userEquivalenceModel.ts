import pool from '../config/db.js';

type Connection = typeof pool | any;

export type EquivalenceVerdict = 'same' | 'different';

export interface UserEquivalence {
    id: number;
    userId: string;
    spIdA: number;
    spIdB: number;
    verdict: EquivalenceVerdict;
}

const orderPair = (a: number, b: number) => ({ spIdA: Math.min(a, b), spIdB: Math.max(a, b) });

export const upsertEquivalence = async (
    userId: string,
    spA: number,
    spB: number,
    verdict: EquivalenceVerdict,
    conn?: Connection
) => {
    const db = conn ?? pool;
    const { spIdA, spIdB } = orderPair(spA, spB);
    await db.query(
        `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE verdict = VALUES(verdict), updatedAt = CURRENT_TIMESTAMP`,
        [userId, spIdA, spIdB, verdict]
    );
};

export const getEquivalencesForUser = async (userId: string): Promise<UserEquivalence[]> => {
    const [rows]: any = await pool.query(
        `SELECT id, userId, spIdA, spIdB, verdict
           FROM UserStoreProductEquivalence
          WHERE userId = ?`,
        [userId]
    );
    return rows;
};

// Returns all SP IDs the user considers equivalent to any of the given SP IDs.
// Used by L2 browse to expand a product cluster with user's personal merges.
export const getEquivalentSpIds = async (
    userId: string,
    spIds: number[]
): Promise<Map<number, number[]>> => {
    if (spIds.length === 0) return new Map();
    const [rows]: any = await pool.query(
        `SELECT spIdA, spIdB, verdict
           FROM UserStoreProductEquivalence
          WHERE userId = ?
            AND verdict = 'same'
            AND (spIdA IN (?) OR spIdB IN (?))`,
        [userId, spIds, spIds]
    );
    const map = new Map<number, number[]>();
    for (const row of rows) {
        const a: number = row.spIdA;
        const b: number = row.spIdB;
        if (!map.has(a)) map.set(a, []);
        if (!map.has(b)) map.set(b, []);
        map.get(a)!.push(b);
        map.get(b)!.push(a);
    }
    return map;
};

// For a given list of product IDs (from an L2 browse category), returns a map
// of { hideProductId → keepProductId } based on the user's personal 'same' verdicts.
// Products linked by a user equivalence where both SPs belong to different products
// collapse into one row: the one with the lower id is kept, the other hidden.
// Only direct pairs are considered (no transitivity).
export const getUserProductMergeMap = async (
    userId: string,
    productIds: number[]
): Promise<Map<number, number>> => {
    if (productIds.length === 0) return new Map();
    const [rows]: any = await pool.query(
        `SELECT LEAST(sp1.productId, sp2.productId)    AS keepId,
                GREATEST(sp1.productId, sp2.productId) AS hideId
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
          WHERE e.userId = ?
            AND e.verdict = 'same'
            AND sp1.productId != sp2.productId
            AND sp1.productId IN (?)
            AND sp2.productId IN (?)`,
        [userId, productIds, productIds]
    );
    const map = new Map<number, number>();
    for (const row of rows) map.set(row.hideId, row.keepId);
    return map;
};

export const deleteEquivalence = async (userId: string, spA: number, spB: number) => {
    const { spIdA, spIdB } = orderPair(spA, spB);
    await pool.query(
        `DELETE FROM UserStoreProductEquivalence WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
        [userId, spIdA, spIdB]
    );
};
