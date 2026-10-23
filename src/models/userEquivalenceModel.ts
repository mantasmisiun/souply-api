import pool from '../config/db.js';

type Connection = typeof pool | any;

export type EquivalenceVerdict = 'same' | 'different';

export interface UserEquivalence {
    id: number;
    userId: string;
    spIdA: number;
    spIdB: number;
    verdict: EquivalenceVerdict;
    needsReverification: boolean;
}

const orderPair = (a: number, b: number) => ({ spIdA: Math.min(a, b), spIdB: Math.max(a, b) });

// ---------------------------------------------------------------------------
// Component helpers (union-find logic lives here, not in the service layer)
// ---------------------------------------------------------------------------

/**
 * Return all productIds directly connected to `productId` via 'same' verdicts
 * for this user. Because we normalise on write (all entries point to root),
 * one hop is enough to recover the full component.
 */
async function getComponentNeighbours(
    userId: string,
    productId: number,
    db: Connection,
): Promise<{ productId: number; spId: number }[]> {
    const [rows]: any = await db.query(
        `SELECT
             e.spIdA, e.spIdB,
             sp1.productId AS productIdA,
             sp2.productId AS productIdB
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
          WHERE e.userId = ?
            AND e.verdict = 'same'
            AND (sp1.productId = ? OR sp2.productId = ?)`,
        [userId, productId, productId],
    );

    return rows.map((r: any) => {
        const isA = r.productIdA === productId;
        return {
            productId: isA ? r.productIdB : r.productIdA,
            spId:      isA ? r.spIdB      : r.spIdA,
        };
    });
}

/**
 * Pick the canonical winner from a set of product rows using the same rule
 * as the global merge: shortest name wins, lower id breaks ties.
 */
