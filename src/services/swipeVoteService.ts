import pool from '../config/db.js';
import { getReceiptItemKey, updateReceiptItem } from '../models/receiptItemModel.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import { findLinePrimaryPrice } from '../models/priceModel.js';
import { applyBaseProductLinkDelta } from '../models/baseProductLinkModel.js';
import {
    applyAggregateDelta,
    applyVoteTransitionDeltas,
    countRecentVotes,
    deleteMatchVote,
    getMatchAggregate,
    orderPair,
    upsertMatchVote,
    type MatchVote,
} from '../models/storeProductMatchModel.js';
import {
    categoriseUncategorisedOnMerge,
    demoteMergeByProductIds,
    getEffectiveBaseProductIdForStoreProduct,
    getProductIdForStoreProduct,
    promoteMergeByProductIds,
    type MergeDecision,
} from './storeProductMergeService.js';
import { markResolvedForProductPair } from '../models/orphanSwipeCandidateModel.js';
import { wilsonLowerBound } from '../utils/wilson.js';
import { clearReverification, upsertEquivalence } from '../models/userEquivalenceModel.js';
import { awardSwipePoint } from './userPointsService.js';
import { isBurstSwipe } from './swipeSessionService.js';

type Connection = typeof pool | any;

/**
 * The line's identity for price work: its ReceiptItem row id (the PRECISE Price link —
 * immune to (sp, store, date) slot-ownership) + its matched StoreProduct id. The row is
 * the source of truth (P2); the blob fallback (pre-backfill receipts) yields itemId null,
 * which downgrades the price locator to the legacy (receiptId, sp) key.
 */
async function resolveLineKey(
    receiptId: number,
    lineIdx: number,
): Promise<{ itemId: number | null; spId: number | null }> {
    const key = await getReceiptItemKey(receiptId, lineIdx);
    if (key && key.matchedSpId != null && key.matchedSpId > 0) {
        return { itemId: key.id, spId: key.matchedSpId };
    }
    if (key) return { itemId: key.id, spId: null };
    const [rows]: any = await pool.query('SELECT parsedData FROM Receipt WHERE id = ? LIMIT 1', [receiptId]);
    if (!rows[0]) return { itemId: null, spId: null };
    let parsed: any;
    try { parsed = typeof rows[0].parsedData === 'string' ? JSON.parse(rows[0].parsedData) : rows[0].parsedData; } catch { return { itemId: null, spId: null }; }
    const v = Number(parsed?.products?.[lineIdx]?.storeProductId);
    return { itemId: null, spId: Number.isFinite(v) && v > 0 ? v : null };
}

export type SwipeVote = MatchVote;

export interface CastSwipeVoteInput {
    userId: string;
    receiptId: number;
    receiptLineIdx: number;
    candidateStoreProductId: number;
    vote: SwipeVote;
    dwellMs: number;
    isMandatory?: boolean;
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
    isBurst?: boolean;
}

export interface UndoSwipeVoteInput {
    userId: string;
    receiptId: number;
    receiptLineIdx: number;
    candidateStoreProductId: number;
}

export interface EditVoteInput {
    userId: string;
    spIdA: number;
    spIdB: number;
    vote: SwipeVote;
}

/**
 * Edit a previously cast vote from the vote history screen. dwellMs is NULL
 * because this is a deliberate retrospective change, not a real-time swipe.
 * Always applies personal equivalence (never burst). Always re-evaluates
 * global merge thresholds.
 */
