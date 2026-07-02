import pool from '../config/db.js';
import { deleteReceiptImage } from './storageService.js';
import { resetReceiptLearning, type ReceiptLearningResetResult } from './receiptLearningResetService.js';

export interface ReceiptDeletionResult {
    deleted: boolean;
    prices: number;
    storeProducts: number;
    products: number;
    imageDeleted: boolean;
    learning: ReceiptLearningResetResult;
}

const EMPTY_LEARNING: ReceiptLearningResetResult = {
    aliasVotesDeleted: 0,
    aliasesDeleted: 0,
    matchVotesDeleted: 0,
    equivalencesDeleted: 0,
};

/**
 * DEV-ONLY hard delete of a single receipt and everything it spawned.
 *
 * Mirrors the batch cleanup script (scripts/receiptBatch/cleanupTestReceipts.ts)
 * but scoped to ONE receipt id. Two phases:
 *
 *   A. Essential transaction (atomic, must succeed):
 *      1. Price rows for this receipt
 *      2. Swipe data (ReceiptSwipeCandidate) + line issues (ReceiptLineIssue),
 *         deleted explicitly so the wipe is guaranteed regardless of FK rules
 *      3. Receipt row
 *   B. Best-effort orphan-catalog cleanup (NON-fatal, after commit):
 *      4. Orphan StoreProducts — touched by this receipt's prices, now priceless
 *         (SPs that still have scraped prices are kept).
 *      5. Orphan Products — zero StoreProducts AND not used as another Product's
 *         baseProductId (self-FK is RESTRICT).
 *      6. The MinIO receipt image.
 *      Phase B touches shared rows that may be referenced elsewhere; its
 *      failures are swallowed so they can never roll back phase A.
 *
 * This intentionally removes shared price/SP data the receipt created, which is
 * why it's gated to non-production only — it's a test-data reset, not a
 * user-facing "hide my receipt".
 */
export const deleteReceiptWithData = async (
    receiptId: number,
): Promise<ReceiptDeletionResult> => {
    const [receiptRows]: any = await pool.query(
        `SELECT id, filePath FROM Receipt WHERE id = ? LIMIT 1`,
        [receiptId],
    );
    const receipt = receiptRows[0];
    if (!receipt) {
        return { deleted: false, prices: 0, storeProducts: 0, products: 0, imageDeleted: false, learning: EMPTY_LEARNING };
    }

    // StoreProducts (+ their Products) this receipt's prices touch — captured
    // BEFORE we delete the prices so we can find which ones go orphan after.
    const [touched]: any = await pool.query(
        `SELECT DISTINCT sp.id AS spId, sp.productId
           FROM StoreProduct sp
           JOIN Price pr ON pr.storeProductId = sp.id
          WHERE pr.receiptId = ?`,
        [receiptId],
    );
    const spIds: number[] = touched.map((r: any) => r.spId);
    const productIds: number[] = Array.from(new Set(touched.map((r: any) => r.productId)));

    const conn = await (pool as any).getConnection();
    let prices = 0;
    let storeProducts = 0;
    let products = 0;
    let learning: ReceiptLearningResetResult = EMPTY_LEARNING;

    // ── Essential, atomic part: the receipt + everything keyed to it ──────────
    // Keep ONLY the receipt's own rows in the transaction so the delete is
    // guaranteed. Orphan-catalog cleanup (below) touches shared rows that may be
    // referenced elsewhere — it must never be able to roll this back.
    try {
        await conn.beginTransaction();

        const [priceDel]: any = await conn.query(
            `DELETE FROM Price WHERE receiptId = ?`,
            [receiptId],
        );
        prices = priceDel.affectedRows;

        // Swipe data is receipt-scoped — wipe it explicitly rather than relying
        // on the Receipt FK cascade, so the guarantee holds even if the cascade
        // rule ever changes (and so a non-cascading FK can't block the delete).
        await conn.query(`DELETE FROM ReceiptSwipeCandidate WHERE receiptId = ?`, [receiptId]);
        await conn.query(`DELETE FROM ReceiptLineIssue WHERE receiptId = ?`, [receiptId]);

        // Clean-slate the receipt's LEARNING side effects (vocabulary aliases/votes, cross-
        // chain match votes + aggregates, personal equivalences) so re-uploading the same
        // receipt tests fresh. MUST run BEFORE deleting the Receipt row — the match-vote FK is
        // ON DELETE SET NULL, so after the row is gone the receiptId link (used to find them)
        // would be lost. Part of the atomic phase so a clean slate is guaranteed or nothing is.
        learning = await resetReceiptLearning(receiptId, conn);

        await conn.query(`DELETE FROM Receipt WHERE id = ?`, [receiptId]);

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    // ── Best-effort orphan-catalog cleanup (NON-fatal, after commit) ──────────
    // These delete shared StoreProduct/Product rows the receipt created that are
    // now priceless. They can hit FK constraints (e.g. Product.baseProductId
    // self-reference, ProductInteraction, …) when a row is still used elsewhere
    // — a leftover priceless row is harmless, so we swallow failures rather than
    // undo the receipt deletion above.
    if (spIds.length > 0) {
        try {
            // Only SPs left with ZERO prices. Scraped catalog SPs keep their
            // scrape-sourced Price rows (we removed only THIS receipt's prices),
            // so the NOT EXISTS guard protects them.
            const [spDel]: any = await pool.query(
                `DELETE sp FROM StoreProduct sp
                  WHERE sp.id IN (?)
                    AND NOT EXISTS (SELECT 1 FROM Price pr WHERE pr.storeProductId = sp.id)`,
                [spIds],
            );
            storeProducts = spDel.affectedRows;
        } catch (e: any) {
            console.warn(`[receiptDeletion] orphan StoreProduct cleanup skipped: ${e.message}`);
        }
    }

    if (productIds.length > 0) {
        try {
            // Only Products with zero StoreProducts AND not referenced as the
            // base of another Product (baseProductId self-FK is RESTRICT).
            const [pDel]: any = await pool.query(
                `DELETE p FROM Product p
                  WHERE p.id IN (?)
                    AND NOT EXISTS (SELECT 1 FROM StoreProduct sp WHERE sp.productId = p.id)
                    AND NOT EXISTS (SELECT 1 FROM Product child WHERE child.baseProductId = p.id)`,
                [productIds],
            );
            products = pDel.affectedRows;
        } catch (e: any) {
            console.warn(`[receiptDeletion] orphan Product cleanup skipped: ${e.message}`);
        }
    }

    // MinIO is not transactional — do it last. A stranded object is a lesser
    // problem than a half-rolled-back DB, and a missing object is harmless.
    let imageDeleted = false;
    try {
        await deleteReceiptImage(receipt.filePath);
        imageDeleted = true;
    } catch (err) {
        console.error(`[receiptDeletion] MinIO delete failed for receipt ${receiptId}:`, err);
    }

    console.log(
        `[receiptDeletion] receipt ${receiptId} purged: ${prices} prices, ` +
        `${storeProducts} orphan SPs, ${products} orphan products, image=${imageDeleted} | ` +
        `learning reset: ${learning.aliasVotesDeleted} alias-votes (${learning.aliasesDeleted} aliases GC'd), ` +
        `${learning.matchVotesDeleted} match-votes, ${learning.equivalencesDeleted} equivalences`,
    );
    return { deleted: true, prices, storeProducts, products, imageDeleted, learning };
};
