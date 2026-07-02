import { recomputeAliasAfterVoteRemoval } from '../models/storeProductAliasModel.js';

type Connection = any;

export interface ReceiptLearningResetResult {
    aliasVotesDeleted: number;
    aliasesDeleted: number;
    matchVotesDeleted: number;
    equivalencesDeleted: number;
}

/**
 * Clean-slate a receipt's LEARNING side effects so re-uploading the SAME receipt tests
 * fresh (DEV reset). The scan + swipe flow writes learning rows keyed to the receipt that
 * a plain Receipt delete leaves behind (no FK, or FK ON DELETE SET NULL) — so a re-scan
 * would auto-match on a learned alias, and the swipe cards would never re-surface (the
 * no-repeat rule sees the old vote). This removes those receipt-scoped rows and keeps the
 * derived aggregates consistent:
 *
 *   1. Vocabulary — alias votes cast via this receipt are deleted; an alias left with no
 *      votes (and no admin pin) is deleted; a survivor's distinct-user tallies + status are
 *      recomputed; a dangling sampleReceiptId is cleared.
 *   2. Cross-chain match votes — StoreProductMatchVote rows for this receipt are deleted and
 *      each affected StoreProductMatch aggregate is RECOMPUTED from the remaining NON-burst
 *      votes (so no phantom count survives to be double-counted on the next vote).
 *   3. Personal equivalences — the user's UserStoreProductEquivalence rows for those pairs
 *      are deleted so the pair can re-surface as a card on the next scan.
 *
 * Intentionally NOT reset (low impact for DEV re-testing, documented so it's a choice not an
 * oversight): BaseProductLink 'similar' tallies; a Product merge that already crossed a
 * promote/demote threshold (rare with one dev user, and it self-heals on the next vote when
 * reevaluateMerge reads the recomputed aggregate); User points (denormalised counter with no
 * per-receipt ledger to reverse); OrphanSwipeCandidate (product-pair scoped, not receipt
 * scoped). Runs in the caller's transaction so it commits atomically with the receipt delete.
 */
export async function resetReceiptLearning(
    receiptId: number,
    conn: Connection,
): Promise<ReceiptLearningResetResult> {
    // ── 1. Vocabulary aliases + votes ──────────────────────────────────────────
    const [aliasIdRows]: any = await conn.query(
        `SELECT DISTINCT aliasId FROM StoreProductReceiptAliasVote WHERE receiptId = ?`,
        [receiptId],
    );
    const affectedAliasIds: number[] = aliasIdRows.map((r: any) => Number(r.aliasId));
    const [avDel]: any = await conn.query(
        `DELETE FROM StoreProductReceiptAliasVote WHERE receiptId = ?`,
        [receiptId],
    );
    let aliasesDeleted = 0;
    for (const aliasId of affectedAliasIds) {
        if (await recomputeAliasAfterVoteRemoval(aliasId, conn)) aliasesDeleted++;
    }
    // A surviving alias that sampled THIS receipt keeps a now-dangling pointer — clear it.
    await conn.query(
        `UPDATE StoreProductReceiptAlias SET sampleReceiptId = NULL WHERE sampleReceiptId = ?`,
        [receiptId],
    );

    // ── 2. Cross-chain match votes + aggregate recompute ───────────────────────
    // Capture (userId, pair) BEFORE deleting so we can also clear the personal equivalences.
    const [voteRows]: any = await conn.query(
        `SELECT userId, spIdA, spIdB FROM StoreProductMatchVote WHERE receiptId = ?`,
        [receiptId],
    );
    const pairKey = (a: number, b: number) => `${a}:${b}`;
    const pairs = new Map<string, { spIdA: number; spIdB: number }>();
    for (const v of voteRows) pairs.set(pairKey(v.spIdA, v.spIdB), { spIdA: Number(v.spIdA), spIdB: Number(v.spIdB) });

    const [mvDel]: any = await conn.query(
        `DELETE FROM StoreProductMatchVote WHERE receiptId = ?`,
        [receiptId],
    );

    for (const { spIdA, spIdB } of pairs.values()) {
        // Recompute the aggregate from the votes that remain, using the row's own
        // aggregation PROVENANCE (`aggregated` column) — exactly what applyAggregateDelta
        // accumulated, with no dwell-time guessing.
        const [tally]: any = await conn.query(
            `SELECT vote, COUNT(*) AS n FROM StoreProductMatchVote
              WHERE spIdA = ? AND spIdB = ? AND aggregated = 1
              GROUP BY vote`,
            [spIdA, spIdB],
        );
        let identical = 0, similar = 0, different = 0;
        for (const t of tally) {
            if (t.vote === 'identical') identical = Number(t.n);
            else if (t.vote === 'similar') similar = Number(t.n);
            else if (t.vote === 'different') different = Number(t.n);
        }
        await conn.query(
            `UPDATE StoreProductMatch SET identicalVotes = ?, similarVotes = ?, differentVotes = ?
              WHERE spIdA = ? AND spIdB = ?`,
            [identical, similar, different, spIdA, spIdB],
        );
    }

    // ── 3. Personal equivalences for those pairs (so the cards re-surface) ─────
    // StoreProductMatchVote stores pairs already ordered (spIdA < spIdB), matching the
    // UserStoreProductEquivalence key, so the pair maps directly.
    let equivalencesDeleted = 0;
    for (const v of voteRows) {
        const [eqDel]: any = await conn.query(
            `DELETE FROM UserStoreProductEquivalence WHERE userId = ? AND spIdA = ? AND spIdB = ?`,
            [v.userId, Number(v.spIdA), Number(v.spIdB)],
        );
        equivalencesDeleted += eqDel.affectedRows;
    }

    return {
        aliasVotesDeleted: avDel.affectedRows,
        aliasesDeleted,
        matchVotesDeleted: mvDel.affectedRows,
        equivalencesDeleted,
    };
}