export const editVote = async (input: EditVoteInput): Promise<CastSwipeVoteResult> => {
    if (input.spIdA >= input.spIdB) {
        throw new Error('editVote requires spIdA < spIdB');
    }

    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        const [productIdA, productIdB] = await Promise.all([
            getProductIdForStoreProduct(input.spIdA, connection),
            getProductIdForStoreProduct(input.spIdB, connection),
        ]);

        const equivalenceVerdict = input.vote === 'identical' ? 'same' : 'different';
        await upsertEquivalence(input.userId, input.spIdA, input.spIdB, equivalenceVerdict, connection);
        await clearReverification(input.userId, input.spIdA, input.spIdB, connection);

        // editVote is a deliberate retrospective change — always aggregated. The
        // provenance-aware transition handles a burst PREVIOUS vote correctly (it was
        // never counted, so nothing is decremented; the new vote is counted fresh).
        const { previousVote, previousAggregated } = await upsertMatchVote(
            input.userId,
            input.spIdA,
            input.spIdB,
            input.vote,
            null,
            null,
            true,
            connection,
        );
        await applyVoteTransitionDeltas(
            input.spIdA, input.spIdB,
            previousVote, previousAggregated,
            input.vote,
            connection,
        );

        await applyBaseProductLinkForVote(
            input.spIdA,
            input.spIdB,
            // The link tally only ever received APPLIED votes — a burst previous
            // 'similar' was never added, so it must not be subtracted.
            previousAggregated ? previousVote : null,
            input.vote,
            connection,
            productIdA,
            productIdB,
        );

        const agg = await getMatchAggregate(input.spIdA, input.spIdB, connection);
        const merge = await reevaluateMerge(input.spIdA, input.spIdB, agg, connection, productIdA, productIdB);

        await connection.commit();
        return { ok: true, effect: 'vote-recorded', merge };
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
};

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

    // The line's current storeProductId + row id — from the ReceiptItem row (source of
    // truth), with a blob fallback for any receipt not yet backfilled.
    const { itemId: lineItemId, spId: lineSpId } = await resolveLineKey(input.receiptId, input.receiptLineIdx);
    if (lineSpId == null || lineSpId <= 0) {
        return { ok: true, effect: 'no-candidate' };
    }

    // Fetch SP names once for diagnostic logging below.
    const [spNameRows]: any = await pool.query(
        `SELECT id, storeProductName FROM StoreProduct WHERE id IN (?, ?)`,
        [lineSpId, input.candidateStoreProductId],
    );
    const spNames = new Map<number, string>(
        spNameRows.map((r: any) => [Number(r.id), (r.storeProductName ?? `SP#${r.id}`) as string]),
    );
    const lineName = spNames.get(lineSpId) ?? `SP#${lineSpId}`;
    const candidateName = spNames.get(input.candidateStoreProductId) ?? `SP#${input.candidateStoreProductId}`;

    // Self-pair (candidate already is the line's SP): the vote has no
    // cross-SP signal, so it's just an acknowledgement that the user has
    // seen this auto-match card. Flip priceVerified=1 for ANY direction so
    // the queue filter catches it on re-entry — otherwise self-pair
    // different/similar swipes leave no trace and the card would keep
    // showing. We lose nuance on self-pair different (user signalling
    // "auto-match was wrong"), but self-pair cards only exist for >=0.90-
    // confidence auto-matches where different is rare.
    if (input.candidateStoreProductId === lineSpId) {
        console.log(`[SWIPE] SELF-PAIR: "${lineName}" (sp=${lineSpId}) | dwell=${input.dwellMs}ms`);
        return await acknowledgeSelfPair(input, lineSpId, lineItemId);
    }

    const burst = isBurstSwipe(input.dwellMs);
    console.log(`[SWIPE] VOTE: "${lineName}" (sp=${lineSpId}) vs "${candidateName}" (sp=${input.candidateStoreProductId}) → ${input.vote}${burst ? ' [BURST]' : ''} | dwell=${input.dwellMs}ms | receipt=${input.receiptId} line=${input.receiptLineIdx}`);

    // Pair vote. Sort, write, update aggregate, re-evaluate promote/demote.
    const pair = orderPair(input.candidateStoreProductId, lineSpId);
    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        // awardSwipePoint moved to AFTER commit (fire-and-forget) — see
        // receiptSaveService for the User-row contention rationale. The
        // post-commit call fires regardless of burst (every non-rate-limited
        // swipe still earns its point).

        // Burst swipes earn points but do NOT feed the personal layer or the
        // global aggregate. Users who burst-swipe have no intent to personalise
        // their browse view — writing equivalences for them would pollute it.
        if (!burst) {
            const equivalenceVerdict = input.vote === 'identical' ? 'same' : 'different';
            await upsertEquivalence(input.userId, pair.spIdA, pair.spIdB, equivalenceVerdict, connection);
            // If this pair was flagged for re-verification, the user has now re-voted — clear the flag.
            await clearReverification(input.userId, pair.spIdA, pair.spIdB, connection);
        }
        // The row records its aggregation PROVENANCE (`!burst`); the transition helper
        // then adjusts the aggregate by what was REALLY counted before vs now — a burst
        // previous vote is never decremented, a burst re-vote never counted.
        const { previousVote, previousAggregated } = await upsertMatchVote(
            input.userId,
            pair.spIdA,
            pair.spIdB,
            input.vote,
            input.dwellMs,
            input.receiptId,
            !burst,
            connection
        );
        await applyVoteTransitionDeltas(
            pair.spIdA, pair.spIdB,
            previousVote, previousAggregated,
            burst ? null : input.vote,
            connection,
        );

        // Phase C3: maintain cross-baseProduct similarity link tallies. A
        // swipe that crosses a baseProduct boundary with vote='similar'
        // BaseProduct link and merge evaluation only run for non-burst votes.
        // Fetch productIds in parallel — two independent SP→Product lookups.
        const [productIdA, productIdB] = await Promise.all([
            getProductIdForStoreProduct(pair.spIdA, connection),
            getProductIdForStoreProduct(pair.spIdB, connection),
        ]);

        let merge: MergeDecision | undefined;
        // Link tally follows the same provenance rules as the aggregate: only an
        // APPLIED (aggregated) previous vote is subtracted, and a burst new vote adds
        // nothing (passed as null — deletion semantics for the link delta). This also
        // removes a previously-applied 'similar' when the user burst-re-votes.
        const effectivePrev = previousAggregated ? previousVote : null;
        const effectiveNew = burst ? null : input.vote;
        if (effectivePrev !== null || effectiveNew !== null) {
            await applyBaseProductLinkForVote(
                pair.spIdA,
                pair.spIdB,
                effectivePrev,
                effectiveNew,
                connection,
                productIdA,
                productIdB,
            );
        }
        if (!burst) {
            const agg = await getMatchAggregate(pair.spIdA, pair.spIdB, connection);
            merge = await reevaluateMerge(pair.spIdA, pair.spIdB, agg, connection, productIdA, productIdB);
        }

        // Also flip the line's Price verification as a user-visible signal.
        // (Aggregate/merge happens silently; this gives the user immediate feedback.)
        const linePriceEffect = await applyLinePriceEffect(input, lineSpId, lineItemId, connection);

        await connection.commit();
        awardSwipePoint(input.userId).catch((e) =>
            console.warn(`[swipeVoteService] points award failed for user ${input.userId}:`, e),
        );

        return {
            ok: true,
            effect:
                linePriceEffect.effect === 'no-price-row'
                    ? 'vote-recorded'
                    : linePriceEffect.effect,
            merge,
            isBurst: burst,
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
    const { itemId: lineItemId, spId: lineSpId } = await resolveLineKey(input.receiptId, input.receiptLineIdx);
    if (lineSpId == null || lineSpId <= 0) {
        return { ok: true, effect: 'no-candidate' };
    }

    // Self-pair undo: no vote row to delete. A self-pair vote can only VERIFY the
    // price (identical/similar) or flag the line (different — never touches the
    // price), so the only reversible price effect is a verification: treat the
    // undo as undoing an 'identical'. Never blind-verify here.
    if (input.candidateStoreProductId === lineSpId) {
        return await revertLinePriceEffect(input, lineSpId, lineItemId, 'identical');
    }

    const pair = orderPair(input.candidateStoreProductId, lineSpId);
    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();
        const { deletedVote, deletedAggregated } = await deleteMatchVote(
            input.userId,
            pair.spIdA,
            pair.spIdB,
            connection
        );
        const [productIdA, productIdB] = await Promise.all([
            getProductIdForStoreProduct(pair.spIdA, connection),
            getProductIdForStoreProduct(pair.spIdB, connection),
        ]);
        // Reverse ONLY contributions that were actually applied: a burst vote wrote a
        // row but never fed the aggregate/link — blind reversal drove counts negative.
        if (deletedVote !== null && deletedAggregated) {
            await applyAggregateDelta(pair.spIdA, pair.spIdB, deletedVote, -1, connection);
            // Also reverse any BaseProductLink increment the vote caused.
            // Passing newVote=null here — deletion is the terminal state.
            await applyBaseProductLinkForVote(
                pair.spIdA,
                pair.spIdB,
                deletedVote,
                null,
                connection,
                productIdA,
                productIdB,
            );
        }
        const agg = await getMatchAggregate(pair.spIdA, pair.spIdB, connection);
        const merge = await reevaluateMerge(pair.spIdA, pair.spIdB, agg, connection, productIdA, productIdB);

        const linePriceEffect = await revertLinePriceEffect(input, lineSpId, lineItemId, deletedVote, connection);

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
    conn: Connection,
    productIdA?: number | null,   // ← NEW: skip StoreProduct lookup if pre-fetched
    productIdB?: number | null,   // ← NEW: skip StoreProduct lookup if pre-fetched
): Promise<void> {
    const prevSimilar = previousVote === 'similar' ? 1 : 0;
    const newSimilar = newVote === 'similar' ? 1 : 0;
    const delta = newSimilar - prevSimilar;
    if (delta === 0) return;

    const [bpA, bpB] = await Promise.all([
        getEffectiveBaseProductIdForStoreProduct(spIdA, conn, productIdA ?? undefined),
        getEffectiveBaseProductIdForStoreProduct(spIdB, conn, productIdB ?? undefined),
    ]);
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
    conn: Connection,
    productIdA?: number | null,   // ← NEW: skip StoreProduct lookup if pre-fetched
    productIdB?: number | null,   // ← NEW: skip StoreProduct lookup if pre-fetched
): Promise<MergeDecision | undefined> {
    if (!agg) return undefined;
    const total = agg.identicalVotes + agg.similarVotes + agg.differentVotes;
    if (total === 0) return undefined;

    const identicalLower = wilsonLowerBound(
        agg.identicalVotes,
        total,
        MatchThresholds.wilsonZ
    );
    console.log(`[MERGE] Aggregate SP(${spIdA},${spIdB}): identical=${agg.identicalVotes} similar=${agg.similarVotes} different=${agg.differentVotes} | wilsonLower=${identicalLower.toFixed(3)} | promoteNeeds=${MatchThresholds.promoteIdentical.minVotes}votes/${MatchThresholds.promoteIdentical.minWilsonLower}wilson`);

    const [resolvedProductIdA, resolvedProductIdB] = await Promise.all([
        productIdA != null ? Promise.resolve(productIdA) : getProductIdForStoreProduct(spIdA, conn),
        productIdB != null ? Promise.resolve(productIdB) : getProductIdForStoreProduct(spIdB, conn),
    ]);
    if (resolvedProductIdA === null || resolvedProductIdB === null) return undefined;

    // Promote: high positive-rate, enough votes → merge their Products.
    if (
        agg.identicalVotes >= MatchThresholds.promoteIdentical.minVotes &&
        identicalLower >= MatchThresholds.promoteIdentical.minWilsonLower
    ) {
        // Mark any OrphanSwipeCandidate row for this Product pair as
        // resolved so the extra-queue stops serving it. Fires regardless
        // of whether the merge was driven by a receipt vote or an orphan
        // vote — hook is inside reevaluateMerge so both paths converge.
        await markResolvedForProductPair(resolvedProductIdA, resolvedProductIdB, 'promoted', conn);
        const decision = await promoteMergeByProductIds(resolvedProductIdA, resolvedProductIdB, conn);
        // If exactly one side was an uncategorised (688) scraped item, this confirmed match
        // categorises it — fail-open so a categorisation hiccup never rolls back a valid vote.
        try {
            await categoriseUncategorisedOnMerge(decision, conn);
        } catch (e) {
            console.warn('[reevaluateMerge] uncategorised categorisation rescue failed', e);
        }
        return decision;
    }

    // Demote: confidence dropped below the demote band → unmerge.
    if (
        agg.identicalVotes >= MatchThresholds.demoteIdentical.minVotes &&
        identicalLower <= MatchThresholds.demoteIdentical.maxWilsonLower
    ) {
        await markResolvedForProductPair(resolvedProductIdA, resolvedProductIdB, 'demoted', conn);
        return demoteMergeByProductIds(resolvedProductIdA, resolvedProductIdB, conn);
    }

    return undefined;
}

