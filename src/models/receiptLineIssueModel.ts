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
    // TWO statements, NOT one OR: the OR across different access paths defeats index
    // selection and the UPDATE walks the whole 13M-row Price table under locks (~20s per
    // swipe — the receipt-344 post-swipe hang). Split, each branch rides its own index
    // (idx_price_receiptitem / idx_price_receipt_sp); same rows affected.
    await pool.query(
        `UPDATE Price SET priceVerified = 0
          WHERE isFallback = 0
            AND receiptItemId IN (SELECT id FROM ReceiptItem WHERE receiptId = ? AND matchedSpId = ?)`,
        [receiptId, storeProductId]
    );
    await pool.query(
        `UPDATE Price SET priceVerified = 0
          WHERE isFallback = 0
            AND receiptItemId IS NULL AND receiptId = ? AND storeProductId = ?`,
        [receiptId, storeProductId]
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
    // Same OR-defeats-indexes trap as unverifyReceiptLinePrice above — split so each
    // branch uses its index instead of a locking full-table scan on Price.
    await db.query(
        `UPDATE Price SET priceVerified = ?
          WHERE isFallback = 0
            AND receiptItemId IN (SELECT id FROM ReceiptItem WHERE receiptId = ? AND matchedSpId = ?)`,
        [verified ? 1 : 0, receiptId, storeProductId]
    );
    await db.query(
        `UPDATE Price SET priceVerified = ?
          WHERE isFallback = 0
            AND receiptItemId IS NULL AND receiptId = ? AND storeProductId = ?`,
        [verified ? 1 : 0, receiptId, storeProductId]
    );
};
