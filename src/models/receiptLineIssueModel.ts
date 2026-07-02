import pool from '../config/db.js';

export interface IssueFlags {
    name: boolean;
    price: boolean;
    amount: boolean;
    discount: boolean;
    image: boolean;
}

/**
 * Upsert an issue report for (receiptId, lineIdx, userId). One row per user
 * per line — re-reporting updates flags rather than creating duplicates.
 * Returns the number of flagged fields for quick caller-side logging.
 */
export const upsertReceiptLineIssue = async (
    receiptId: number,
    lineIdx: number,
    userId: string,
    flags: IssueFlags,
    note: string | null
): Promise<number> => {
    const flaggedCount =
        (flags.name ? 1 : 0) +
        (flags.price ? 1 : 0) +
        (flags.amount ? 1 : 0) +
        (flags.discount ? 1 : 0) +
        (flags.image ? 1 : 0);

    await pool.query(
        `INSERT INTO ReceiptLineIssue
              (receiptId, receiptLineIdx, userId, flags, note)
         VALUES (?, ?, ?, CAST(? AS JSON), ?)
         ON DUPLICATE KEY UPDATE
              flags = CAST(VALUES(flags) AS JSON),
              note  = VALUES(note),
              createdAt = CURRENT_TIMESTAMP`,
        [receiptId, lineIdx, userId, JSON.stringify(flags), note]
    );
    return flaggedCount;
};

/**
 * Set Price.priceVerified=0 for the receipt+SP combo (primary row only).
 * Called alongside issue reports so flagged lines stop contributing to
 * trusted comparison totals until an admin triages them.
 */
export const unverifyReceiptLinePrice = async (
    receiptId: number,
    storeProductId: number
): Promise<void> => {
    await pool.query(
        `UPDATE Price SET priceVerified = 0
          WHERE isFallback = 0
            AND (receiptItemId IN (SELECT id FROM ReceiptItem WHERE receiptId = ? AND matchedSpId = ?)
                 OR (receiptItemId IS NULL AND receiptId = ? AND storeProductId = ?))`,
        [receiptId, storeProductId, receiptId, storeProductId]
    );
};

/**
 * Set a receipt line's Price.priceVerified (conn-aware so it can join a vote
 * transaction). identical-swipe confirm → 1; similar/different → 0.
 */
export const setReceiptLinePriceVerified = async (
    receiptId: number,
    storeProductId: number,
    verified: boolean,
    db: typeof pool | any = pool
): Promise<void> => {
    await db.query(
        `UPDATE Price SET priceVerified = ?
          WHERE isFallback = 0
            AND (receiptItemId IN (SELECT id FROM ReceiptItem WHERE receiptId = ? AND matchedSpId = ?)
                 OR (receiptItemId IS NULL AND receiptId = ? AND storeProductId = ?))`,
        [verified ? 1 : 0, receiptId, storeProductId, receiptId, storeProductId]
    );
};
