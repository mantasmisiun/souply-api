import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import { applyBaseProductLinkDelta } from '../models/baseProductLinkModel.js';
import {
    applyAggregateDelta,
    countRecentVotes,
    deleteMatchVote,
    getMatchAggregate,
    orderPair,
    upsertMatchVote,
    type MatchVote,
} from '../models/storeProductMatchModel.js';
import {
    demoteMergeByProductIds,
    getEffectiveBaseProductIdForStoreProduct,
    getProductIdForStoreProduct,
    promoteMergeByProductIds,
    type MergeDecision,
} from './storeProductMergeService.js';
import { markResolvedForProductPair } from '../models/orphanSwipeCandidateModel.js';
import { wilsonLowerBound } from '../utils/wilson.js';

type Connection = typeof pool | any;

export type SwipeVote = MatchVote;

export interface CastSwipeVoteInput {
    userId: string;
    receiptId: number;
    receiptLineIdx: number;
    candidateStoreProductId: number;
    vote: SwipeVote;
    dwellMs: number;
}

export type SwipeVoteEffect =
    | 'price-verified'
    | 'price-unverified'
    | 'price-already-verified'
    | 'price-already-unverified'
    | 'dropped-burst'
    | 'dropped-rate-limit'
    | 'no-candidate'
    | 'no-price-row'
    | 'self-pair-skipped'
    | 'vote-recorded';

export interface CastSwipeVoteResult {
    ok: boolean;
    effect: SwipeVoteEffect;
    merge?: MergeDecision;
}

export interface UndoSwipeVoteInput {
    userId: string;
    receiptId: number;
    receiptLineIdx: number;
    candidateStoreProductId: number;
}

/**
 * Process a swipe vote. Always runs inside a transaction because it can
 * cascade through several writes (vote row, aggregate row, Price flip,
 * Product merge). If any one fails, the user's swipe is cleanly rolled back.
 */
export const castSwipeVote = async (
    input: CastSwipeVoteInput
): Promise<CastSwipeVoteResult> => {
    if (input.dwellMs < MatchThresholds.minDwellMs) {
        return { ok: true, effect: 'dropped-burst' };
    }
    const recent = await countRecentVotes(input.userId, 60);
    if (recent >= MatchThresholds.maxUserVotesPerMinute) {
        return { ok: true, effect: 'dropped-rate-limit' };
    }

    // Resolve the line's current storeProductId from parsedData — after C2a
    // every line has one.
    const [receiptRows]: any = await pool.query(
        `SELECT parsedData FROM Receipt WHERE id = ? LIMIT 1`,
        [input.receiptId]
    );
    if (receiptRows.length === 0) {
        return { ok: true, effect: 'no-candidate' };
    }
    const parsed =
        typeof receiptRows[0].parsedData === 'string'
            ? JSON.parse(receiptRows[0].parsedData)
            : receiptRows[0].parsedData;
    const lineSpId = Number(parsed?.products?.[input.receiptLineIdx]?.storeProductId);
    if (!Number.isFinite(lineSpId) || lineSpId <= 0) {
        return { ok: true, effect: 'no-candidate' };
    }

    // Self-pair (candidate already is the line's SP): the vote has no
    // cross-SP signal, so it's just an acknowledgement that the user has
    // seen this auto-match card. Flip priceVerified=1 for ANY direction so
    // the queue filter catches it on re-entry — otherwise self-pair
    // different/similar swipes leave no trace and the card would keep
    // showing. We lose nuance on self-pair different (user signalling
    // "auto-match was wrong"), but self-pair cards only exist for >=0.90-
    // confidence auto-matches where different is rare.
    if (input.candidateStoreProductId === lineSpId) {
        return await acknowledgeSelfPair(input, lineSpId);
    }

    // Pair vote. Sort, write, update aggregate, re-evaluate promote/demote.
    const pair = orderPair(input.candidateStoreProductId, lineSpId);
    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        const { previousVote } = await upsertMatchVote(
            input.userId,
            pair.spIdA,
            pair.spIdB,
            input.vote,
            input.dwellMs,
            input.receiptId,
            connection
        );
        if (previousVote !== null && previousVote !== input.vote) {
            await applyAggregateDelta(pair.spIdA, pair.spIdB, previousVote, -1, connection);
        }
        if (previousVote !== input.vote) {
            await applyAggregateDelta(pair.spIdA, pair.spIdB, input.vote, +1, connection);
        }

        // Phase C3: maintain cross-baseProduct similarity link tallies. A
        // swipe that crosses a baseProduct boundary with vote='similar'
        // increments BaseProductLink.similarVoteCount; moving away from
        // similar decrements.
        await applyBaseProductLinkForVote(
            pair.spIdA,
            pair.spIdB,
            previousVote,
            input.vote,
            connection
        );

        const agg = await getMatchAggregate(pair.spIdA, pair.spIdB, connection);
        const merge = await reevaluateMerge(pair.spIdA, pair.spIdB, agg, connection);

        // Also flip the line's Price verification as a user-visible signal.
        // (Aggregate/merge happens silently; this gives the user immediate feedback.)
        const linePriceEffect = await applyLinePriceEffect(input, lineSpId, connection);

        await connection.commit();

        return {
            ok: true,
            effect:
                linePriceEffect.effect === 'no-price-row'
                    ? 'vote-recorded'
                    : linePriceEffect.effect,
            merge,
        };
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
};

