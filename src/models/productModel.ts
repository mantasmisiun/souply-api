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

export type BrowseMode = 'base' | 'sku';

/**
 * Amount normalization expression for the browse aggregates.
 *
 * Mass: kg → ×1000 g.
 * Volume: l → ×1000 ml. Under the MVP heuristic "most grocery items are
 * water-based, so 1 kg ≈ 1 l", we display the combined range under the
 * "g" label — e.g. a cluster containing 250 g, 350 ml, 0.75 kg renders
 * as "250 - 750 g".
 *
 * Non-mass/volume units (vnt, NULL, other) return NULL and drop out of
 * MIN/MAX aggregation. If a Product / cluster has only such units, its
 * minAmount/maxAmount come back NULL and the frontend hides the amount
 * line entirely (Case 3).
 */
const AMOUNT_NORMALIZED_EXPR = `
    CASE
        WHEN sp.unit IN ('kg', 'l') THEN sp.amount * 1000
        WHEN sp.unit IN ('g', 'ml') THEN sp.amount
        ELSE NULL
    END
`;

/**
 * Browse one L3 category.
 *
 * Mode only changes which Products are returned:
 *   'base' — cluster heads only (Product.baseProductId IS NULL). Variants
 *            collapse behind their head; tapping the head opens the detail
 *            screen which shows every variant side-by-side.
 *   'sku'  — every non-merged Product (heads + variants), one row each.
 *
 * Amount ranges reflect the Product's own StoreProducts in both modes
 * (not cluster-wide — keeping the query index-friendly). The detail view
 * in base mode surfaces the full cluster's variants.
 */
export const getProductsByCategoryWithAmounts = async (
    categoryId: number,
    mode: BrowseMode = 'base'
) => {
    const baseFilter = mode === 'base' ? 'AND p.baseProductId IS NULL' : '';
    const [products]: any = await pool.query(
        `SELECT p.id, p.name, p.categoryId,
            (SELECT JSON_ARRAYAGG(spi.imageUrl)
             FROM StoreProduct spi
             WHERE spi.productId = p.id AND spi.imageUrl IS NOT NULL) AS imageUrls,
            CAST(MIN(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as minAmount,
            CAST(MAX(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as maxAmount,
            'g' as unit,
            MAX(sp.isWeighable) as hasWeighable
         FROM Product p
         LEFT JOIN StoreProduct sp ON sp.productId = p.id
         WHERE p.categoryId = ?
           AND p.mergedIntoId IS NULL
           ${baseFilter}
         GROUP BY p.id`,
        [categoryId]
    );
    return products;
};

export const getAllProductsByL2WithAmounts = async (
    l2CategoryId: number,
    mode: BrowseMode = 'base'
) => {
    const baseFilter = mode === 'base' ? 'AND p.baseProductId IS NULL' : '';
    const [products]: any = await pool.query(
        `SELECT p.id, p.name, p.categoryId,
            (SELECT JSON_ARRAYAGG(spi.imageUrl)
             FROM StoreProduct spi
             WHERE spi.productId = p.id AND spi.imageUrl IS NOT NULL) AS imageUrls,
            CAST(MIN(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as minAmount,
            CAST(MAX(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as maxAmount,
            'g' as unit,
            MAX(sp.isWeighable) as hasWeighable
         FROM Product p
         LEFT JOIN StoreProduct sp ON sp.productId = p.id
         WHERE (p.categoryId IN (SELECT id FROM Category WHERE parentCategoryId = ?)
                OR p.categoryId = ?)
           AND p.mergedIntoId IS NULL
           ${baseFilter}
         GROUP BY p.id`,
        [l2CategoryId, l2CategoryId]
    );
    return products;
};