function pickRoot(products: { id: number; name: string }[]): number {
    return products.reduce((best, p) => {
        const bName = products.find(x => x.id === best)!.name;
        if (p.name.length < bName.length) return p.id;
        if (p.name.length === bName.length && p.id < best) return p.id;
        return best;
    }, products[0].id);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert a personal equivalence verdict for a SP pair.
 *
 * For 'same' verdicts the model maintains a union-find structure: every
 * entry always points directly at the component root (shortest product name,
 * lower id tiebreak). This guarantees O(1) component lookups and avoids
 * chains that would break the browse merge-map logic.
 *
 * For 'different' verdicts the entry is stored as-is. The personal browse
 * layer treats 'different' as a signal to keep products separate and never
 * merges them, regardless of the global aggregate.
 */
export const upsertEquivalence = async (
    userId: string,
    spA: number,
    spB: number,
    verdict: EquivalenceVerdict,
    conn?: Connection,
): Promise<void> => {
    const db = conn ?? pool;
    const { spIdA, spIdB } = orderPair(spA, spB);

    if (verdict !== 'same') {
        await db.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 verdict = VALUES(verdict),
                 needsReverification = 0,
                 updatedAt = CURRENT_TIMESTAMP`,
            [userId, spIdA, spIdB, verdict],
        );
        return;
    }

    // --- 'same' path: union-find normalization ---

    // 1. Resolve the product each SP belongs to.
    const [spRows]: any = await db.query(
        `SELECT id, productId FROM StoreProduct WHERE id IN (?, ?)`,
        [spA, spB],
    );
    const spProductMap = new Map<number, number>(spRows.map((r: any) => [Number(r.id), Number(r.productId)]));
    const productA = spProductMap.get(spA);
    const productB = spProductMap.get(spB);

    if (!productA || !productB || productA === productB) {
        // SPs belong to the same product or lookup failed — nothing to merge.
        await db.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict)
             VALUES (?, ?, ?, 'same')
             ON DUPLICATE KEY UPDATE
                 verdict = 'same',
                 needsReverification = 0,
                 updatedAt = CURRENT_TIMESTAMP`,
            [userId, spIdA, spIdB],
        );
        return;
    }

    // 2. Find each product's existing component (one hop, since we normalise).
    const neighboursA = await getComponentNeighbours(userId, productA, db);
    const neighboursB = await getComponentNeighbours(userId, productB, db);

    // Build the merged component: product → representative SP.
    // Start with the two SPs from the current vote.
    const componentSp = new Map<number, number>([
        [productA, spA],
        [productB, spB],
    ]);
    for (const n of neighboursA) if (!componentSp.has(n.productId)) componentSp.set(n.productId, n.spId);
    for (const n of neighboursB) if (!componentSp.has(n.productId)) componentSp.set(n.productId, n.spId);

    // 3. Fetch product names to elect the root.
    const allProductIds = [...componentSp.keys()];
    const [productRows]: any = await db.query(
        `SELECT id, name FROM Product WHERE id IN (?)`,
        [allProductIds],
    );
    const rootProductId = pickRoot(productRows);
    const rootSp = componentSp.get(rootProductId)!;

    // 4. Delete all existing 'same' entries for any product in this component.
    //    We rewrite them all to guarantee direct-to-root pointers.
    const allSpIds = [...componentSp.values()];
    await db.query(
        `DELETE FROM UserStoreProductEquivalence
          WHERE userId = ?
            AND verdict = 'same'
            AND (spIdA IN (?) OR spIdB IN (?))`,
        [userId, allSpIds, allSpIds],
    );

    // 5. Re-insert one entry per non-root member, each pointing at rootSp.
    const insertRows: [string, number, number, string][] = [];
    for (const [productId, memberSp] of componentSp) {
        if (productId === rootProductId) continue;
        const { spIdA: a, spIdB: b } = orderPair(memberSp, rootSp);
        insertRows.push([userId, a, b, 'same']);
    }

    if (insertRows.length > 0) {
        await db.query(
            `INSERT INTO UserStoreProductEquivalence (userId, spIdA, spIdB, verdict)
             VALUES ?
             ON DUPLICATE KEY UPDATE
                 verdict = 'same',
                 needsReverification = 0,
                 updatedAt = CURRENT_TIMESTAMP`,
            [insertRows],
        );
    }
};

export const getEquivalencesForUser = async (userId: string): Promise<UserEquivalence[]> => {
    const [rows]: any = await pool.query(
        `SELECT id, userId, spIdA, spIdB, verdict, needsReverification
           FROM UserStoreProductEquivalence
          WHERE userId = ?`,
        [userId],
    );
    return rows;
};

