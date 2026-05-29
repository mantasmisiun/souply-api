import pool from '../config/db.js';
import { nameSimilarity } from '../utils/productNameNormalize.js';
import { buildFuzzyNameClause } from '../utils/fuzzyNameClause.js';
import {
    loadCanonicalsForProducts,
    attachCanonicalFields,
} from '../services/productCanonical.js';

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
    const fuzzy = buildFuzzyNameClause(query, 'p.name');
    const [products]: any = await pool.query(
        `${BROWSE_SELECT}
         JOIN Category cat ON cat.id = p.categoryId AND cat.name NOT LIKE 'Nepriskirt%'
         WHERE ${fuzzy.sql}
           AND p.mergedIntoId IS NULL
         GROUP BY p.id
         ORDER BY p.globalScore DESC
         LIMIT 50`,
        fuzzy.params,
    );
    if (products.length === 0) return [];
    const categoryIds = [...new Set((products as any[]).map((p: any) => p.categoryId).filter(Boolean))];
    const [catRows]: any = categoryIds.length
        ? await pool.query(`SELECT id, name FROM Category WHERE id IN (?)`, [categoryIds])
        : [[]];
    const catNameMap: Record<number, string> = Object.fromEntries((catRows as any[]).map((r: any) => [r.id, r.name]));
    const productsWithCat = (products as any[]).map((p: any) => ({ ...p, categoryName: catNameMap[p.categoryId] ?? null }));
    const productIds = productsWithCat.map((p: any) => p.id);
    const canonicals = await loadCanonicalsForProducts(productIds);
    return attachCanonicalFields(productsWithCat, canonicals);
};

export const getProductById = async (id: number) => {
    const [products]: any = await pool.query(
        `${BROWSE_SELECT} WHERE p.id = ? GROUP BY p.id`,
        [id]
    );
    const product = products[0] || null;
    if (!product) return null;
    const canonicals = await loadCanonicalsForProducts([product.id]);
    return attachCanonicalFields([product], canonicals)[0];
};

export const getProductsByCategory = async (categoryId: number) => {
    const [products]: any = await pool.query(
        `SELECT ${PRODUCT_WITH_IMAGES_SELECT} FROM Product p WHERE p.categoryId = ?`,
        [categoryId]
    );
    return products;
};

/**
 * Slim product-search payload for admin type-ahead pickers (Flags-tab
 * "this matched product is wrong" flow). Returns only the columns the
 * dropdown renders + needs on commit: id, canonical name, current
 * category id + name. No image arrays, no globalScore — those balloon
 * the response on a typeahead loop. Locale parameter is honoured so
 * the picker speaks the admin's language for category labels.
 */
export const searchProductsForAdmin = async (
    query: string,
    locale: 'lt' | 'en' = 'lt',
    limit: number = 10,
) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const fuzzy = buildFuzzyNameClause(trimmed, 'p.name');
    const [rows]: any = await pool.query(
        `SELECT p.id,
                p.name,
                p.categoryId,
                COALESCE(ct.name, c.name) AS categoryName
           FROM Product p
           LEFT JOIN Category c ON c.id = p.categoryId
           LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
          WHERE ${fuzzy.sql}
          ORDER BY p.globalScore DESC, p.id ASC
          LIMIT ?`,
        [locale, ...fuzzy.params, limit],
    );
    return rows.map((r: any) => ({
        id: Number(r.id),
        name: String(r.name),
        categoryId: r.categoryId !== null ? Number(r.categoryId) : null,
        categoryName: r.categoryName ?? null,
    }));
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

const BROWSE_SELECT = `
    SELECT p.id, p.name, p.categoryId, p.globalScore,
        (SELECT JSON_ARRAYAGG(spi.imageUrl)
         FROM StoreProduct spi
         WHERE spi.productId = p.id AND spi.imageUrl IS NOT NULL) AS imageUrls,
        (SELECT JSON_ARRAYAGG(JSON_OBJECT('chainId', cl.chainId, 'logoUrl', cl.miniLogoUrl))
         FROM (SELECT DISTINCT sp2.chainId, sc2.miniLogoUrl
               FROM StoreProduct sp2
               JOIN StoreChain sc2 ON sc2.id = sp2.chainId
               WHERE sp2.productId = p.id) cl) AS chainLogos,
        CAST(MIN(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as minAmount,
        CAST(MAX(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as maxAmount,
        'g' as unit,
        MAX(sp.isWeighable) as hasWeighable
     FROM Product p
     LEFT JOIN StoreProduct sp ON sp.productId = p.id
`;

/**
 * Fetch globally merged loser products that the user has personally voted
 * 'different' on (for the loser ↔ winner pair). These products are normally
 * hidden by the `mergedIntoId IS NULL` filter but should be restored for
 * users who explicitly rejected the global merge.
 */
