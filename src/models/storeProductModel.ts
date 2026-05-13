import pool from '../config/db.js';
import { resolveEffectiveProductId } from '../services/storeProductMergeService.js';

type Connection = typeof pool | any;

/**
 * Find an existing StoreProduct in the same chain with an exactly matching
 * name + amount + unit (case-insensitive on name). Used by the receipt-save
 * dedup pre-pass so we don't create parallel SP rows for the same SKU when
 * mobile's fuzzy matcher missed a trivial match (e.g., after a transient API
 * error). Stricter than fuzzy matching on purpose — the fuzzy path is
 * already the mobile /api/store-products/match endpoint.
 */
export const findExactMatchingStoreProduct = async (
    chainId: number,
    name: string,
    amount: number | null,
    unit: string | null,
    conn?: Connection
): Promise<number | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT id FROM StoreProduct
          WHERE chainId = ?
            AND LOWER(storeProductName) = LOWER(?)
            AND (amount IS NULL OR ? IS NULL OR amount = ?)
            AND (unit   IS NULL OR ? IS NULL OR unit   = ?)
          LIMIT 1`,
        [chainId, name, amount, amount, unit, unit]
    );
    return rows[0]?.id ?? null;
};

export const createStoreProduct = async (
    productId: number,
    chainId: number,
    storeProductName: string,
    brandName: string | null,
    isWeighable: boolean = false,
    amount: number | null = null,
    unit: string | null = null,
    imageUrl: string | null = null,
    conn?: Connection
    ) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [productId, chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl]
    );
    return result.insertId;
};

export const getStoreProductsByProductId = async (productId: number) => {
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM StoreProduct
         JOIN StoreChain ON StoreProduct.chainId = StoreChain.id
         WHERE StoreProduct.productId = ?`,
        [productId]
    );
    return rows;
};

/**
 * 'base' mode for the product detail view: resolve the given productId to
 * its BaseProduct cluster head, then return all StoreProducts for every
 * cluster member (head + variants). The detail page can then show every
 * variant side-by-side with its own chart, giving the user "all yogurts of
 * this base" at a glance.
 */
export const getStoreProductsForCluster = async (productId: number) => {
    // Follow mergedIntoId chain so a globally merged loser still shows its winner's cluster.
    const effectiveProductId = await resolveEffectiveProductId(productId);

    const [headRows]: any = await pool.query(
        `SELECT COALESCE(baseProductId, id) AS headId
           FROM Product
          WHERE id = ?
          LIMIT 1`,
        [effectiveProductId]
    );
    if (!headRows[0]) return [];
    const headId = Number(headRows[0].headId);

    const [rows]: any = await pool.query(
        `SELECT sp.*, sc.name AS chainName, sc.logoUrl
           FROM StoreProduct sp
           JOIN StoreChain sc ON sc.id = sp.chainId
           JOIN Product p ON p.id = sp.productId
          WHERE (p.id = ? OR p.baseProductId = ?)
            AND p.mergedIntoId IS NULL`,
        [headId, headId]
    );
    return rows;
};