/**
 * Reverse a prior vote cast by this user on this (receipt, line, candidate).
 * Called by the mobile undo toast. Deletes the vote row, reverses the
 * aggregate delta, reverts any merge the vote was pivotal for, and flips
 * the Price.isVerified state back.
 */
export const undoSwipeVote = async (
    input: UndoSwipeVoteInput
): Promise<CastSwipeVoteResult> => {
    const [receiptRows]: any = await pool.query(
        `SELECT parsedData FROM Receipt WHERE id = ? LIMIT 1`,
        [input.receiptId]
    );
    if (receiptRows.length === 0) {
        return { ok: true, effect: 'no-candidate' };
    }
    const parsed =
        typeof receiptRows[0].parsedData === 'string'
            ? JSON.parse(receiptRows[0].parsedData)
            : receiptRows[0].parsedData;
    const lineSpId = Number(parsed?.products?.[input.receiptLineIdx]?.storeProductId);
    if (!Number.isFinite(lineSpId) || lineSpId <= 0) {
        return { ok: true, effect: 'no-candidate' };
    }

    // Self-pair undo: no vote row to delete. Just reverse the Price flip.
    if (input.candidateStoreProductId === lineSpId) {
        return await revertLinePriceEffect(input, lineSpId);
    }

    const pair = orderPair(input.candidateStoreProductId, lineSpId);
    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();
        const { deletedVote } = await deleteMatchVote(
            input.userId,
            pair.spIdA,
            pair.spIdB,
            connection
        );
        if (deletedVote !== null) {
            await applyAggregateDelta(pair.spIdA, pair.spIdB, deletedVote, -1, connection);
            // Also reverse any BaseProductLink increment the vote caused.
            // Passing newVote=null here — deletion is the terminal state.
            await applyBaseProductLinkForVote(
                pair.spIdA,
                pair.spIdB,
                deletedVote,
                null,
                connection
            );
        }
        const agg = await getMatchAggregate(pair.spIdA, pair.spIdB, connection);
        const merge = await reevaluateMerge(pair.spIdA, pair.spIdB, agg, connection);

        const linePriceEffect = await revertLinePriceEffect(input, lineSpId, connection);

        await connection.commit();
        return {
            ok: true,
            effect:
                linePriceEffect.effect === 'no-price-row'
                    ? 'vote-recorded'
                    : linePriceEffect.effect,
            merge,
        };
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
};

// ───────────────── internals ─────────────────

/**
 * Maintain the cross-baseProduct similarity tally (BaseProductLink).
 *
 * Mapping: only "similar" votes feed the link counter. The delta = 1 when
 * the vote transitions TO similar (from any other state, including unvoted);
 * -1 when it transitions AWAY from similar (including deletion, which
 * passes newVote = null); 0 otherwise. Self-links (both SPs in the same
 * baseProduct, which happens after a merge) are silently skipped by
 * applyBaseProductLinkDelta.
 */
export async function applyBaseProductLinkForVote(
    spIdA: number,
    spIdB: number,
    previousVote: MatchVote | null,
    newVote: MatchVote | null,
    conn: Connection
): Promise<void> {
    const prevSimilar = previousVote === 'similar' ? 1 : 0;
    const newSimilar = newVote === 'similar' ? 1 : 0;
    const delta = newSimilar - prevSimilar;
    if (delta === 0) return;

    const bpA = await getEffectiveBaseProductIdForStoreProduct(spIdA, conn);
    const bpB = await getEffectiveBaseProductIdForStoreProduct(spIdB, conn);
    if (bpA === null || bpB === null) return;
    if (bpA === bpB) return;

    await applyBaseProductLinkDelta(bpA, bpB, delta, conn);
}

/**
 * Decide whether the current aggregate state crosses a promote or demote
 * threshold and execute the corresponding merge action. Called after every
 * vote ingestion and every undo so the Product graph always reflects the
 * latest data.
 */
