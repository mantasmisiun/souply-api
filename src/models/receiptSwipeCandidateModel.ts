import pool from '../config/db.js';

type Connection = typeof pool | any;

export interface SwipeCandidate {
    storeProductId: number;
    matchScore: number;
    autoMatched: boolean;
}

/**
 * Replace all swipe candidates for a receipt. Called both on initial receipt
 * POST and on subsequent PATCH/updates — treat the parsedData snapshot as the
 * source of truth and rebuild the candidate list from it each time. Capped
 * at MAX_CANDIDATES_PER_LINE candidates per receipt line downstream.
 *
 * Outer array is indexed by `receiptLineIdx` (parsedData.products index).
 * Inner array order is the rank order delivered by the matcher (best first).
 * Empty inner arrays (lines with zero candidates) are fine — they produce no
 * rows, and the line is treated as an orphan by Phase C's swipe UI.
 */
export const replaceSwipeCandidates = async (
    receiptId: number,
    candidatesByLine: SwipeCandidate[][],
    conn?: Connection
): Promise<void> => {
    const db = conn || pool;

    await db.query(
        'DELETE FROM ReceiptSwipeCandidate WHERE receiptId = ?',
        [receiptId]
    );

    const rows: any[] = [];
    candidatesByLine.forEach((lineCandidates, lineIdx) => {
        lineCandidates.forEach((c, i) => {
            if (!Number.isFinite(c.storeProductId) || c.storeProductId <= 0) return;
            rows.push([
                receiptId,
                lineIdx,
                i + 1, // rankPos is 1-based
                c.storeProductId,
                Math.max(0, Math.min(1, c.matchScore)),
                c.autoMatched ? 1 : 0,
            ]);
        });
    });

    if (rows.length === 0) return;

    await db.query(
        `INSERT INTO ReceiptSwipeCandidate
           (receiptId, receiptLineIdx, rankPos, storeProductId, matchScore, autoMatched)
         VALUES ?`,
        [rows]
    );
};

export const getSwipeCandidatesByReceipt = async (receiptId: number) => {
    const [rows]: any = await pool.query(
        `SELECT receiptLineIdx, rankPos, storeProductId, matchScore, autoMatched
         FROM ReceiptSwipeCandidate
         WHERE receiptId = ?
         ORDER BY receiptLineIdx, rankPos`,
        [receiptId]
    );
    return rows;
};

/**
 * Fetch candidates joined with StoreProduct + StoreChain details, ready for
 * the swipe UI. Returns flat rows; the controller groups by receiptLineIdx.
 */
export const getSwipeCandidatesWithDetails = async (receiptId: number) => {
    const [rows]: any = await pool.query(
        `SELECT
            rsc.receiptLineIdx,
            rsc.rankPos,
            rsc.storeProductId,
            rsc.matchScore,
            rsc.autoMatched,
            sp.storeProductName AS name,
            sp.brandName,
            sp.amount,
            sp.unit,
            sp.isWeighable,
            sp.imageUrl,
            sp.productId,
            sc.id          AS chainId,
            sc.name        AS chainName,
            sc.logoUrl     AS chainLogoUrl
         FROM ReceiptSwipeCandidate rsc
         JOIN StoreProduct sp ON sp.id = rsc.storeProductId
         JOIN StoreChain   sc ON sc.id = sp.chainId
         WHERE rsc.receiptId = ?
         ORDER BY rsc.receiptLineIdx ASC, rsc.rankPos ASC`,
        [receiptId]
    );
    return rows;
};

/**
 * All cross-SP pair-votes the given user has EVER cast, across all
 * receipts. Returned as a Set of "min-max" strings for O(1) lookup
 * by the queue filter.
 *
 * Intentionally NOT scoped to receiptId: StoreProductMatchVote has a
 * UNIQUE key on (userId, spIdA, spIdB), so there's exactly one row
 * per user+pair regardless of which receipt surfaced it. Filtering by
 * receiptId caused the repeat-cards bug — when Receipt A's queue
 * surfaced pair (X, Y) and the user voted, then Receipt B's queue
 * also contained (X, Y), the receipt-scoped filter missed it and
 * re-served the same pair. Multiplied across N receipts with
 * overlapping altMatches (e.g., multiple energy-drink receipts all
 * surfacing Red Bull as a candidate), users would see the same pairs
 * appear to loop forever.
 *
 * Secondary gotcha that made this worse: upsertMatchVote OVERWRITES
 * the row's receiptId on a repeat vote, so even the original receipt
 * that surfaced the pair would stop filtering it after the user voted
 * again elsewhere.
 */
export const getVotedPairKeysForUser = async (
    userId: string
): Promise<Set<string>> => {
    const [rows]: any = await pool.query(
        `SELECT spIdA, spIdB
           FROM StoreProductMatchVote
          WHERE userId = ?`,
        [userId]
    );
    const s = new Set<string>();
    for (const r of rows) s.add(`${r.spIdA}-${r.spIdB}`);
    return s;
};

/**
 * Store-products for which this receipt has a verified primary Price row.
 * Used by the queue filter to drop self-pair cards the user has already
 * confirmed via identical-swipe (which flips Price.priceVerified in-DB but
 * doesn't propagate into Receipt.parsedData — so JSON alone is stale).
 */
export const getVerifiedStoreProductIdsForReceipt = async (
    receiptId: number
): Promise<Set<number>> => {
    // LINE-scoped truth first: ReceiptItem.priceVerified is synced by every vote flip
    // and is immune to (sp, store, date) Price-slot ownership (a same-slot second
    // receipt has no Price row of its own but its line still verifies). The Price arm
    // remains for legacy pre-migration receipts whose flips only ever touched Price.
    const [rows]: any = await pool.query(
        `SELECT DISTINCT matchedSpId AS spId
           FROM ReceiptItem
          WHERE receiptId = ? AND priceVerified = 1 AND matchedSpId IS NOT NULL
         UNION
         SELECT DISTINCT storeProductId AS spId
           FROM Price
          WHERE receiptId = ? AND isFallback = 0 AND priceVerified = 1`,
        [receiptId, receiptId]
    );
    const s = new Set<number>();
    for (const r of rows) s.add(Number(r.spId));
    return s;
};
