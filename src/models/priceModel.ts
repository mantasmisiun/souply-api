import pool from '../config/db.js';

type Connection = typeof pool | any;

export const createPrice = async (
    storeProductId: number,
    storeId: number,
    price: number,
    promoPrice: number | null,
    promoEnd: Date | null,
    isFallback: boolean,
    date: Date,
    priceVerified: boolean,
    receiptId: number | null,
    conn?: Connection
) => {
    const db = conn || pool;
    // Price has UNIQUE (storeProductId, storeId, date). Collisions happen
    // when the same (SP, store, timestamp) key already exists — e.g. a
    // previous receipt upload left an orphaned row, or a scraped fallback
    // row shares the exact date. The right semantic is "most recent
    // observation wins": overwrite the row in place with the new values
    // (which may reassign receiptId from NULL to this receipt, or flip
    // isFallback=1 → 0 when a real receipt supersedes a scrape).
    const [result]: any = await db.query(
        `INSERT INTO Price
           (storeProductId, storeId, receiptId, price, promoPrice, promoEnd,
            isFallback, date, priceVerified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           receiptId     = VALUES(receiptId),
           price         = VALUES(price),
           promoPrice    = VALUES(promoPrice),
           promoEnd      = VALUES(promoEnd),
           isFallback    = VALUES(isFallback),
           priceVerified = VALUES(priceVerified)`,
        [storeProductId, storeId, receiptId, price, promoPrice, promoEnd, isFallback, date, priceVerified]
    );
    return result.insertId;
};

export const getLatestPriceByStoreProduct = async (storeProductId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM Price WHERE storeProductId = ? ORDER BY date DESC LIMIT 1',
        [storeProductId]
    );
    return rows[0] || null;
};

export const getPriceHistoryForStoreProduct = async (storeProductId: number, storeId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM Price WHERE storeProductId = ? AND storeId = ? ORDER BY date DESC',
        [storeProductId, storeId]
    );
    return rows;
};

export const getLatestPricesAcrossStores = async (productId: number) => {
    const [rows]: any = await pool.query(
        `SELECT p.*, sp.chainId, sp.storeProductName,
                s.name AS storeName, s.address,
                sc.name AS chainName, sc.logoUrl
         FROM Price p
         JOIN StoreProduct sp ON p.storeProductId = sp.id
         JOIN Store s ON p.storeId = s.id
         JOIN StoreChain sc ON sp.chainId = sc.id
         WHERE sp.productId = ?
         AND p.id = (
             SELECT MAX(p2.id)
             FROM Price p2
             WHERE p2.storeProductId = p.storeProductId
             AND p2.storeId = p.storeId
         )
         ORDER BY p.price ASC`,
        [productId]
    );
    return rows.map((row: any) => ({
        ...row,
        price: parseFloat(row.price),
        promoPrice: row.promoPrice ? parseFloat(row.promoPrice) : null,
        isFallback: row.isFallback === 1,
        priceVerified: row.priceVerified === 1
    }));
};

export const getActivePromoPrices = async () => {
    const [rows]: any = await pool.query(
        `SELECT p.*, sp.chainId, sp.storeProductName,
                s.name AS storeName,
                sc.name AS chainName, sc.logoUrl
         FROM Price p
         JOIN StoreProduct sp ON p.storeProductId = sp.id
         JOIN Store s ON p.storeId = s.id
         JOIN StoreChain sc ON sp.chainId = sc.id
         WHERE p.promoPrice IS NOT NULL AND (p.promoEnd > NOW() OR p.promoEnd IS NULL)
         ORDER BY p.date DESC`
    );
    return rows.map((row: any) => ({
        ...row,
        price: parseFloat(row.price),
        promoPrice: row.promoPrice ? parseFloat(row.promoPrice) : null,
        isFallback: row.isFallback === 1,
        priceVerified: row.priceVerified === 1
    }));
};

export const updatePriceById = async (id: number, price: number, promoPrice: number | null) => {
    await pool.query(
        'UPDATE Price SET price = ?, promoPrice = ? WHERE id = ?',
        [price, promoPrice, id]
    );
};

//For fallback price
export const getPriceByStoreProductAndStore = async (storeProductId: number, storeId: number) => {
    const [rows]: any = await pool.query(
        `SELECT * FROM Price WHERE storeProductId = ? AND storeId = ? 
         ORDER BY date DESC LIMIT 1`,
        [storeProductId, storeId]
    );
    return rows[0] || null;
};
// For fallback price. Refresh price/promo/date and re-link to the source receipt,
// always keeping priceVerified=0 since a fallback is never a user-verified row.
export const updateFallbackPrice = async (
    id: number,
    price: number,
    promoPrice: number | null,
    date: Date,
    receiptId: number | null
) => {
    await pool.query(
        'UPDATE Price SET price = ?, promoPrice = ?, date = ?, receiptId = ?, priceVerified = 0 WHERE id = ?',
        [price, promoPrice, date, receiptId, id]
    );
};