export const getStoreProductsByChainId = async (chainId: number) => {
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM StoreProduct
         JOIN StoreChain ON StoreProduct.chainId = StoreChain.id 
         WHERE StoreProduct.chainId = ?`,
        [chainId]
    );
    return rows;
};

export const getStoreProductByName = async (storeProductName: string) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM StoreProduct WHERE storeProductName LIKE ?',
        [`%${storeProductName}%`]
    );
    return rows;
};

export const getStoreProductByNameAndChain = async (storeProductName: string, chainId: number, conn?: Connection) => {
    const db = conn || pool;
    const matchLength = Math.floor(storeProductName.length * 0.6);
    const searchTerm = storeProductName.substring(0, matchLength);
    const [rows]: any = await db.query(
        `SELECT * FROM StoreProduct 
         WHERE chainId = ? 
         AND storeProductName LIKE ?`,
        [chainId, `%${searchTerm}%`]
    );
    return rows[0] || null;
};

export const getStoreProductByProductAndChain = async (productId: number, chainId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM StoreProduct WHERE productId = ? AND chainId = ?',
        [productId, chainId]
    );
    return rows[0] || null;
};

export const searchStoreProductsByChain = async (name: string, chainId: number) => {
    const [rows]: any = await pool.query(
        `SELECT sp.*
         FROM StoreProduct sp
         WHERE sp.chainId = ?
         AND sp.storeProductName LIKE ?
         LIMIT 5`,
        [chainId, `%${name}%`]
    );
    return rows;
};

/** Swap a StoreProduct's imageUrl. Used by the user-supplied-photo flow in
 *  receipt detail (three-dots menu → Pridėti nuotrauką). */
export const updateStoreProductImageUrl = async (
    id: number,
    imageUrl: string | null
): Promise<void> => {
    await pool.query(
        'UPDATE StoreProduct SET imageUrl = ? WHERE id = ?',
        [imageUrl, id]
    );
};

export const updateStoreProductName = async (id: number, storeProductName: string) => {
    await pool.query(
        'UPDATE StoreProduct SET storeProductName = ? WHERE id = ?',
        [storeProductName, id]
    );
};

//For verifying price's storeProduct and store belong to the same chain
export const getChainIdByStoreProductId = async (storeProductId: number) => {
    const [rows]: any = await pool.query(
        'SELECT chainId FROM StoreProduct WHERE id = ?',
        [storeProductId]
    );
    return rows[0]?.chainId || null;
};

export const getStoreProductsByChainWithProductData = async (chainId: number) => {
    // c.name joined so MatchCandidate / ProductMatch carry `categoryName`
    // through to the client — used by C3's per-category spending breakdown
    // (avoids the mobile having to mirror the server taxonomy).
    //
    // categoryL2Name applies the same CASE that statsService uses so the
    // receipt-level breakdown and Profilis stats agree on labels:
    //   c is L1 → NULL (excluded from breakdown)
    //   c is L2 → c.name
    //   c is L3 → c2.name (the L2 parent)
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                sp.isWeighable, sp.amount, sp.unit,
                sp.imageUrl, p.categoryId, c.name AS categoryName,
                CASE
                  WHEN c.parentCategoryId IS NULL  THEN NULL
                  WHEN c2.parentCategoryId IS NULL THEN c.name
                  ELSE c2.name
                END AS categoryL2Name,
                sp.chainId
         FROM StoreProduct sp
         JOIN Product p ON sp.productId = p.id
         LEFT JOIN Category c  ON p.categoryId = c.id
         LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
         WHERE sp.chainId = ?`,
        [chainId]
    );
    return rows.map((r: any) => ({
        ...r,
        isWeighable: !!r.isWeighable,
        amount: r.amount !== null ? parseFloat(r.amount) : null,
    }));
};

/**
 * Cross-chain candidate fetch. Returns one representative StoreProduct
 * per Product (lowest sp.id wins — arbitrary but stable), so the
 * matcher doesn't score the same Product once per chain it's sold in.
 * Used by the match endpoint as a fallback when a chain's own
 * StoreProduct catalog is empty or sparse (e.g. Norfa, which has no
 * scrapable public catalog). The caller reuses the matched Product
 * id when creating a new chain-specific StoreProduct row via the
 * receipt resolver — that's how cross-chain product identity gets
 * established organically.
 */
