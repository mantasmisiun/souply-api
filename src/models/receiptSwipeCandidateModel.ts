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