export const getPriceHistoryForStoreProductAllStores = async (storeProductId: number) => {
    // Prefer real-receipt history (isFallback=0). When the StoreProduct
    // has never had a verified observation (everything is scraped
    // fallback), fall back to those so the chart isn't empty.
    //
    // DEDUP NOTE: scrape fanout creates one identical Price row per store
    // in the chain (same date, price, promoPrice — differing only in
    // storeId). For the "all stores" timeline we want ONE point per
    // distinct (date, price, promoPrice, isFallback) tuple. Per-store
    // variation on the same date (rare — stores mostly track chain price)
    // still surfaces as separate points because the tuple differs.
    const [rows]: any = await pool.query(
        `SELECT MIN(p.id) AS id,
                p.storeProductId,
                p.date,
                CAST(p.price AS DECIMAL(10,4))      AS price,
                CAST(p.promoPrice AS DECIMAL(10,4)) AS promoPrice,
                p.isFallback,
                p.priceVerified
           FROM Price p
          WHERE p.storeProductId = ?
          GROUP BY p.date, p.price, p.promoPrice, p.isFallback, p.priceVerified, p.storeProductId
          ORDER BY p.date ASC`,
        [storeProductId]
    );
    const nonFallback = rows.filter((r: any) => r.isFallback !== 1);
    return nonFallback.length > 0 ? nonFallback : rows;
};

/**
 * Average of the last N verified, non-fallback prices for a (storeProduct, store) pair.
 * Returns null if fewer than 2 baseline prices exist — not enough data to judge clearance.
 */
export const getBaselinePriceAverage = async (
    storeProductId: number,
    storeId: number,
    windowSize: number = 5,
    conn?: Connection
): Promise<number | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT price FROM Price
         WHERE storeProductId = ? AND storeId = ? AND priceVerified = 1 AND isFallback = 0
         ORDER BY date DESC LIMIT ?`,
        [storeProductId, storeId, windowSize]
    );
    if (rows.length < 2) return null;
    const sum = rows.reduce((acc: number, r: any) => acc + parseFloat(r.price), 0);
    return sum / rows.length;
};

/**
 * Fetch the most recent Price row for a (storeProduct, store, receipt) triple.
 * Used to dedupe no-op saves when a user edits a receipt without changing values.
 */
export const getLatestPriceForReceiptItem = async (
    storeProductId: number,
    storeId: number,
    receiptId: number,
    conn?: Connection
) => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT price, promoPrice FROM Price
         WHERE storeProductId = ? AND storeId = ? AND receiptId = ?
         ORDER BY date DESC LIMIT 1`,
        [storeProductId, storeId, receiptId]
    );
    return rows[0] || null;
};

/**
 * Batch version of getBaselinePriceAverage — single query for all items.
 * Returns a Map from storeProductId to baseline average (or null if < 2 data points).
 */
export const batchGetBaselinePriceAverages = async (
    storeProductIds: number[],
    storeId: number,
    windowSize: number = 5,
    conn?: Connection
): Promise<Map<number, number | null>> => {
    const db = conn || pool;
    const result = new Map<number, number | null>();
    if (storeProductIds.length === 0) return result;

    const [rows]: any = await db.query(
        `SELECT storeProductId, price
           FROM (
               SELECT storeProductId, price,
                      ROW_NUMBER() OVER (PARTITION BY storeProductId ORDER BY date DESC) AS rn
                 FROM Price
                WHERE storeProductId IN (?) AND storeId = ? AND priceVerified = 1 AND isFallback = 0
           ) ranked
          WHERE rn <= ?`,
        [storeProductIds, storeId, windowSize]
    );

    const grouped = new Map<number, number[]>();
    for (const row of rows) {
        const spId = Number(row.storeProductId);
        if (!grouped.has(spId)) grouped.set(spId, []);
        grouped.get(spId)!.push(parseFloat(row.price));
    }
    for (const [spId, prices] of grouped) {
        result.set(spId, prices.length >= 2 ? prices.reduce((a, b) => a + b, 0) / prices.length : null);
    }
    return result;
};

/**
 * Batch version of getLatestPriceForReceiptItem — single query for all items.
 * Returns a Map from storeProductId to {price, promoPrice} (or null if no row).
 */
export const batchGetLatestPricesForReceiptItems = async (
    storeProductIds: number[],
    storeId: number,
    receiptId: number,
    conn?: Connection
): Promise<Map<number, { price: string; promoPrice: string | null } | null>> => {
    const db = conn || pool;
    const result = new Map<number, { price: string; promoPrice: string | null } | null>();
    if (storeProductIds.length === 0) return result;

    const [rows]: any = await db.query(
        `SELECT storeProductId, price, promoPrice
           FROM (
               SELECT storeProductId, price, promoPrice,
                      ROW_NUMBER() OVER (PARTITION BY storeProductId ORDER BY date DESC) AS rn
                 FROM Price
                WHERE storeProductId IN (?) AND storeId = ? AND receiptId = ?
           ) ranked
          WHERE rn = 1`,
        [storeProductIds, storeId, receiptId]
    );

    for (const row of rows) {
        result.set(Number(row.storeProductId), { price: row.price, promoPrice: row.promoPrice ?? null });
    }
    return result;
};