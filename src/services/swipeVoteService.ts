import pool from '../config/db.js';

export type SwipeVote = 'identical' | 'similar' | 'different';

export interface CastSwipeVoteInput {
    userId: string;
    receiptId: number;
    receiptLineIdx: number;
    candidateStoreProductId: number;
    vote: SwipeVote;
    dwellMs: number;
}

export interface CastSwipeVoteResult {
    ok: boolean;
    effect:
        | 'price-verified'
        | 'price-already-verified'
        | 'no-price-row'
        | 'no-candidate'
        | 'no-effect-yet'
        | 'dropped-burst';
}

/**
 * Minimum burst filter: a vote that the user spent less than this dwelling on
 * the card is considered accidental and silently discarded. Matches the
 * `dwellMs >= 500` heuristic in the design. More elaborate rate-limiting
 * arrives in C2 alongside the StoreProductMatchVote write path.
 */
const MIN_DWELL_MS = 500;

/**
 * Process a swipe vote in the Phase C1 scope: the only backend side-effect is
 * flipping `Price.isVerified = 1` on identical votes that point at a
 * candidate the matcher already auto-applied. Every other combination is
 * accepted and returns `no-effect-yet` — C2 will persist votes to
 * StoreProductMatchVote, update the pair aggregate, and run the
 * promote/demote state machine.
 */
export const castSwipeVote = async (
    input: CastSwipeVoteInput
): Promise<CastSwipeVoteResult> => {
    if (input.dwellMs < MIN_DWELL_MS) {
        return { ok: true, effect: 'dropped-burst' };
    }

    if (input.vote !== 'identical') {
        return { ok: true, effect: 'no-effect-yet' };
    }

    const [candRows]: any = await pool.query(
        `SELECT autoMatched
           FROM ReceiptSwipeCandidate
          WHERE receiptId = ? AND receiptLineIdx = ? AND storeProductId = ?
          LIMIT 1`,
        [input.receiptId, input.receiptLineIdx, input.candidateStoreProductId]
    );
    if (candRows.length === 0) {
        return { ok: true, effect: 'no-candidate' };
    }

    // Primary-row only. Fallback rows (isFallback=1) are derived copies the
    // price-propagation service writes across the rest of the chain's stores
    // — they all reference the same receiptId for traceability but the user
    // is confirming the original line, not the derived ones.
    const [priceRows]: any = await pool.query(
        `SELECT id, priceVerified
           FROM Price
          WHERE receiptId = ? AND storeProductId = ? AND isFallback = 0
          LIMIT 1`,
        [input.receiptId, input.candidateStoreProductId]
    );
    if (priceRows.length === 0) {
        return { ok: true, effect: 'no-price-row' };
    }
    if (priceRows[0].priceVerified) {
        return { ok: true, effect: 'price-already-verified' };
    }

    await pool.query(
        `UPDATE Price SET priceVerified = 1 WHERE id = ?`,
        [priceRows[0].id]
    );
    return { ok: true, effect: 'price-verified' };
};