export const getStoreProductsCrossChainWithProductData = async (excludeChainId: number) => {
    // c.name joined so cross-chain candidates also carry `categoryName`
    // through to the client (see getStoreProductsByChainWithProductData).
    // categoryL2Name resolved with the same CASE as the same-chain
    // fetcher so both code paths emit identical breakdown labels.
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                sp.isWeighable, sp.amount, sp.unit,
                sp.imageUrl, p.categoryId, c.name AS categoryName,
                CASE
                  WHEN c.parentCategoryId IS NULL  THEN NULL
                  WHEN c2.parentCategoryId IS NULL THEN c.name
                  ELSE c2.name
                END AS categoryL2Name,
                sp.chainId
         FROM StoreProduct sp
         JOIN Product p ON sp.productId = p.id
         LEFT JOIN Category c  ON p.categoryId = c.id
         LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
         JOIN (
             SELECT productId, MIN(id) AS repId
             FROM StoreProduct
             WHERE chainId <> ?
             GROUP BY productId
         ) rep ON rep.repId = sp.id
         WHERE sp.chainId <> ?`,
        [excludeChainId, excludeChainId]
    );
    return rows.map((r: any) => ({
        ...r,
        isWeighable: !!r.isWeighable,
        amount: r.amount !== null ? parseFloat(r.amount) : null,
    }));
};
export const searchUnifiedProductsByChain = async (
    chainId: number,
    name: string,
    categoryId?: number | null,
) => {
    const term = name.trim();
    const hasTerm = term.length > 0;
    const hasCategory = Number.isFinite(categoryId) && Number(categoryId) > 0;

    if (!hasTerm && !hasCategory) {
        return { localStoreProducts: [], otherChainProducts: [] };
    }

    const localWhere: string[] = ['sp.chainId = ?'];
    const localParams: any[] = [chainId];

    if (hasTerm) {
        localWhere.push('sp.storeProductName LIKE ?');
        localParams.push(`%${term}%`);
    }
    if (hasCategory) {
        localWhere.push(`(
            p.categoryId = ?
            OR p.categoryId IN (
                SELECT c.id FROM Category c WHERE c.parentCategoryId = ?
            )
            OR p.categoryId IN (
                SELECT c2.id
                FROM Category c1
                JOIN Category c2 ON c2.parentCategoryId = c1.id
                WHERE c1.parentCategoryId = ?
            )
        )`);
        localParams.push(Number(categoryId), Number(categoryId), Number(categoryId));
    }

    const [localRows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.amount, sp.unit,
                sp.imageUrl,
                sc.id AS chainId, sc.name AS chainName, sc.logoUrl AS chainLogoUrl
         FROM StoreProduct sp
         JOIN Product p ON p.id = sp.productId
         JOIN StoreChain sc ON sc.id = sp.chainId
         WHERE ${localWhere.join(' AND ')}
         ORDER BY sp.storeProductName
         LIMIT 40`,
        localParams
    );

    const otherWhere: string[] = [
        `NOT EXISTS (
            SELECT 1 FROM StoreProduct spc
            WHERE spc.productId = p.id AND spc.chainId = ?
        )`,
        `EXISTS (
            SELECT 1 FROM StoreProduct spo
            WHERE spo.productId = p.id AND spo.chainId <> ?
        )`
    ];
    const otherParams: any[] = [chainId, chainId];

    if (hasTerm) {
        otherWhere.push('p.name LIKE ?');
        otherParams.push(`%${term}%`);
    }
    if (hasCategory) {
        otherWhere.push(`(
            p.categoryId = ?
            OR p.categoryId IN (
                SELECT c.id FROM Category c WHERE c.parentCategoryId = ?
            )
            OR p.categoryId IN (
                SELECT c2.id
                FROM Category c1
                JOIN Category c2 ON c2.parentCategoryId = c1.id
                WHERE c1.parentCategoryId = ?
            )
        )`);
        otherParams.push(Number(categoryId), Number(categoryId), Number(categoryId));
    }

    const [otherRows]: any = await pool.query(
        `SELECT p.id AS productId, p.name AS productName, p.categoryId,
                (SELECT JSON_ARRAYAGG(spi.imageUrl)
                 FROM StoreProduct spi
                 WHERE spi.productId = p.id
                   AND spi.chainId <> ?
                   AND spi.imageUrl IS NOT NULL) AS imageUrls,
                (
                    SELECT sc.logoUrl
                    FROM StoreProduct spx
                    JOIN StoreChain sc ON sc.id = spx.chainId
                    WHERE spx.productId = p.id AND spx.chainId <> ?
                    ORDER BY sc.id
                    LIMIT 1
                ) AS sourceChainLogoUrl
         FROM Product p
         WHERE ${otherWhere.join(' AND ')}
         ORDER BY p.name
         LIMIT 40`,
        [chainId, chainId, ...otherParams]
    );

    return {
        localStoreProducts: localRows.map((r: any) => ({
            ...r,
            amount: r.amount !== null ? Number(r.amount) : null,
        })),
        otherChainProducts: otherRows,
    };
};
