import pool from '../config/db.js';
import { getStoresByChainId } from '../models/storeModel.js';

export interface PropagateItem {
    storeProductId: number;
    storeId: number; // source store — excluded from propagation targets
    chainId: number;
    price: number;
    promoPrice: number | null;
    date: Date;
}

/**
 * Propagate fallback prices for ALL items in a receipt with 3 DB round-trips
 * regardless of how many products or stores are involved.
 *
 * Previous approach ran one propagateFallbackPrices() per product in parallel,
 * producing ~N × M individual INSERTs (e.g. 20 products × 239 Maxima stores =
 * 4,780 concurrent queries). This exhausted the connection pool and blocked the
 * swipe-queue query for 10–30 s after receipt save.
 *
 * New approach:
 *   Query 1 — fetch all chain stores (reused from model cache-friendly getter)
 *   Query 2 — one SELECT to find all existing Price rows for every
 *              (storeProductId, targetStoreId) pair we care about
 *   Query 3a — one batch UPDATE with CASE WHEN for existing fallback rows
 *   Query 3b — one multi-row INSERT … ON DUPLICATE KEY UPDATE for new rows
 *
 * All items must share the same chainId (guaranteed for a single receipt).
 */
export const propagateAllFallbackPrices = async (
    items: PropagateItem[],
    receiptId: number,
): Promise<void> => {
    if (!items.length) return;

    // All items share the same source store / chain (single receipt).
    const chainId = items[0].chainId;
    const sourceStoreId = items[0].storeId;
    const receiptDate = items[0].date; // same writeDate for all items

    // Query 1: target stores for this chain.
    const allStores = await getStoresByChainId(chainId);
    const targetStores = allStores.filter((s: any) => Number(s.id) !== sourceStoreId);
    if (!targetStores.length) return;

    const targetStoreIds = targetStores.map((s: any) => Number(s.id));
    const spIds = items.map(i => i.storeProductId);

    // Build price lookup: spId → { price, promoPrice }
    const priceBySpId = new Map<number, { price: number; promoPrice: number | null }>();
    for (const item of items) {
        priceBySpId.set(item.storeProductId, { price: item.price, promoPrice: item.promoPrice });
    }

    // Query 2: find all existing Price rows for (any of our SPs, any target store).
    // Returns only rows that actually exist — no cross-product explosion.
    const [existingRows]: any = await pool.query(
        `SELECT id, storeProductId, storeId, isFallback
         FROM Price
         WHERE storeProductId IN (?) AND storeId IN (?)`,
        [spIds, targetStoreIds],
    );

    // Index existing rows by "spId:storeId" for O(1) lookup.
    const existingMap = new Map<string, { id: number; isFallback: number }>();
    for (const row of existingRows) {
        const key = `${Number(row.storeProductId)}:${Number(row.storeId)}`;
        // Keep the first occurrence — there should only be one per (sp, store)
        // for fallback rows, but UNIQUE is on (sp, store, date) so multiple
        // can exist with different dates. We update the first fallback found.
        if (!existingMap.has(key)) {
            existingMap.set(key, { id: Number(row.id), isFallback: Number(row.isFallback) });
        }
    }

    // Classify each planned (spId, storeId) pair.
    const updateRows: { id: number; price: number; promoPrice: number | null }[] = [];
    const insertRows: [number, number, number, number | null, Date, 1, 0, number][] = [];

    for (const spId of spIds) {
        const p = priceBySpId.get(spId)!;
        for (const storeId of targetStoreIds) {
            const key = `${spId}:${storeId}`;
            const existing = existingMap.get(key);
            if (!existing) {
                // [storeProductId, storeId, price, promoPrice, date, isFallback, priceVerified, receiptId]
                insertRows.push([spId, storeId, p.price, p.promoPrice, receiptDate, 1, 0, receiptId]);
            } else if (existing.isFallback === 1) {
                updateRows.push({ id: existing.id, price: p.price, promoPrice: p.promoPrice });
            }
            // isFallback === 0 → real receipt price, do not overwrite
        }
    }

    // Query 3a: batch UPDATE existing fallback rows.
    // Prices differ per row, so build a CASE WHEN expression.
    if (updateRows.length > 0) {
        const ids = updateRows.map(u => u.id);
        const priceCase = updateRows.map(u => `WHEN ${u.id} THEN ${pool.escape(u.price)}`).join(' ');
        const promoPriceCase = updateRows.map(u => `WHEN ${u.id} THEN ${pool.escape(u.promoPrice)}`).join(' ');
        await pool.query(
            `UPDATE Price
                SET price      = CASE id ${priceCase} END,
                    promoPrice = CASE id ${promoPriceCase} END,
                    date       = ?,
                    receiptId  = ?,
                    priceVerified = 0
              WHERE id IN (?)`,
            [receiptDate, receiptId, ids],
        );
    }

    // Query 3b: multi-row INSERT for stores that had no Price row at all.
    // ON DUPLICATE KEY UPDATE handles the rare race where another process
    // inserted a row between our SELECT and this INSERT.
    if (insertRows.length > 0) {
        await pool.query(
            `INSERT INTO Price
               (storeProductId, storeId, price, promoPrice, date, isFallback, priceVerified, receiptId)
             VALUES ?
             ON DUPLICATE KEY UPDATE
               price         = VALUES(price),
               promoPrice    = VALUES(promoPrice),
               isFallback    = VALUES(isFallback),
               priceVerified = VALUES(priceVerified),
               receiptId     = VALUES(receiptId)`,
            [insertRows],
        );
    }
};

/**
 * @deprecated Use propagateAllFallbackPrices for batched receipt propagation.
 * Kept for any call sites outside the receipt save flow.
 */
export const propagateFallbackPrices = async (
    storeProductId: number,
    sourceStoreId: number,
    chainId: number,
    price: number,
    promoPrice: number | null,
    date: Date,
    receiptId: number | null = null,
): Promise<void> => {
    await propagateAllFallbackPrices(
        [{ storeProductId, storeId: sourceStoreId, chainId, price, promoPrice, date }],
        receiptId ?? 0,
    );
};
