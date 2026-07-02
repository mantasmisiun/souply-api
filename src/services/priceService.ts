import pool from '../config/db.js';
import { getStoresByChainId } from '../models/storeModel.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

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
    receiptId: number | null,
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
        `SELECT id, storeProductId, storeId, isFallback, date
         FROM Price
         WHERE storeProductId IN (?) AND storeId IN (?)`,
        [spIds, targetStoreIds],
    );

    // Index existing rows by "spId:storeId". The UNIQUE key is (sp, store, DATE), so multiple
    // rows can exist per (sp, store) at different dates. PREFER the row already at receiptDate:
    // the batch UPDATE below sets date=receiptDate, so choosing an OTHER-dated row would MOVE it
    // onto receiptDate and collide with the row already there (ER_DUP_ENTRY unique_price — hit
    // when the same receipt is re-processed at the same date, e.g. the DEV Re-OCR tool). Updating
    // the at-date row in place is a no-op on the date and can't collide.
    const receiptDateMs = receiptDate instanceof Date ? receiptDate.getTime() : new Date(receiptDate).getTime();
    const existingMap = new Map<string, { id: number; isFallback: number; atDate: boolean; dateMs: number }>();
    for (const row of existingRows) {
        const key = `${Number(row.storeProductId)}:${Number(row.storeId)}`;
        const rowMs0 = row.date instanceof Date ? row.date.getTime() : new Date(row.date).getTime();
        // A missing/unparseable date counts as epoch-old — it must never BLOCK an update.
        const rowMs = Number.isFinite(rowMs0) ? rowMs0 : -Infinity;
        const atDate = rowMs === receiptDateMs;
        const prev = existingMap.get(key);
        // Take the row at receiptDate when present; otherwise keep the NEWEST row so the
        // recency guard below compares against the freshest data for this (sp, store).
        if (!prev || (atDate && !prev.atDate) || (!prev.atDate && rowMs > prev.dateMs)) {
            existingMap.set(key, { id: Number(row.id), isFallback: Number(row.isFallback), atDate, dateMs: rowMs });
        }
    }

    // Receipt-observed promos expire: promoEnd = receiptDate + validity window (promoEnd
    // NULL reads as an ETERNAL promo in getActivePromoPrices).
    const promoEnd = new Date(receiptDateMs + RECOGNITION.price.receiptPromoValidityDays * 24 * 60 * 60 * 1000);

    // Classify each planned (spId, storeId) pair.
    const updateRows: { id: number; price: number; promoPrice: number | null }[] = [];
    const insertRows: [number, number, number, number | null, Date | null, Date, 1, 0, number | null][] = [];

    for (const spId of spIds) {
        const p = priceBySpId.get(spId)!;
        const pPromoEnd = p.promoPrice != null ? promoEnd : null;
        for (const storeId of targetStoreIds) {
            const key = `${spId}:${storeId}`;
            const existing = existingMap.get(key);
            if (!existing) {
                // [storeProductId, storeId, price, promoPrice, promoEnd, date, isFallback, priceVerified, receiptId]
                insertRows.push([spId, storeId, p.price, p.promoPrice, pPromoEnd, receiptDate, 1, 0, receiptId]);
            } else if (existing.isFallback === 1 && existing.dateMs <= receiptDateMs) {
                // RECENCY GUARD: an OLDER receipt must never regress a NEWER fallback
                // observation (nor move its date backwards) — skip stale updates.
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
                    promoEnd   = CASE WHEN CASE id ${promoPriceCase} END IS NULL THEN NULL ELSE ? END,
                    date       = ?,
                    receiptId  = ?,
                    priceVerified = 0
              WHERE id IN (?)`,
            [promoEnd, receiptDate, receiptId, ids],
        );
    }

    // Query 3b: multi-row INSERT for stores that had no Price row at all.
    // ON DUPLICATE KEY UPDATE handles the rare race where another process
    // inserted a row between our SELECT and this INSERT.
    if (insertRows.length > 0) {
        await pool.query(
            `INSERT INTO Price
               (storeProductId, storeId, price, promoPrice, promoEnd, date, isFallback, priceVerified, receiptId)
             VALUES ?
             ON DUPLICATE KEY UPDATE
               price         = VALUES(price),
               promoPrice    = VALUES(promoPrice),
               promoEnd      = VALUES(promoEnd),
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
        // null passes through — coercing to 0 violated the Price→Receipt FK and broke
        // the manual-price fan-out.
        receiptId,
    );
};
