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
    applyAggregateDelta,
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

export interface CastDirectSpPairVoteInput {
    userId: string;
    spIdA: number;
    spIdB: number;
    vote: SwipeVote;
    dwellMs: number;
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

        if (!burst) {
            const { previousVote } = await upsertMatchVote(
                input.userId,
                pair.spIdA,
                pair.spIdB,
                input.vote,
                input.dwellMs,
                null,
                connection,
            );

            if (previousVote !== null && previousVote !== input.vote) {
                await applyAggregateDelta(pair.spIdA, pair.spIdB, previousVote, -1, connection);
            }
            if (previousVote !== input.vote) {
                await applyAggregateDelta(pair.spIdA, pair.spIdB, input.vote, +1, connection);
            }

            const [productIdA, productIdB] = await Promise.all([
                getProductIdForStoreProduct(pair.spIdA, connection),
                getProductIdForStoreProduct(pair.spIdB, connection),
            ]);

            await applyBaseProductLinkForVote(
                pair.spIdA,
                pair.spIdB,
                previousVote,
                input.vote,
                connection,
                productIdA,
                productIdB,
            );

            const agg = await getMatchAggregate(pair.spIdA, pair.spIdB, connection);
            const merge = await reevaluateMerge(pair.spIdA, pair.spIdB, agg, connection, productIdA, productIdB);

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
