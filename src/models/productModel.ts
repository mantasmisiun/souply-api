import pool from '../config/db.js';
import { nameSimilarity } from '../utils/productNameNormalize.js';

type Connection = typeof pool | any;

/** Similarity cutoff for auto-assigning baseProductId. Matches the cutoff used
 * by the one-shot seeding script (src/scripts/seedBaseProducts.ts). */
const AUTO_BASE_PRODUCT_THRESHOLD = 0.80;

/**
 * Find the baseProductId a brand-new Product with this name should inherit
 * based on the most similar existing Product in the same category. Returns
 * null when no existing Product clears the similarity threshold — the new
 * Product becomes its own root. Always points at the cluster's root (a
 * Product with baseProductId IS NULL), never at another variant, so we
 * never create multi-level chains.
 */
export const resolveBaseProductId = async (
    name: string,
    categoryId: number,
    conn?: Connection
): Promise<number | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        'SELECT id, baseProductId, name FROM Product WHERE categoryId = ?',
        [categoryId]
    );
    let best: { rootId: number; sim: number } | null = null;
    for (const row of rows) {
        const sim = nameSimilarity(name, row.name);
        if (sim >= AUTO_BASE_PRODUCT_THRESHOLD && (!best || sim > best.sim)) {
            best = { rootId: row.baseProductId ?? row.id, sim };
        }
    }
    return best ? best.rootId : null;
};

export const createProduct = async (
    categoryId: number,
    baseProductId: number | null,
    name: string,
    conn?: Connection
) => {
    const db = conn || pool;
    // Auto-assign baseProductId when the caller doesn't supply one. Keeps the
    // "every Product belongs to a cluster" invariant self-maintaining on every
    // insert path (admin add, future receipt-create-as-new, etc.) without
    // callers needing to know about the clustering logic.
    const effectiveBaseProductId =
        baseProductId ?? (await resolveBaseProductId(name, categoryId, db));
    const [result]: any = await db.query(
        'INSERT INTO Product (categoryId, baseProductId, name) VALUES (?, ?, ?)',
        [categoryId, effectiveBaseProductId, name]
    );
    return result.insertId;
};

const PRODUCT_WITH_IMAGES_SELECT = `
    p.id, p.categoryId, p.baseProductId, p.name,
    (SELECT JSON_ARRAYAGG(spi.imageUrl)
     FROM StoreProduct spi
     WHERE spi.productId = p.id AND spi.imageUrl IS NOT NULL) AS imageUrls
`;

export const searchProduct = async (query: string) => {
    const [products]: any = await pool.query(
        `SELECT ${PRODUCT_WITH_IMAGES_SELECT} FROM Product p WHERE p.name LIKE ?`,
        [`%${query}%`]
    );
    return products;
};

export const getProductById = async (id: number) => {
    const [products]: any = await pool.query(
        `SELECT ${PRODUCT_WITH_IMAGES_SELECT} FROM Product p WHERE p.id = ?`,
        [id]
    );
    return products[0] || null;
};

export const getProductsByCategory = async (categoryId: number) => {
    const [products]: any = await pool.query(
        `SELECT ${PRODUCT_WITH_IMAGES_SELECT} FROM Product p WHERE p.categoryId = ?`,
        [categoryId]
    );
    return products;
};

export const getProductByName = async (name: string) => {
    const [rows]: any = await pool.query(
        `SELECT ${PRODUCT_WITH_IMAGES_SELECT} FROM Product p WHERE p.name = ?`,
        [name]
    );
    return rows[0] || null;
};

export const updateProductCategory = async (storeProductId: number, categoryId: number) => {
    await pool.query(
        `UPDATE Product p
         JOIN StoreProduct sp ON sp.productId = p.id
         SET p.categoryId = ?
         WHERE sp.id = ?`,
        [categoryId, storeProductId]
    );
};

export const getProductsByCategoryWithAmounts = async (categoryId: number) => {
    const [products]: any = await pool.query(
        `SELECT p.id, p.name, p.categoryId,
            (SELECT JSON_ARRAYAGG(spi.imageUrl)
             FROM StoreProduct spi
             WHERE spi.productId = p.id AND spi.imageUrl IS NOT NULL) AS imageUrls,
            CAST(MIN(
                CASE WHEN sp.unit = 'kg' THEN sp.amount * 1000 ELSE sp.amount END
            ) AS UNSIGNED) as minAmount,
            CAST(MAX(
                CASE WHEN sp.unit = 'kg' THEN sp.amount * 1000 ELSE sp.amount END
            ) AS UNSIGNED) as maxAmount,
            'g' as unit,
            MAX(sp.isWeighable) as hasWeighable
        FROM Product p
        LEFT JOIN StoreProduct sp ON sp.productId = p.id
         WHERE p.categoryId = ?
         GROUP BY p.id`,
        [categoryId]
    );
    return products;
};

export const getAllProductsByL2WithAmounts = async (l2CategoryId: number) => {
    const [products]: any = await pool.query(
        `SELECT p.id, p.name, p.categoryId,
            (SELECT JSON_ARRAYAGG(spi.imageUrl)
             FROM StoreProduct spi
             WHERE spi.productId = p.id AND spi.imageUrl IS NOT NULL) AS imageUrls,
            CAST(MIN(
                CASE WHEN sp.unit = 'kg' THEN sp.amount * 1000 ELSE sp.amount END
            ) AS UNSIGNED) as minAmount,
            CAST(MAX(
                CASE WHEN sp.unit = 'kg' THEN sp.amount * 1000 ELSE sp.amount END
            ) AS UNSIGNED) as maxAmount,
            'g' as unit,
            MAX(sp.isWeighable) as hasWeighable
        FROM Product p
        LEFT JOIN StoreProduct sp ON sp.productId = p.id
         WHERE p.categoryId IN (
             SELECT id FROM Category WHERE parentCategoryId = ?
         )
         OR p.categoryId = ?
         GROUP BY p.id`,
        [l2CategoryId, l2CategoryId]
    );
    return products;
};