import pool from '../config/db.js';

type Connection = typeof pool | any;

export interface MergeDecision {
    action: 'promoted' | 'demoted' | 'noop';
    winnerProductId?: number;
    loserProductId?: number;
}

/**
 * Soft-merge two Products via `Product.mergedIntoId`. Idempotent: if they're
 * already merged in the same direction, it's a no-op. Respects Phase 0
 * rules: keep the shorter-named Product as the canonical "winner"; break
 * ties by lower id for determinism.
 *
 * Chains are avoided — if the candidate loser is already merged into some
 * third Product, we resolve through it and merge the effective roots instead.
 */
export const promoteMergeByProductIds = async (
    productAId: number,
    productBId: number,
    conn?: Connection
): Promise<MergeDecision> => {
    const db = conn || pool;
    if (productAId === productBId) return { action: 'noop' };

    const rootA = await resolveEffectiveProductId(productAId, db);
    const rootB = await resolveEffectiveProductId(productBId, db);
    if (rootA === rootB) return { action: 'noop' };

    const [rows]: any = await db.query(
        `SELECT id, name FROM Product WHERE id IN (?, ?)`,
        [rootA, rootB]
    );
    if (rows.length < 2) return { action: 'noop' };
    const byId = new Map<number, { id: number; name: string }>(
        rows.map((r: any) => [r.id, r])
    );
    const a = byId.get(rootA)!;
    const b = byId.get(rootB)!;

    const winner =
        a.name.length !== b.name.length
            ? (a.name.length < b.name.length ? a : b)
            : (a.id < b.id ? a : b);
    const loser = winner.id === a.id ? b : a;

    await db.query(
        `UPDATE Product SET mergedIntoId = ? WHERE id = ?`,
        [winner.id, loser.id]
    );
    return {
        action: 'promoted',
        winnerProductId: winner.id,
        loserProductId: loser.id,
    };
};

/**
 * Reverse a prior soft-merge between two Products. Finds whichever of the
 * two currently points at the other and clears its mergedIntoId.
 */
export const demoteMergeByProductIds = async (
    productAId: number,
    productBId: number,
    conn?: Connection
): Promise<MergeDecision> => {
    const db = conn || pool;
    if (productAId === productBId) return { action: 'noop' };

    const [rows]: any = await db.query(
        `SELECT id, mergedIntoId FROM Product WHERE id IN (?, ?)`,
        [productAId, productBId]
    );
    const byId = new Map<number, { id: number; mergedIntoId: number | null }>(
        rows.map((r: any) => [r.id, r])
    );
    const a = byId.get(productAId);
    const b = byId.get(productBId);
    if (!a || !b) return { action: 'noop' };

    let loserId: number | null = null;
    let winnerId: number | null = null;
    if (a.mergedIntoId === b.id) {
        loserId = a.id;
        winnerId = b.id;
    } else if (b.mergedIntoId === a.id) {
        loserId = b.id;
        winnerId = a.id;
    }
    if (loserId === null) return { action: 'noop' };

    await db.query(
        `UPDATE Product SET mergedIntoId = NULL WHERE id = ?`,
        [loserId]
    );
    return {
        action: 'demoted',
        winnerProductId: winnerId!,
        loserProductId: loserId,
    };
};

/**
 * Resolve a Product id through its mergedIntoId chain to the current effective
 * root (baseProductId is a separate concept — we do not follow it here).
 * Uses a single recursive CTE query capped at 4 hops as a safety against
 * accidental cycles or deep chains.
 */
export const resolveEffectiveProductId = async (
    productId: number,
    conn?: Connection
): Promise<number> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `WITH RECURSIVE chain AS (
            SELECT id, mergedIntoId, 0 AS depth FROM Product WHERE id = ?
            UNION ALL
            SELECT p.id, p.mergedIntoId, chain.depth + 1
            FROM Product p
            INNER JOIN chain ON p.id = chain.mergedIntoId
            WHERE chain.mergedIntoId IS NOT NULL AND chain.depth < 4
        )
        SELECT id FROM chain ORDER BY depth DESC LIMIT 1`,
        [productId]
    );
    return rows[0]?.id ?? productId;
};

/** Fetch productId for a given storeProductId. Needed so the merge logic can
 *  operate on Products even though votes are about StoreProducts. */
export const getProductIdForStoreProduct = async (
    storeProductId: number,
    conn?: Connection
): Promise<number | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT productId FROM StoreProduct WHERE id = ? LIMIT 1`,
        [storeProductId]
    );
    return rows[0]?.productId ?? null;
};

/**
 * The baseProduct a StoreProduct effectively belongs to after walking through
 * the mergedIntoId chain (identical merges) and then reading baseProductId
 * (similarity grouping from Phase 0). Returns the baseProduct's own id when
 * the effective Product is itself a root (baseProductId IS NULL).
 *
 * Used by Phase C3 to decide whether a swipe vote crosses a baseProduct
 * boundary and should tally into BaseProductLink.
 */
export const getEffectiveBaseProductIdForStoreProduct = async (
    storeProductId: number,
    conn?: Connection,
    cachedProductId?: number   // ← NEW: skip the StoreProduct lookup if pre-fetched
): Promise<number | null> => {
    const productId = cachedProductId ?? await getProductIdForStoreProduct(storeProductId, conn);
    if (productId === null) return null;
    const effectiveProductId = await resolveEffectiveProductId(productId, conn);
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT baseProductId FROM Product WHERE id = ? LIMIT 1`,
        [effectiveProductId]
    );
    if (rows.length === 0) return null;
    return rows[0].baseProductId ?? effectiveProductId;
};
