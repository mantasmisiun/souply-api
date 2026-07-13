/**
 * Core vote ingestion for Slot 1 and Slot 3 cards.
 *
 * Accepts direct SP IDs (no OrphanSwipeCandidate lookup needed) and applies
 * the same dwell/rate-limit contract as the new slot handlers:
 *   - Rate-limit exceeded  → vote dropped entirely, no points
 *   - Dwell < 700ms (burst) → point awarded, aggregate and equivalences skipped
 *   - Normal              → point + full aggregate + merge evaluation
 *
 * Reuses the existing StoreProductMatch / StoreProductMatchVote tables and
 * the reevaluateMerge machinery from swipeVoteService unchanged.
 */

import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import {
    applyVoteTransitionDeltas,
    countRecentVotes,
    getMatchAggregate,
    orderPair,
    upsertMatchVote,
} from '../models/storeProductMatchModel.js';
import {
    applyBaseProductLinkForVote,
    reevaluateMerge,
    type SwipeVote,
    type CastSwipeVoteResult,
} from './swipeVoteService.js';
import { getProductIdForStoreProduct } from './storeProductMergeService.js';
import { awardSwipePoint } from './userPointsService.js';
import { upsertEquivalence } from '../models/userEquivalenceModel.js';
import { demoteRejectedReceiptLine } from './receiptLineDemotionService.js';

export interface CastDirectSpPairVoteInput {
    userId: string;
    spIdA: number;
    spIdB: number;
    vote: SwipeVote;
    dwellMs: number;
    /**
     * When the card came from a receipt's swipe queue, the receipt it belongs to.
     * A 'different' vote that rejects a line's primary match identity then demotes
     * that line (drops the wrong SP → OCR). Absent for standalone/orphan cards.
     */
    receiptId?: number | null;
}

export const castDirectSpPairVote = async (
    input: CastDirectSpPairVoteInput,
): Promise<CastSwipeVoteResult> => {
    const recent = await countRecentVotes(input.userId, 60);
    if (recent >= MatchThresholds.maxUserVotesPerMinute) {
        return { ok: true, effect: 'dropped-rate-limit' };
    }

    const burst = input.dwellMs < MatchThresholds.minDwellMsOrphan;
    const pair = orderPair(input.spIdA, input.spIdB);

    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        // awardSwipePoint moved to AFTER commit (fire-and-forget) — see
        // receiptSaveService for the User-row contention rationale. The
        // post-commit call fires on BOTH commit paths below (burst + non-burst)
        // so bursts still earn their point.

        // The vote ROW is written for burst votes too (aggregated=0): without it the
        // no-repeat rule never sees the card (it loops forever), the per-minute rate
        // limit never accrues (points farmable by flick-swiping), and the DEV learning
        // reset can't find the vote. Only the aggregate/equivalence/merge SIGNAL is
        // burst-gated. The real receiptId is recorded so the reset covers these votes.
        const { previousVote, previousAggregated } = await upsertMatchVote(
            input.userId,
            pair.spIdA,
            pair.spIdB,
            input.vote,
            input.dwellMs,
            input.receiptId ?? null,
            !burst,
            connection,
        );
        await applyVoteTransitionDeltas(
            pair.spIdA, pair.spIdB,
            previousVote, previousAggregated,
            burst ? null : input.vote,
            connection,
        );

        if (!burst) {
            // Personal equivalence so the user's browse + product detail merge
            // immediately — same mapping slot2 uses: identical|similar → 'same'
            // (so both pull an orphan out of Nepriskirta for this user),
            // different → 'different'. Burst votes are excluded here too, mirroring
            // their exclusion from the global aggregate.
            const equivalenceVerdict =
                input.vote === 'identical' || input.vote === 'similar' ? 'same' : 'different';
            await upsertEquivalence(input.userId, pair.spIdA, pair.spIdB, equivalenceVerdict, connection);

            const [productIdA, productIdB] = await Promise.all([
                getProductIdForStoreProduct(pair.spIdA, connection),
                getProductIdForStoreProduct(pair.spIdB, connection),
            ]);

            await applyBaseProductLinkForVote(
                pair.spIdA,
                pair.spIdB,
                // Only an APPLIED previous vote is subtracted from the link tally.
                previousAggregated ? previousVote : null,
                input.vote,
                connection,
                productIdA,
                productIdB,
            );

            const agg = await getMatchAggregate(pair.spIdA, pair.spIdB, connection);
            const merge = await reevaluateMerge(pair.spIdA, pair.spIdB, agg, connection, productIdA, productIdB);

            // Receipt-line demotion: a 'different' vote that rejects a line's primary
            // match identity drops the wrong SP so the Items tab shows OCR again.
            // Fail-open for ordinary parse/IO hiccups — BUT a deadlock must RETHROW:
            // MySQL rolls back the WHOLE transaction on ER_LOCK_DEADLOCK, so swallowing
            // it here made the code "commit" an already-rolled-back txn — the VOTE
            // itself was silently lost while the client saw ok (receipt-232: the third
            // card hung through the lock wait, then the vote evaporated). The caller
            // retries the whole vote via withDeadlockRetry.
            if (input.vote === 'different' && input.receiptId != null) {
                try {
                    await demoteRejectedReceiptLine(Number(input.receiptId), pair.spIdA, pair.spIdB, connection);
                } catch (e: any) {
                    if (e?.code === 'ER_LOCK_DEADLOCK' || e?.errno === 1213) throw e;
                    console.warn(`[directSpPairVoteService] line demotion failed for receipt ${input.receiptId}:`, e);
                }
            }

            await connection.commit();
            awardSwipePoint(input.userId).catch((e) =>
                console.warn(`[directSpPairVoteService] points award failed for user ${input.userId}:`, e),
            );
            return { ok: true, effect: 'vote-recorded', merge };
        }

        await connection.commit();
        awardSwipePoint(input.userId).catch((e) =>
            console.warn(`[directSpPairVoteService] points award failed for user ${input.userId}:`, e),
        );
        return { ok: true, effect: 'vote-recorded', isBurst: true };
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
};