async function fetchPersonallyRestoredProducts(
    userId: string,
    categoryFilter: string,
    categoryParams: any[],
    baseFilter: string,
): Promise<any[]> {
    const [rows]: any = await pool.query(
        `${BROWSE_SELECT}
         WHERE ${categoryFilter}
           AND p.mergedIntoId IS NOT NULL
           AND EXISTS (
               SELECT 1
                 FROM UserStoreProductEquivalence e
                 JOIN StoreProduct spA ON spA.id = e.spIdA
                 JOIN StoreProduct spB ON spB.id = e.spIdB
                WHERE e.userId = ?
                  AND e.verdict = 'different'
                  AND (
                      (spA.productId = p.id AND spB.productId = p.mergedIntoId)
                   OR (spB.productId = p.id AND spA.productId = p.mergedIntoId)
                  )
           )
           ${baseFilter}
         GROUP BY p.id`,
        [...categoryParams, userId],
    );
    return rows;
}

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
 *
 * When userId is provided, globally merged products that the user has
 * personally voted 'different' on are restored to the list.
 */
const BLENDED_ORDER_BY = `
    ORDER BY CASE
        WHEN MAX(ups.interactionCount) > 0
        THEN (LEAST(MAX(ups.interactionCount), 10) / 10.0) * MAX(ups.score)
             + (1 - LEAST(MAX(ups.interactionCount), 10) / 10.0) * p.globalScore
        ELSE p.globalScore
    END DESC
`;

export const getProductsByCategoryWithAmounts = async (
    categoryId: number,
    mode: BrowseMode = 'base',
    userId?: string,
) => {
    const baseFilter = mode === 'base' ? 'AND p.baseProductId IS NULL' : '';

    let products: any[];
    if (userId) {
        [products] = await pool.query(
            `${BROWSE_SELECT}
             LEFT JOIN UserProductScore ups ON ups.userId = ? AND ups.productId = p.id
             WHERE p.categoryId = ?
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ${BLENDED_ORDER_BY}`,
            [userId, categoryId],
        ) as any;
    } else {
        [products] = await pool.query(
            `${BROWSE_SELECT}
             WHERE p.categoryId = ?
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ORDER BY p.globalScore DESC`,
            [categoryId],
        ) as any;
    }

    if (userId) {
        const restored = await fetchPersonallyRestoredProducts(
            userId,
            'p.categoryId = ?',
            [categoryId],
            baseFilter,
        );
        products.push(...restored);
    }

    // Attach canonical-unit fields (used by the client AmountPickerModal +
    // basket +/- buttons to know the right step size + display unit).
    const productIds = products.map(p => Number(p.id));
    const canonicals = await loadCanonicalsForProducts(productIds);
    return attachCanonicalFields(products, canonicals);
};

const DISCOUNT_AMOUNT_EXPR = `
    CASE
        WHEN sp.unit IN ('kg', 'l') THEN sp.amount * 1000
        WHEN sp.unit IN ('g', 'ml') THEN sp.amount
        ELSE NULL
    END
`;

/**
 * Recompute the DiscountedProductSummary table from current Product + Price state.
 * Runs the heavy aggregation query once and writes the result into a flat,
 * pre-joined table so the request-time endpoint becomes a simple indexed read.
 *
 * Called on server boot, after every scraper batch, and daily at 00:30 to
 * drop promos that expired overnight. Idempotent — TRUNCATE + bulk INSERT.
 */
