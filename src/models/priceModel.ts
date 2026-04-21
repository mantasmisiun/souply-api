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
    const [result]: any = await db.query(
        'INSERT INTO Price (storeProductId, storeId, receiptId, price, promoPrice, promoEnd, isFallback, date, priceVerified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    const [rows]: any = await pool.query(
        `SELECT p.*, s.name as storeName
         FROM Price p
         JOIN Store s ON p.storeId = s.id
         WHERE p.storeProductId = ?
         AND p.isFallback = 0
         ORDER BY p.date ASC`,
        [storeProductId]
    );
    return rows;
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