/**
 * Flip Price.priceVerified in response to a vote, using the same "primary row
 * per (receipt, storeProduct)" semantics as C1. `identical` flips on,
 * `different` flips off, `similar` leaves it alone.
 */
/**
 * Acknowledge a self-pair swipe.
 *
 * identical / similar → verify the price (user confirms the auto-match).
 * different → the auto-match was wrong. Do NOT verify the price; flag the
 *   line for admin review so the SP assignment can be corrected.
 */
async function acknowledgeSelfPair(
    input: CastSwipeVoteInput,
    lineSpId: number,
    lineItemId: number | null,
): Promise<CastSwipeVoteResult> {
    if (input.vote === 'different') {
        await pool.query(
            `INSERT INTO AdminReviewFlag (type, receiptId, lineIdx, spId, flaggedBy)
             VALUES ('self-pair-rejected', ?, ?, ?, ?)`,
            [input.receiptId, input.receiptLineIdx, lineSpId, input.userId],
        );
        return { ok: true, effect: 'vote-recorded' };
    }

    // ReceiptItem.priceVerified is the LINE-scoped truth the queue filter reads —
    // synced even when the Price slot row belongs to another receipt (same sp,
    // store, date), so the confirmed card never re-surfaces.
    if (lineItemId != null) {
        await updateReceiptItem(input.receiptId, input.receiptLineIdx, { priceVerified: true });
    }
    const priceRow = await findLinePrimaryPrice(lineItemId, input.receiptId, lineSpId);
    if (!priceRow) {
        return { ok: true, effect: 'no-price-row' };
    }
    if (priceRow.priceVerified) {
        return { ok: true, effect: 'price-already-verified' };
    }
    await pool.query(`UPDATE Price SET priceVerified = 1 WHERE id = ?`, [priceRow.id]);
    return { ok: true, effect: 'price-verified' };
}