export const refreshDiscountedSummary = async (): Promise<void> => {
    const t0 = Date.now();
    const [rows]: any = await pool.query(
        `SELECT p.id, p.name, p.categoryId,
            c.parentCategoryId AS l2CategoryId,
            imgs.imageUrls,
            chains.chainLogos,
            CAST(MIN(${DISCOUNT_AMOUNT_EXPR}) AS UNSIGNED) AS minAmount,
            CAST(MAX(${DISCOUNT_AMOUNT_EXPR}) AS UNSIGNED) AS maxAmount,
            'g' AS unit,
            MAX(sp.isWeighable) AS hasWeighable,
            MAX(ROUND((1 - d.promoPrice / d.price) * 100)) AS bestDiscountPct
         FROM Product p
         LEFT JOIN Category c ON c.id = p.categoryId
         LEFT JOIN StoreProduct sp ON sp.productId = p.id
         LEFT JOIN (
             SELECT productId, JSON_ARRAYAGG(imageUrl) AS imageUrls
             FROM StoreProduct
             WHERE imageUrl IS NOT NULL
             GROUP BY productId
         ) imgs ON imgs.productId = p.id
         LEFT JOIN (
             SELECT sp2.productId,
                    JSON_ARRAYAGG(JSON_OBJECT('chainId', sc.id, 'logoUrl', sc.miniLogoUrl)) AS chainLogos
             FROM (SELECT DISTINCT productId, chainId FROM StoreProduct) sp2
             JOIN StoreChain sc ON sc.id = sp2.chainId
             GROUP BY sp2.productId
         ) chains ON chains.productId = p.id
         INNER JOIN (
             SELECT spi2.productId, pr.promoPrice, pr.price
             FROM Price pr
             JOIN StoreProduct spi2 ON spi2.id = pr.storeProductId
             INNER JOIN (
                 SELECT storeProductId, MAX(id) AS maxId
                 FROM Price FORCE INDEX (idx_price_promo_end)
                 WHERE promoEnd > NOW()
                   AND promoPrice IS NOT NULL
                 GROUP BY storeProductId
             ) latest ON latest.maxId = pr.id
             WHERE pr.promoPrice < pr.price
               AND pr.price > 0
         ) d ON d.productId = p.id
         WHERE p.mergedIntoId IS NULL
           AND p.baseProductId IS NULL
         GROUP BY p.id
         HAVING bestDiscountPct > 0
         ORDER BY bestDiscountPct DESC`,
    );

    const productIds = rows.map((r: any) => Number(r.id));
    const canonicals = await loadCanonicalsForProducts(productIds);
    const enriched = attachCanonicalFields(rows, canonicals);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM DiscountedProductSummary');
        if (enriched.length > 0) {
            const values = enriched.map((r: any) => [
                r.id,
                r.name,
                r.categoryId ?? null,
                r.l2CategoryId ?? null,
                r.imageUrls ? JSON.stringify(r.imageUrls) : null,
                r.chainLogos ? JSON.stringify(r.chainLogos) : null,
                r.minAmount ?? null,
                r.maxAmount ?? null,
                r.unit ?? 'g',
                r.hasWeighable ?? 0,
                r.bestDiscountPct,
                r.canonicalUnit,
                r.canonicalStep,
                r.canonicalFamily,
            ]);
            await conn.query(
                `INSERT INTO DiscountedProductSummary
                 (productId, name, categoryId, l2CategoryId, imageUrls, chainLogos,
                  minAmount, maxAmount, unit, hasWeighable, bestDiscountPct,
                  canonicalUnit, canonicalStep, canonicalFamily)
                 VALUES ?`,
                [values],
            );
        }
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    console.log(`[DiscountsSummary] refreshed ${enriched.length} rows in ${Date.now() - t0} ms`);
};

/**
 * Return the latest summary updatedAt as a unix-ms timestamp for ETag generation.
 * Returns 0 when the table is empty.
 */
export const getDiscountsSummaryUpdatedAt = async (): Promise<number> => {
    const [rows]: any = await pool.query(
        `SELECT UNIX_TIMESTAMP(MAX(updatedAt)) * 1000 AS ts FROM DiscountedProductSummary`,
    );
    return Number(rows[0]?.ts ?? 0);
};

export const getDiscountedProducts = async (opts: {
    l2CategoryId?: number;
    search?: string;
    limit?: number;
    offset?: number;
} = {}) => {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts.l2CategoryId != null) {
        conditions.push('l2CategoryId = ?');
        params.push(opts.l2CategoryId);
    }
    if (opts.search) {
        const fuzzy = buildFuzzyNameClause(opts.search, 'name');
        conditions.push(`(${fuzzy.sql})`);
        params.push(...fuzzy.params);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = opts.limit != null
        ? `LIMIT ${Number(opts.limit)} OFFSET ${Number(opts.offset ?? 0)}`
        : '';

    const [rows]: any = await pool.query(
        `SELECT productId AS id, name, categoryId, l2CategoryId,
                imageUrls, chainLogos, minAmount, maxAmount, unit, hasWeighable,
                bestDiscountPct, canonicalUnit, canonicalStep, canonicalFamily
           FROM DiscountedProductSummary
           ${where}
           ORDER BY bestDiscountPct DESC
           ${limitClause}`,
        params,
    );
    return rows;
};

export const getAllProductsByL2WithAmounts = async (
    l2CategoryId: number,
    mode: BrowseMode = 'base',
    userId?: string,
) => {
    const baseFilter = mode === 'base' ? 'AND p.baseProductId IS NULL' : '';
    const l2Filter = '(p.categoryId IN (SELECT id FROM Category WHERE parentCategoryId = ?) OR p.categoryId = ?)';
    const l2Params = [l2CategoryId, l2CategoryId];

    let products: any[];
    if (userId) {
        [products] = await pool.query(
            `${BROWSE_SELECT}
             LEFT JOIN UserProductScore ups ON ups.userId = ? AND ups.productId = p.id
             WHERE ${l2Filter}
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ${BLENDED_ORDER_BY}`,
            [userId, ...l2Params],
        ) as any;
    } else {
        [products] = await pool.query(
            `${BROWSE_SELECT}
             WHERE ${l2Filter}
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ORDER BY p.globalScore DESC`,
            l2Params,
        ) as any;
    }

    if (userId) {
        const restored = await fetchPersonallyRestoredProducts(
            userId,
            l2Filter,
            l2Params,
            baseFilter,
        );
        products.push(...restored);
    }

    const productIds = products.map(p => Number(p.id));
    const canonicals = await loadCanonicalsForProducts(productIds);
    return attachCanonicalFields(products, canonicals);
};