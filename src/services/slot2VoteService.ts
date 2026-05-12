import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';
import {
    applyAggregateDelta,
    countRecentVotes,
    getMatchAggregate,
    orderPair,
    upsertMatchVote,
} from '../models/storeProductMatchModel.js';
import { upsertEquivalence } from '../models/userEquivalenceModel.js';
import { awardSwipePoint } from './userPointsService.js';
import { getProductIdForStoreProduct } from './storeProductMergeService.js';
import { applyBaseProductLinkForVote } from './swipeVoteService.js';
import { wilsonLowerBound } from '../utils/wilson.js';
import type { CastSwipeVoteResult } from './swipeVoteService.js';

export interface CastSlot2VoteInput {
    userId: string;
    orphanSpId: number;
    candidateSpId: number;
    vote: 'identical' | 'similar' | 'different';
    dwellMs: number;
    /** Pre-computed by the queue builder from the two SP units. */
    conflictDetected: boolean;
    sameChain: boolean;
    /** Passed through for OCR audit when sameChain=true and vote='identical'. */
    receiptId?: number;
}

type Connection = typeof pool | any;

// ── internal helpers ────────────────────────────────────────────────────────

/**
 * Move an orphan SP out of category 688 (Nepriskirta) into the candidate's
 * category. If `categoryOnly` is false, also copies the candidate's imageUrl
 * onto the orphan SP when the orphan currently has none.
 *
 * Returns early (no-op) when:
 *   - the orphan Product row is missing
 *   - the orphan's categoryId is not 688 (already rescued by a prior vote)
 */
async function executeRescue(
    orphanSpId: number,
    candidateSpId: number,
    categoryOnly: boolean,
    conn: Connection,
): Promise<void> {
    const [orphanRows]: any = await conn.query(
        `SELECT p.id AS productId, p.categoryId
           FROM StoreProduct sp
           JOIN Product p ON p.id = sp.productId
          WHERE sp.id = ?
          LIMIT 1`,
        [orphanSpId],
    );

    if (orphanRows.length === 0) return;
    const { productId: orphanProductId, categoryId: orphanCategoryId } = orphanRows[0];

    // Only rescue genuine orphans; skip if already re-categorised.
    if (orphanCategoryId !== 688) return;

    const [candidateRows]: any = await conn.query(
        `SELECT p.categoryId, sp.imageUrl AS candidateImageUrl
           FROM StoreProduct sp
           JOIN Product p ON p.id = sp.productId
          WHERE sp.id = ?
          LIMIT 1`,
        [candidateSpId],
    );

    if (candidateRows.length === 0) return;
    const { categoryId: newCategoryId, candidateImageUrl } = candidateRows[0];

    await conn.query(
        `UPDATE Product SET categoryId = ? WHERE id = ?`,
        [newCategoryId, orphanProductId],
    );

    if (!categoryOnly) {
        const [spRows]: any = await conn.query(
            `SELECT imageUrl FROM StoreProduct WHERE id = ? LIMIT 1`,
            [orphanSpId],
        );
        const orphanImageUrl: string | null = spRows[0]?.imageUrl ?? null;

        if (orphanImageUrl === null && candidateImageUrl) {
            await conn.query(
                `UPDATE StoreProduct SET imageUrl = ? WHERE id = ?`,
                [candidateImageUrl, orphanSpId],
            );
        }
    }
}

/**
 * Insert an AdminReviewFlag so the same-chain right swipe is surfaced for
 * human review (the scanner may have mis-matched the line to a different SP).
 * receiptId may be null if the caller has none.
 */
async function logOcrFlag(
    receiptId: number | null,
    orphanSpId: number,
    userId: string,
    conn: Connection,
): Promise<void> {
    await conn.query(
        `INSERT INTO AdminReviewFlag (type, receiptId, spId, flaggedBy)
         VALUES ('rescue-same-chain-right', ?, ?, ?)`,
        [receiptId, orphanSpId, userId],
    );
}

// ── public API ───────────────────────────────────────────────────────────────

export const castSlot2Vote = async (
    input: CastSlot2VoteInput,
): Promise<CastSwipeVoteResult> => {
    // Rate-limit check happens before opening a connection.
    const recent = await countRecentVotes(input.userId, 60);
    if (recent >= MatchThresholds.maxUserVotesPerMinute) {
        return { ok: true, effect: 'dropped-rate-limit' };
    }

    const burst = input.dwellMs < MatchThresholds.minDwellMsOrphan;

    const pair = orderPair(input.orphanSpId, input.candidateSpId);
    const { spIdA, spIdB } = pair;

    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        // Award point for every swipe, even bursts — keeps engagement metrics honest.
        await awardSwipePoint(input.userId, connection);

        if (!burst) {
            const equivalenceVerdict = input.vote === 'identical' ? 'same' : 'different';
            await upsertEquivalence(input.userId, spIdA, spIdB, equivalenceVerdict, connection);

            const { previousVote } = await upsertMatchVote(
                input.userId,
                spIdA,
                spIdB,
                input.vote,
                input.dwellMs,
                null,
                connection,
            );

            // Net-delta aggregate update: retract old vote then apply new one.
            if (previousVote !== null && previousVote !== input.vote) {
                await applyAggregateDelta(spIdA, spIdB, previousVote, -1, connection);
            }
            if (previousVote !== input.vote) {
                await applyAggregateDelta(spIdA, spIdB, input.vote, +1, connection);
            }

            const [productIdA, productIdB] = await Promise.all([
                getProductIdForStoreProduct(spIdA, connection),
                getProductIdForStoreProduct(spIdB, connection),
            ]);

            await applyBaseProductLinkForVote(
                spIdA,
                spIdB,
                previousVote,
                input.vote,
                connection,
                productIdA,
                productIdB,
            );

            const agg = await getMatchAggregate(spIdA, spIdB, connection);
            if (agg) {
                const total = agg.identicalVotes + agg.similarVotes + agg.differentVotes;

                if (input.vote === 'identical') {
                    const lb = wilsonLowerBound(agg.identicalVotes, total, MatchThresholds.wilsonZ);
                    if (
                        agg.identicalVotes >= MatchThresholds.promoteIdentical.minVotes &&
                        lb >= MatchThresholds.promoteIdentical.minWilsonLower
                    ) {
                        // conflictDetected=false means full rescue (category + image).
                        await executeRescue(input.orphanSpId, input.candidateSpId, input.conflictDetected, connection);
                        if (input.sameChain) {
                            await logOcrFlag(input.receiptId ?? null, input.orphanSpId, input.userId, connection);
                        }
                    }
                } else if (input.vote === 'similar') {
                    const lb = wilsonLowerBound(agg.similarVotes, total, MatchThresholds.wilsonZ);
                    if (
                        agg.similarVotes >= MatchThresholds.promoteSimilar.minVotes &&
                        lb >= MatchThresholds.promoteSimilar.minWilsonLower
                    ) {
                        // Similar threshold: category-only rescue (never copy image).
                        await executeRescue(input.orphanSpId, input.candidateSpId, true, connection);
                    }
                }
                // 'different': no rescue action.
            }
        }

        await connection.commit();
        return { ok: true, effect: 'vote-recorded', isBurst: burst };
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
};
