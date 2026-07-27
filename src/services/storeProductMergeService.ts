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

    console.log(`[MERGE] PROMOTE: "${winner.name}" (product=${winner.id}) ← "${loser.name}" (product=${loser.id})`);

    await db.query(
        `UPDATE Product SET mergedIntoId = ? WHERE id = ?`,
        [winner.id, loser.id]
    );

    /**
     * Carry the loser's PERSONALISATION over to the winner.
     *
     * Everything downstream reads the winner: a merged-away product is filtered
     * out of every search, so history left on the loser is history the shopper
     * silently loses. Measured on dev before this existed: 18 `UserProductScore`
     * rows and 25 `ProductInteraction` rows stranded on merged ids, and in ALL 18
     * the winner had no row — those shoppers' preferences simply vanished.
     *
     * Interactions move first (they are the source of truth), then the scores are
     * summed onto the winner's row, because a shopper who bought both sides of a
     * merge liked that product twice over. `recalcUserProductScore` would also
     * rebuild it from the moved interactions, but only for pairs it is called
     * with; the SUM keeps the table correct immediately, and the nightly
     * re-decay reconciles the rest.
     */
    await db.query(
        `UPDATE ProductInteraction SET productId = ? WHERE productId = ?`,
        [winner.id, loser.id],
    );
    await db.query(
        // The loser's rows are read through a DERIVED TABLE: selecting from the
        // same table being inserted into makes every column reference in the
        // ON DUPLICATE clause ambiguous to MariaDB.
        `INSERT INTO UserProductScore (userId, productId, score, interactionCount, updatedAt)
         SELECT src.userId, ?, src.score, src.interactionCount, NOW()
           FROM (SELECT userId, score, interactionCount
                   FROM UserProductScore WHERE productId = ?) AS src
         ON DUPLICATE KEY UPDATE
             score = UserProductScore.score + VALUES(score),
             interactionCount = UserProductScore.interactionCount + VALUES(interactionCount),
             updatedAt = NOW()`,
        [winner.id, loser.id],
    );
    await db.query(`DELETE FROM UserProductScore WHERE productId = ?`, [loser.id]);

    // TRIGGER B (global divergence, join direction): the community just joined these
    // products — every user still holding a personal 'different' on an SP pair across
    // them now diverges from the global model. Flag their vote for re-verification
    // (priority swipe card, no-repeat bypassed) and CLEAR the reverifiedAt stamp: a
    // global transition is genuinely new information, so even a previously-reconfirmed
    // vote earns one fresh challenge. Mirrors the reversal-direction trigger in
    // demoteMergeByProductIds (which flags 'same' voters).
    await db.query(
        `UPDATE UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
            SET e.needsReverification = 1, e.reverifiedAt = NULL
          WHERE e.verdict = 'different'
            AND sp1.productId IN (?, ?)
            AND sp2.productId IN (?, ?)`,
        [winner.id, loser.id, winner.id, loser.id]
    );

    return {
        action: 'promoted',
        winnerProductId: winner.id,
        loserProductId: loser.id,
    };
};

/** Nepriskirta ("Uncategorised") bucket. */
const NEPRISKIRTA_CATEGORY_ID = 688;

/**
 * After a 'promoted' merge, CATEGORISE an uncategorised (Nepriskirta, 688) product by
 * adopting the categorised partner's category onto its OWN row. promoteMergeByProductIds
 * picks the winner by NAME LENGTH (category-blind), so a 688 product can land on EITHER
 * side — and if it WINS, the merged identity would otherwise resolve to 688, silently
 * DE-CATEGORISING the good partner. Fixing the 688 row's own categoryId (which every
 * downstream reader uses directly) sidesteps the merge direction entirely. This is how a
 * community "same" confirmation on a [688-with-photo, categorised] slot3 pair categorises
 * the scraped item. Idempotent + safe: the `categoryId = 688` guard makes it a no-op once
 * categorised and it ONLY ever moves a product OUT of 688, never overwrites a real category.
 */
export const categoriseUncategorisedOnMerge = async (
    decision: MergeDecision,
    conn?: Connection,
): Promise<void> => {
    if (decision.action !== 'promoted' || decision.winnerProductId == null || decision.loserProductId == null) return;
    const db = conn || pool;
    const [rows]: any = await db.query(
        'SELECT id, categoryId FROM Product WHERE id IN (?, ?)',
        [decision.winnerProductId, decision.loserProductId],
    );
    const byId = new Map<number, any>((rows as any[]).map((r) => [Number(r.id), r]));
    const winner = byId.get(decision.winnerProductId);
    const loser = byId.get(decision.loserProductId);
    if (!winner || !loser) return;
    const winnerCat = Number(winner.categoryId);
    const loserCat = Number(loser.categoryId);
    // Exactly one side is 688 → adopt the categorised side's category onto the 688 row.
    let target: number | null = null;
    let newCat: number | null = null;
    // `> 0` is defense-in-depth: only ever adopt a REAL category id (never write 0/NULL onto
    // the 688 row even if a partner's categoryId were ever absent).
    if (loserCat === NEPRISKIRTA_CATEGORY_ID && winnerCat > 0 && winnerCat !== NEPRISKIRTA_CATEGORY_ID) { target = Number(loser.id); newCat = winnerCat; }
    else if (winnerCat === NEPRISKIRTA_CATEGORY_ID && loserCat > 0 && loserCat !== NEPRISKIRTA_CATEGORY_ID) { target = Number(winner.id); newCat = loserCat; }
    if (target == null || newCat == null) return;
    await db.query(
        'UPDATE Product SET categoryId = ? WHERE id = ? AND categoryId = ?',
        [newCat, target, NEPRISKIRTA_CATEGORY_ID],
    );
    console.log(`[MERGE] CATEGORISE: product ${target} (Nepriskirta 688) → categoryId=${newCat}`);
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
        `SELECT id, name, mergedIntoId FROM Product WHERE id IN (?, ?)`,
        [productAId, productBId]
    );
    const byId = new Map<number, { id: number; name: string; mergedIntoId: number | null }>(
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

    const loserRow = byId.get(loserId);
    const winnerRow = byId.get(winnerId!);
    console.log(`[MERGE] DEMOTE: "${loserRow?.name}" (product=${loserId}) unmerged from "${winnerRow?.name}" (product=${winnerId})`);

    await db.query(
        `UPDATE Product SET mergedIntoId = NULL WHERE id = ?`,
        [loserId]
    );

    // TRIGGER B (global divergence, split direction): users who previously voted
    // these products as identical should reconfirm on their next purchase — the
    // community has reversed the merge. reverifiedAt is cleared for the same reason
    // as the join-direction trigger above: a global transition re-opens the question
    // even for a previously-reconfirmed vote.
    await db.query(
        `UPDATE UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
            SET e.needsReverification = 1, e.reverifiedAt = NULL
          WHERE e.verdict = 'same'
            AND sp1.productId IN (?, ?)
            AND sp2.productId IN (?, ?)`,
        [loserId, winnerId, loserId, winnerId],
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
