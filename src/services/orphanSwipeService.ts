/**
 * Vote ingestion for the cross-chain orphan swipe feed ("Gal dar?" cards).
 *
 * Reuses the existing StoreProductMatch / StoreProductMatchVote tables and
 * the reevaluateMerge promote/demote decision machinery. The only piece
 * specific to this path is:
 *   - A separate dwell threshold (minDwellMsOrphan = 700ms) — orphan cards
 *     pair two unfamiliar Products, so we want more reading time before
 *     counting the vote toward the aggregate.
 *   - No receipt-line lookup, no Price.priceVerified flip.
 *
 * When a vote crosses a promote/demote threshold, reevaluateMerge itself
 * calls markResolvedForProductPair — we don't need to do it here.
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
import { getCandidatePair } from '../models/orphanSwipeCandidateModel.js';

export interface CastOrphanSwipeVoteInput {
    userId: string;
    /** OrphanSwipeCandidate.id — the row the frontend is swiping on. */
    candidateId: number;
    vote: SwipeVote;
    dwellMs: number;
}

export const castOrphanSwipeVote = async (
    input: CastOrphanSwipeVoteInput
): Promise<CastSwipeVoteResult> => {
    // Stricter dwell bar for cross-chain cards than for receipt cards.
    // The vote row is NOT recorded at all when dropped by this guard —
    // matches the receipt-flow behavior in castSwipeVote.
    if (input.dwellMs < MatchThresholds.minDwellMsOrphan) {
        return { ok: true, effect: 'dropped-burst' };
    }

    const recent = await countRecentVotes(input.userId, 60);
    if (recent >= MatchThresholds.maxUserVotesPerMinute) {
        return { ok: true, effect: 'dropped-rate-limit' };
    }

    const spPair = await getCandidatePair(input.candidateId);
    if (!spPair) {
        return { ok: true, effect: 'no-candidate' };
    }

    const pair = orderPair(spPair.orphanSpId, spPair.candidateSpId);
    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        const { previousVote } = await upsertMatchVote(
            input.userId,
            pair.spIdA,
            pair.spIdB,
            input.vote,
            input.dwellMs,
            // receiptId is nullable in the schema; orphan votes pass null.
            null,
            connection
        );
        if (previousVote !== null && previousVote !== input.vote) {
            await applyAggregateDelta(pair.spIdA, pair.spIdB, previousVote, -1, connection);
        }
        if (previousVote !== input.vote) {
            await applyAggregateDelta(pair.spIdA, pair.spIdB, input.vote, +1, connection);
        }

        await applyBaseProductLinkForVote(
            pair.spIdA,
            pair.spIdB,
            previousVote,
            input.vote,
            connection
        );

        const agg = await getMatchAggregate(pair.spIdA, pair.spIdB, connection);
        const merge = await reevaluateMerge(pair.spIdA, pair.spIdB, agg, connection);

        await connection.commit();
        return { ok: true, effect: 'vote-recorded', merge };
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
};
