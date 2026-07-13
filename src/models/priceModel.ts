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
    requiresCoupon: boolean = false,
    conn?: Connection,
    // The exact ReceiptItem this price came from (ReceiptItem migration) — makes a
    // receipt-derived price trivially removable / re-assignable when a line's match changes.
    // Null for scraped / fallback prices. Optional + last so existing callers are unaffected.
    receiptItemId: number | null = null,
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
           (storeProductId, storeId, receiptId, receiptItemId, price, promoPrice, promoEnd,
            isFallback, date, priceVerified, requiresCoupon)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           receiptId      = COALESCE(Price.receiptId, VALUES(receiptId)),
           receiptItemId  = COALESCE(Price.receiptItemId, VALUES(receiptItemId)),
           price          = VALUES(price),
           promoPrice     = VALUES(promoPrice),
           promoEnd       = VALUES(promoEnd),
           isFallback     = VALUES(isFallback),
           priceVerified  = VALUES(priceVerified),
           requiresCoupon = VALUES(requiresCoupon)`,
        [storeProductId, storeId, receiptId, receiptItemId, price, promoPrice, promoEnd, isFallback, date, priceVerified, requiresCoupon]
    );
    return result.insertId;
};

/**
 * Locate a receipt LINE's own primary Price row. Prefers the precise
 * `receiptItemId` link (ReceiptItem migration); falls back to the legacy
 * (receiptId, storeProductId) key ONLY for rows written before the column
 * existed (receiptItemId IS NULL — e.g. backfilled receipts). Keying by the
 * line id makes the lookup immune to (sp, store, date) slot-ownership: a row
 * belonging to ANOTHER receipt's line is never returned.
 */
export const findLinePrimaryPrice = async (
    receiptItemId: number | null,
    receiptId: number,
    storeProductId: number,
    conn?: Connection,
): Promise<{ id: number; priceVerified: number } | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT id, priceVerified FROM Price
          WHERE isFallback = 0
            AND (receiptItemId = ?
                 OR (receiptItemId IS NULL AND receiptId = ? AND storeProductId = ?))
          ORDER BY (receiptItemId = ?) DESC
          LIMIT 1`,
        [receiptItemId, receiptId, storeProductId, receiptItemId],
    );
    return rows[0] ?? null;
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
export const extendPromoEnd = async (id: number, newEnd: Date): Promise<void> => {
    await pool.query('UPDATE Price SET promoEnd = ? WHERE id = ?', [newEnd, id]);
};

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
                p.promoEnd,
                p.isFallback,
                p.priceVerified
           FROM Price p
          WHERE p.storeProductId = ?
          GROUP BY p.date, p.price, p.promoPrice, p.promoEnd, p.isFallback, p.priceVerified, p.storeProductId
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

/**
 * Round-2 price-confirmation lookup. For a set of CANDIDATE storeProductIds,
 * returns the single most-relevant price observation AS OF `asOfDate`,
 * CHAIN-WIDE (storeProductId is already chain-specific; the `sp.chainId = ?`
 * join drops cross-chain candidates — those have no comparable price for this
 * receipt). Prefers a scraped row (isFallback=0) over a receipt-fallback row,
 * then the latest date on/before asOfDate. Excludes THIS receipt's own rows so
 * a receipt can never price-confirm against itself (no self-confirmation).
 *
 * NB: prices are WEEKLY scrape snapshots, so `date <= asOfDate` is accurate to
 * ~a week — this powers a CONFIRMER/tiebreaker, never a gate (caller fail-opens).
 *
 * Returns a Map storeProductId → { price, promoPrice, promoEnd } (numbers; the
 * DECIMAL columns come back as strings from mysql2 and are parsed here).
 */
export const getAsOfDatePricesForCandidates = async (
    storeProductIds: number[],
    chainId: number,
    asOfDate: Date,
    excludeReceiptId: number,
    conn?: Connection
): Promise<Map<number, { price: number; promoPrice: number | null; promoEnd: Date | null }>> => {
    const db = conn || pool;
    const result = new Map<number, { price: number; promoPrice: number | null; promoEnd: Date | null }>();
    if (storeProductIds.length === 0) return result;

    // ORDER BY isFallback ASC, date DESC → a scraped row wins over any fallback
    // row; within scraped (or within fallback when no scrape exists) the latest
    // date on/before asOfDate wins. One row per candidate (rn = 1).
    const [rows]: any = await db.query(
        `SELECT storeProductId, price, promoPrice, promoEnd
           FROM (
               SELECT p.storeProductId, p.price, p.promoPrice, p.promoEnd,
                      ROW_NUMBER() OVER (
                          PARTITION BY p.storeProductId
                          ORDER BY p.isFallback ASC, p.date DESC
                      ) AS rn
                 FROM Price p
                 JOIN StoreProduct sp ON sp.id = p.storeProductId
                WHERE p.storeProductId IN (?)
                  AND sp.chainId = ?
                  AND (p.receiptId IS NULL OR p.receiptId <> ?)
                  AND p.date <= ?
           ) ranked
          WHERE rn = 1`,
        [storeProductIds, chainId, excludeReceiptId, asOfDate]
    );

    for (const row of rows) {
        result.set(Number(row.storeProductId), {
            price: parseFloat(row.price),
            promoPrice: row.promoPrice === null || row.promoPrice === undefined ? null : parseFloat(row.promoPrice),
            promoEnd: row.promoEnd ? new Date(row.promoEnd) : null,
        });
    }
    return result;
};
/**
 * Round-2.5 RESCUE FISHING pool: same-chain SPs whose REGULAR price matches the
 * receipt line's printed regular within tolerance, in a ±window around the
 * receipt date (BOTH directions — scrapes are weekly and SPs get minted/renamed
 * continuously, so a just-minted SP's first price row may postdate an older
 * receipt; the regular price is a stable identity anchor either way, unlike
 * promos which churn weekly). Excludes this receipt's own rows and any SP ids
 * the caller already has (Round-1 altMatches). Carries the same category/name
 * fields the Round-1 candidates carry so a fished entry can sit in altMatches
 * verbatim. Capped — an ultra-common price point (e.g. 0.99) must not flood the
 * relaxed re-scoring downstream.
 */