export async function reevaluateMerge(
    spIdA: number,
    spIdB: number,
    agg: Awaited<ReturnType<typeof getMatchAggregate>>,
    conn: Connection
): Promise<MergeDecision | undefined> {
    if (!agg) return undefined;
    const total = agg.identicalVotes + agg.similarVotes + agg.differentVotes;
    if (total === 0) return undefined;

    const identicalLower = wilsonLowerBound(
        agg.identicalVotes,
        total,
        MatchThresholds.wilsonZ
    );

    const productIdA = await getProductIdForStoreProduct(spIdA, conn);
    const productIdB = await getProductIdForStoreProduct(spIdB, conn);
    if (productIdA === null || productIdB === null) return undefined;

    // Promote: high positive-rate, enough votes → merge their Products.
    if (
        agg.identicalVotes >= MatchThresholds.promoteIdentical.minVotes &&
        identicalLower >= MatchThresholds.promoteIdentical.minWilsonLower
    ) {
        // Mark any OrphanSwipeCandidate row for this Product pair as
        // resolved so the extra-queue stops serving it. Fires regardless
        // of whether the merge was driven by a receipt vote or an orphan
        // vote — hook is inside reevaluateMerge so both paths converge.
        await markResolvedForProductPair(productIdA, productIdB, 'promoted', conn);
        return promoteMergeByProductIds(productIdA, productIdB, conn);
    }

    // Demote: confidence dropped below the demote band → unmerge.
    if (
        agg.identicalVotes >= MatchThresholds.demoteIdentical.minVotes &&
        identicalLower <= MatchThresholds.demoteIdentical.maxWilsonLower
    ) {
        await markResolvedForProductPair(productIdA, productIdB, 'demoted', conn);
        return demoteMergeByProductIds(productIdA, productIdB, conn);
    }

    return undefined;
}

/**
 * Flip Price.priceVerified in response to a vote, using the same "primary row
 * per (receipt, storeProduct)" semantics as C1. `identical` flips on,
 * `different` flips off, `similar` leaves it alone.
 */
/**
 * Acknowledge a self-pair swipe — flip priceVerified=1 unconditionally so
 * the queue filter drops the card on next fetch, regardless of which
 * direction the user swiped.
 */
async function acknowledgeSelfPair(
    input: CastSwipeVoteInput,
    lineSpId: number
): Promise<CastSwipeVoteResult> {
    const [rows]: any = await pool.query(
        `SELECT id, priceVerified FROM Price
          WHERE receiptId = ? AND storeProductId = ? AND isFallback = 0
          LIMIT 1`,
        [input.receiptId, lineSpId]
    );
    if (rows.length === 0) {
        return { ok: true, effect: 'no-price-row' };
    }
    if (rows[0].priceVerified) {
        return { ok: true, effect: 'price-already-verified' };
    }
    await pool.query(`UPDATE Price SET priceVerified = 1 WHERE id = ?`, [rows[0].id]);
    return { ok: true, effect: 'price-verified' };
}

async function applyLinePriceEffect(
    input: CastSwipeVoteInput,
    lineSpId: number,
    conn?: Connection
): Promise<CastSwipeVoteResult> {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT id, priceVerified FROM Price
          WHERE receiptId = ? AND storeProductId = ? AND isFallback = 0
          LIMIT 1`,
        [input.receiptId, lineSpId]
    );
    if (rows.length === 0) {
        return { ok: true, effect: 'no-price-row' };
    }
    const priceRow = rows[0];

    if (input.vote === 'identical') {
        if (priceRow.priceVerified) {
            return { ok: true, effect: 'price-already-verified' };
        }
        await db.query(`UPDATE Price SET priceVerified = 1 WHERE id = ?`, [priceRow.id]);
        return { ok: true, effect: 'price-verified' };
    }

    if (input.vote === 'different') {
        if (!priceRow.priceVerified) {
            return { ok: true, effect: 'price-already-unverified' };
        }
        await db.query(`UPDATE Price SET priceVerified = 0 WHERE id = ?`, [priceRow.id]);
        return { ok: true, effect: 'price-unverified' };
    }

    // 'similar' doesn't alter priceVerified.
    return { ok: true, effect: 'vote-recorded' };
}

/**
 * Undo counterpart of `applyLinePriceEffect`. Note we don't know what the
 * price-verified state was *before* the original vote, so we pragmatically
 * assume the swipe is being immediately undone and just reverse the last
 * effect (identical → unverify; different → verify; similar → noop).
 */
async function revertLinePriceEffect(
    input: UndoSwipeVoteInput,
    lineSpId: number,
    conn?: Connection
): Promise<CastSwipeVoteResult> {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT id, priceVerified FROM Price
          WHERE receiptId = ? AND storeProductId = ? AND isFallback = 0
          LIMIT 1`,
        [input.receiptId, lineSpId]
    );
    if (rows.length === 0) {
        return { ok: true, effect: 'no-price-row' };
    }
    const priceRow = rows[0];

    // Best-effort reversal: if currently verified, unverify; if currently not,
    // the undo is of a "different" (which unverified) — re-verify.
    if (priceRow.priceVerified) {
        await db.query(`UPDATE Price SET priceVerified = 0 WHERE id = ?`, [priceRow.id]);
        return { ok: true, effect: 'price-unverified' };
    }
    await db.query(`UPDATE Price SET priceVerified = 1 WHERE id = ?`, [priceRow.id]);
    return { ok: true, effect: 'price-verified' };
}