async function applyLinePriceEffect(
    input: CastSwipeVoteInput,
    lineSpId: number,
    lineItemId: number | null,
    conn?: Connection
): Promise<CastSwipeVoteResult> {
    const db = conn || pool;

    // Keep the LINE-scoped truth (ReceiptItem.priceVerified — what the queue filter
    // reads) in step with the vote, regardless of Price slot ownership.
    if (lineItemId != null && (input.vote === 'identical' || input.vote === 'different')) {
        await updateReceiptItem(input.receiptId, input.receiptLineIdx,
            { priceVerified: input.vote === 'identical' }, db);
    }

    const priceRow = await findLinePrimaryPrice(lineItemId, input.receiptId, lineSpId, db);
    if (!priceRow) {
        return { ok: true, effect: 'no-price-row' };
    }

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
 * Undo counterpart of `applyLinePriceEffect` — VOTE-AWARE, and it NEVER VERIFIES:
 *   identical → the vote verified the price → undo: UNVERIFY (when currently verified)
 *   different → the vote MAY have unverified it (or was a no-op if it was already
 *               unverified — we don't store the prior state) → undo: NO-OP. Restoring
 *               verification here could mark a never-vote-verified price as VERIFIED,
 *               which is the dangerous direction (it feeds the baseline/clearance
 *               machinery); staying unverified is always safe.
 *   similar   → never touched the price → undo: no-op
 *   null      → no vote row was deleted (double-undo / unknown) → no-op
 * The old blind toggle flipped whatever state it found, so undoing a 'similar' (or a
 * repeated undo) could false-verify an OCR price.
 */
async function revertLinePriceEffect(
    input: UndoSwipeVoteInput,
    lineSpId: number,
    lineItemId: number | null,
    undoneVote: MatchVote | null,
    conn?: Connection
): Promise<CastSwipeVoteResult> {
    if (undoneVote !== 'identical') {
        return { ok: true, effect: 'vote-recorded' }; // nothing safely reversible
    }
    const db = conn || pool;
    // Un-verify the LINE truth too (mirrors applyLinePriceEffect's sync).
    if (lineItemId != null) {
        await updateReceiptItem(input.receiptId, input.receiptLineIdx, { priceVerified: false }, db);
    }
    const priceRow = await findLinePrimaryPrice(lineItemId, input.receiptId, lineSpId, db);
    if (!priceRow) {
        return { ok: true, effect: 'no-price-row' };
    }
    if (!priceRow.priceVerified) {
        return { ok: true, effect: 'price-already-unverified' };
    }
    await db.query(`UPDATE Price SET priceVerified = 0 WHERE id = ?`, [priceRow.id]);
    return { ok: true, effect: 'price-unverified' };
}