export const getChainSpsByRegularPrice = async (
    chainId: number,
    regular: number,
    tolerance: number,
    aroundDate: Date,
    windowDays: number,
    excludeReceiptId: number,
    excludeSpIds: number[],
    limit: number,
    // When the receipt line visibly paid a DISCOUNT, only rows that carry a promo
    // qualify as anchors — the discount is real-world evidence the product was on
    // promotion, and at a common price point (16.99: books, gin, toys…) it narrows
    // the pool by an order of magnitude.
    requirePromo = false,
    conn?: Connection,
): Promise<Array<{
    storeProductId: number; productId: number; categoryId: number | null;
    categoryName: string | null; categoryL2Name: string | null; name: string;
    brandName: string | null; amount: number | null; unit: string | null;
    isWeighable: boolean; isCatalog: boolean; imageUrl: string | null;
}>> => {
    const db = conn || pool;
    const lo = new Date(aroundDate.getTime() - windowDays * 86400_000);
    const hi = new Date(aroundDate.getTime() + windowDays * 86400_000);
    const excl = excludeSpIds.length ? excludeSpIds : [0];
    // Inner pick: one row per SP with its closest price distance, CLOSEST-first so the
    // LIMIT keeps the best anchors when a price point is common (no arbitrary truncation).
    const [rows]: any = await db.query(
        `SELECT sp.id AS storeProductId, sp.productId, sp.storeProductName AS name,
                sp.brandName, sp.amount, sp.unit, sp.isWeighable, sp.imageUrl,
                p.categoryId, c.name AS categoryName,
                CASE
                  WHEN c.parentCategoryId IS NULL  THEN NULL
                  WHEN c2.parentCategoryId IS NULL THEN c.name
                  ELSE c2.name
                END AS categoryL2Name,
                EXISTS(SELECT 1 FROM Price pr2 WHERE pr2.storeProductId = sp.id AND pr2.receiptId IS NULL) AS isCatalog,
                picked.priceDist
           FROM (
                SELECT pr.storeProductId AS spId, MIN(ABS(pr.price - ?)) AS priceDist
                  FROM Price pr USE INDEX (idx_price_value)
                  JOIN StoreProduct spf ON spf.id = pr.storeProductId
                 WHERE spf.chainId = ?
                   AND pr.price BETWEEN ? AND ?
                   AND pr.date BETWEEN ? AND ?
                   AND (pr.receiptId IS NULL OR pr.receiptId <> ?)
                   AND pr.storeProductId NOT IN (?)
                   AND (? = 0 OR pr.promoPrice IS NOT NULL)
                 GROUP BY pr.storeProductId
                 ORDER BY priceDist ASC, pr.storeProductId ASC
                 LIMIT ?
           ) picked
           JOIN StoreProduct sp ON sp.id = picked.spId
           JOIN Product p ON p.id = sp.productId
           LEFT JOIN Category c  ON c.id = p.categoryId
           LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
          ORDER BY picked.priceDist ASC, sp.id ASC`,
        [regular, chainId, regular - tolerance, regular + tolerance, lo, hi, excludeReceiptId, excl, requirePromo ? 1 : 0, limit],
    );
    return rows.map((r: any) => ({
        storeProductId: Number(r.storeProductId),
        productId: Number(r.productId),
        categoryId: r.categoryId != null ? Number(r.categoryId) : null,
        categoryName: r.categoryName ?? null,
        categoryL2Name: r.categoryL2Name ?? null,
        name: String(r.name),
        brandName: r.brandName ?? null,
        amount: r.amount !== null ? parseFloat(r.amount) : null,
        unit: r.unit ?? null,
        isWeighable: !!r.isWeighable,
        isCatalog: !!r.isCatalog,
        imageUrl: r.imageUrl ?? null,
    }));
};

/**
 * Bounded count of Price rows in a value+date range (the Round-2.5 fishing anchor).
 * Costs ~30-90ms as a pure index-range count capped at `cap`+1 — the caller skips
 * fishing entirely when the anchor is NON-SELECTIVE (a super-common price point like
 * 1.99 matches 500k+ rows: the unhinted pool query measured 12s there and, more to
 * the point, a price everyone shares carries no identity signal to fish on).
 */
export const countPriceRowsNearValue = async (
    regular: number,
    tolerance: number,
    aroundDate: Date,
    windowDays: number,
    cap: number,
    conn?: Connection,
): Promise<number> => {
    const db = conn || pool;
    const lo = new Date(aroundDate.getTime() - windowDays * 86400_000);
    const hi = new Date(aroundDate.getTime() + windowDays * 86400_000);
    const [rows]: any = await db.query(
        `SELECT COUNT(*) AS n FROM (
            SELECT 1 FROM Price USE INDEX (idx_price_value)
             WHERE price BETWEEN ? AND ? AND date BETWEEN ? AND ? LIMIT ?
        ) t`,
        [regular - tolerance, regular + tolerance, lo, hi, cap + 1],
    );
    return Number(rows?.[0]?.n ?? 0);
};
