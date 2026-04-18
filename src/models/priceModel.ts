import pool from '../config/db';

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
// For fallback price
export const updateFallbackPrice = async (id: number, price: number, promoPrice: number | null, date: Date) => {
    await pool.query(
        'UPDATE Price SET price = ?, promoPrice = ?, date = ? WHERE id = ?',
        [price, promoPrice, date, id]
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