// Returns all SP IDs the user considers equivalent to any of the given SP IDs.
export const getEquivalentSpIds = async (
    userId: string,
    spIds: number[],
): Promise<Map<number, number[]>> => {
    if (spIds.length === 0) return new Map();
    const [rows]: any = await pool.query(
        `SELECT spIdA, spIdB
           FROM UserStoreProductEquivalence
          WHERE userId = ?
            AND verdict = 'same'
            AND (spIdA IN (?) OR spIdB IN (?))`,
        [userId, spIds, spIds],
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

/**
 * For a set of productIds, return each product's owner-personal 'same'
 * equivalent productIds — ONE HOP, both directions of the edge. Only
 * cross-product edges count (sp1.productId != sp2.productId): two SPs of the
 * SAME product are already unified by the plain StoreProduct→productId lookup,
 * so they add nothing here.
 *
 * Returns Map<inputProductId, equivalentProductId[]> (only products with at
 * least one equivalent appear). Used by the receipt cross-store pricer to add
 * the receipt OWNER's personally-identified cross-chain siblings to the
 * candidate price pool — so an owner's 'same' swipe improves their comparison
 * before community consensus, and even when the swipe didn't relink the line.
 *
 * Because 'same' rows are normalised to point at a component root, a MEMBER
 * product resolves to {root} and a ROOT resolves to {all members}; two members
 * of the same component don't see each other directly (that's the one-hop
 * contract — additive, conservative).
 */
export const getPersonalEquivalentProductIds = async (
    userId: string,
    productIds: number[],
): Promise<Map<number, number[]>> => {
    if (!userId || productIds.length === 0) return new Map();
    const [rows]: any = await pool.query(
        `SELECT sp1.productId AS productIdA, sp2.productId AS productIdB
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
          WHERE e.userId = ?
            AND e.verdict = 'same'
            AND sp1.productId != sp2.productId
            AND (sp1.productId IN (?) OR sp2.productId IN (?))`,
        [userId, productIds, productIds],
    );
    const inputSet = new Set(productIds);
    const map = new Map<number, number[]>();
    const add = (k: number, v: number) => {
        if (k === v) return;
        const arr = map.get(k) ?? [];
        if (!arr.includes(v)) arr.push(v);
        map.set(k, arr);
    };
    for (const r of rows) {
        const a = Number(r.productIdA);
        const b = Number(r.productIdB);
        if (inputSet.has(a)) add(a, b);
        if (inputSet.has(b)) add(b, a);
    }
    return map;
};

/**
 * For a browse product list, return { hideProductId → keepProductId } based on
 * the user's personal 'same' verdicts. Winner = shortest product name (lower id
 * tiebreak), matching the global merge rule so personal and global views are
 * consistent.
 */
export const getUserProductMergeMap = async (
    userId: string,
    productIds: number[],
): Promise<Map<number, number>> => {
    if (productIds.length === 0) return new Map();
    const [rows]: any = await pool.query(
        `SELECT
             sp1.productId AS productIdA,
             sp2.productId AS productIdB,
             p1.name       AS nameA,
             p2.name       AS nameB
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
           JOIN Product      p1  ON p1.id  = sp1.productId
           JOIN Product      p2  ON p2.id  = sp2.productId
          WHERE e.userId = ?
            AND e.verdict = 'same'
            AND sp1.productId != sp2.productId
            AND sp1.productId IN (?)
            AND sp2.productId IN (?)`,
        [userId, productIds, productIds],
    );

    const map = new Map<number, number>();
    for (const row of rows) {
        const aId: number = row.productIdA;
        const bId: number = row.productIdB;
        const aName: string = row.nameA;
        const bName: string = row.nameB;

        let keepId: number;
        let hideId: number;
        if (aName.length !== bName.length) {
            keepId = aName.length < bName.length ? aId : bId;
            hideId = aName.length < bName.length ? bId : aId;
        } else {
            keepId = aId < bId ? aId : bId;
            hideId = aId < bId ? bId : aId;
        }
        map.set(hideId, keepId);
    }
    return map;
};

/**
 * Return all productIds in the personal component containing `productId` for
 * this user. Since all entries point directly to the root, fetching the root
 * and all its members takes exactly two queries.
 *
 * Used by the product detail page to collect all SPs across a personal merge.
 */
export const getPersonalComponentForProduct = async (
    userId: string,
    productId: number,
    conn?: Connection,
): Promise<number[]> => {
    const db = conn ?? pool;

    // Step 1: find this product's root (if it is itself a member pointing to root).
    const [rootRows]: any = await db.query(
        `SELECT
             CASE WHEN sp1.productId = ? THEN sp2.productId ELSE sp1.productId END AS rootProductId
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
          WHERE e.userId = ?
            AND e.verdict = 'same'
            AND (sp1.productId = ? OR sp2.productId = ?)
          LIMIT 1`,
        [productId, userId, productId, productId],
    );

    const rootProductId: number = rootRows[0]?.rootProductId ?? productId;

    // Step 2: find all members pointing to this root (includes root itself).
    const [memberRows]: any = await db.query(
        `SELECT DISTINCT
             CASE WHEN sp1.productId = ? THEN sp2.productId ELSE sp1.productId END AS memberId
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
          WHERE e.userId = ?
            AND e.verdict = 'same'
            AND (sp1.productId = ? OR sp2.productId = ?)`,
        [rootProductId, userId, rootProductId, rootProductId],
    );

    const members: number[] = memberRows.map((r: any) => Number(r.memberId));
    if (!members.includes(rootProductId)) members.push(rootProductId);
    return members;
};

/**
 * Return the set of SP pair keys (formatted as "minId-maxId") for pairs that
 * need re-verification for this user, filtered to only SPs present in the
 * given receipt's lines. Used by the queue builder to surface re-verification
 * cards even though the pair was already voted on.
 */
export const getReverificationPairKeysForReceipt = async (
    userId: string,
    receiptSpIds: number[],
): Promise<Set<string>> => {
    if (receiptSpIds.length === 0) return new Set();
    const [rows]: any = await pool.query(
        `SELECT spIdA, spIdB
           FROM UserStoreProductEquivalence
          WHERE userId = ?
            AND needsReverification = 1
            AND (spIdA IN (?) OR spIdB IN (?))`,
        [userId, receiptSpIds, receiptSpIds],
    );
    const s = new Set<string>();
    for (const r of rows) s.add(`${r.spIdA}-${r.spIdB}`);
    return s;
};

/**
 * Clear the needsReverification flag for a specific SP pair after the user
 * has re-voted on it. Also stamps `reverifiedAt` — "this vote survived a
 * challenge" — so the receipt-evidence trigger (flagDivergentDifferentVotes)
 * never nags the same decision again; only a global merge transition
 * (which clears the stamp) can issue a fresh challenge.
 */
export const clearReverification = async (
    userId: string,
    spA: number,
    spB: number,
    conn?: Connection,
): Promise<void> => {
    const db = conn ?? pool;
    const { spIdA, spIdB } = orderPair(spA, spB);
    await db.query(
        `UPDATE UserStoreProductEquivalence
            SET needsReverification = 0, reverifiedAt = NOW()
          WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
        [userId, spIdA, spIdB],
    );
};

/**
 * TRIGGER A of the re-verification loop (receipt evidence): a fresh confident
 * receipt match to one of `spIds` contradicts this user's personal 'different'
 * vote against a same-Product sibling — the exact vote that would otherwise
 * demote the line's display forever (see fetchUserRejectedLineSps). Flag it so
 * the pair is re-served as a priority swipe card (the queue already bypasses
 * the no-repeat filter for flagged pairs and sorts them first).
 *
 * Anti-nag: rows already flagged, or already re-verified once (reverifiedAt
 * stamped by clearReverification), are skipped — receipt evidence challenges
 * each decision at most ONCE. Only a global merge transition clears the stamp
 * and re-opens the question. Returns the number of votes flagged.
 */
export const flagDivergentDifferentVotes = async (
    userId: string,
    spIds: number[],
    conn?: Connection,
): Promise<number> => {
    if (spIds.length === 0) return 0;
    const db = conn ?? pool;
    const [res]: any = await db.query(
        `UPDATE UserStoreProductEquivalence e
           JOIN StoreProduct spA ON spA.id = e.spIdA
           JOIN StoreProduct spB ON spB.id = e.spIdB
            SET e.needsReverification = 1
          WHERE e.userId = ?
            AND e.verdict = 'different'
            AND e.needsReverification = 0
            AND e.reverifiedAt IS NULL
            AND spA.productId = spB.productId
            AND (e.spIdA IN (?) OR e.spIdB IN (?))`,
        [userId, spIds, spIds],
    );
    return Number(res?.affectedRows ?? 0);
};

export const deleteEquivalence = async (userId: string, spA: number, spB: number): Promise<void> => {
    const { spIdA, spIdB } = orderPair(spA, spB);
    await pool.query(
        `DELETE FROM UserStoreProductEquivalence WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
        [userId, spIdA, spIdB],
    );
};
