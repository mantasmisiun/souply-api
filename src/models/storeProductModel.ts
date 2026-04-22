import pool from '../config/db.js';

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
            AND ((amount IS NULL AND ? IS NULL) OR amount = ?)
            AND ((unit   IS NULL AND ? IS NULL) OR unit   = ?)
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
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                sp.isWeighable, sp.amount, sp.unit,
                sp.imageUrl, p.categoryId
         FROM StoreProduct sp
         JOIN Product p ON sp.productId = p.id
         WHERE sp.chainId = ?`,
        [chainId]
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
