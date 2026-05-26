import pool from '../config/db.js';
import { localizedCategoryNameSql, type Locale } from '../middleware/locale.js';

/**
 * Locale-aware category model.
 *
 * Every query that returns a `name` field accepts a `locale` argument and
 * returns:
 *   - `name`: the translated name (or LT fallback if no translation row)
 *   - `nameKey`: the canonical LT name, used as a stable lookup key on
 *     the client (e.g. the `CATEGORY_ICONS` map keyed by LT name keeps
 *     working regardless of display language).
 *
 * Scraper-facing helpers (`resolveCategoryByPath`, `createCategory`)
 * operate strictly on LT — the source data is LT and the comparisons
 * happen against the canonical column.
 */

export const getAllL2Categories = async (locale: Locale = 'lt') => {
    const tr2 = localizedCategoryNameSql(locale, { categoryAlias: 'c2', translationAlias: 'ct2' });
    const tr1 = localizedCategoryNameSql(locale, { categoryAlias: 'c1', translationAlias: 'ct1' });
    const [rows]: any = await pool.query(
        `SELECT c2.id,
                ${tr2.nameSql} AS name,
                c2.name        AS nameKey,
                c2.parentCategoryId,
                c1.id          AS l1Id,
                ${tr1.nameSql} AS l1Name,
                c1.name        AS l1NameKey
         FROM Category c2
         JOIN Category c1 ON c1.id = c2.parentCategoryId
         ${tr2.joinSql}
         ${tr1.joinSql}
         WHERE c2.parentCategoryId IN (SELECT id FROM Category WHERE parentCategoryId IS NULL)
           AND c2.isHidden = 0
         ORDER BY c1.id, name`,
        [tr2.localeParam, tr1.localeParam],
    );
    return rows;
};

//Create a new category
export const createCategory = async (
    name: string,
    parentCategoryId: number | null
) => {
    const [result]: any = await pool.query(
        'INSERT INTO Category (name, parentCategoryId) VALUES (?, ?)',
        [name, parentCategoryId]
    );
    return result.insertId;
};

// User-facing category queries exclude hidden rows (e.g., the Nepriskirta
// orphan bucket used by receipt-save when it creates a Product with no
// confident category match). Admin/internal queries that need to see hidden
// rows should bypass these helpers and query Category directly.

export const getTopLevelCategories = async (locale: Locale = 'lt') => {
    const tr = localizedCategoryNameSql(locale);
    const [rows]: any = await pool.query(
        `SELECT c.id, c.parentCategoryId, c.isHidden,
                ${tr.nameSql} AS name,
                c.name AS nameKey
         FROM Category c
         ${tr.joinSql}
         WHERE c.parentCategoryId IS NULL AND c.isHidden = 0`,
        [tr.localeParam],
    );
    return rows;
};

export const getSubCategories = async (parentCategoryId: number, locale: Locale = 'lt') => {
    const tr = localizedCategoryNameSql(locale);
    const [rows]: any = await pool.query(
        `SELECT c.id, c.parentCategoryId, c.isHidden,
                ${tr.nameSql} AS name,
                c.name AS nameKey
         FROM Category c
         ${tr.joinSql}
         WHERE c.parentCategoryId = ? AND c.isHidden = 0`,
        [tr.localeParam, parentCategoryId],
    );
    return rows;
};

export const getSubCategoriesWithProductCounts = async (parentCategoryId: number, locale: Locale = 'lt') => {
    const tr = localizedCategoryNameSql(locale);
    const [rows]: any = await pool.query(
        `SELECT c.id, c.parentCategoryId,
                ${tr.nameSql} AS name,
                c.name AS nameKey,
                COUNT(p.id) AS productCount
         FROM Category c
         ${tr.joinSql}
         LEFT JOIN Product p ON p.categoryId = c.id AND p.mergedIntoId IS NULL
         WHERE c.parentCategoryId = ? AND c.isHidden = 0
         GROUP BY c.id`,
        [tr.localeParam, parentCategoryId],
    );
    return rows;
};

export const getAllCategories = async (locale: Locale = 'lt') => {
    const tr = localizedCategoryNameSql(locale);
    const [rows]: any = await pool.query(
        `SELECT c.id, c.parentCategoryId,
                ${tr.nameSql} AS name,
                c.name AS nameKey
         FROM Category c
         ${tr.joinSql}
         WHERE c.isHidden = 0`,
        [tr.localeParam],
    );
    return rows;
};

/** Case/diacritic/punctuation-insensitive name comparison for category lookup. */
function normalizeCategoryName(name: string): string {
    if (!name) return '';
    return name
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * Resolve a hierarchical path (scraper breadcrumb) to a Category id. Tries
 * strict top-down walk first: each segment is matched against its parent's
 * children (normalized). If that fails — e.g. caller passed only a leaf
 * name like ["Grybai"] which isn't a root — falls back to a flat search
 * on the LAST segment across the whole tree. Returns null when even the
 * flat fallback finds nothing.
 *
 *   resolveCategoryByPath(['Mėsa ir paukštiena', 'Dešros', 'Vytintos dešros'])
 *   resolveCategoryByPath(['Grybai'])  // flat fallback matches as L2
 *
 * Always matches against the canonical LT `Category.name` — scraper data
 * is LT-only and the canonical column is the stable identifier.
 */
export const resolveCategoryByPath = async (
    segments: string[]
): Promise<number | null> => {
    if (!Array.isArray(segments) || segments.length === 0) return null;

    // 1. Strict top-down walk.
    let parentId: number | null = null;
    let matchedId: number | null = null;
    for (const seg of segments) {
        const target = normalizeCategoryName(seg);
        if (!target) break;
        const [rows]: any = await pool.query(
            parentId === null
                ? `SELECT id, name FROM Category WHERE parentCategoryId IS NULL AND isHidden = 0`
                : `SELECT id, name FROM Category WHERE parentCategoryId = ? AND isHidden = 0`,
            parentId === null ? [] : [parentId]
        );
        const hit = (rows as any[]).find(
            (r: any) => normalizeCategoryName(r.name) === target
        );
        if (!hit) break;
        matchedId = hit.id;
        parentId = hit.id;
    }
    if (matchedId !== null) return matchedId;

    // 2. Flat fallback: search the whole tree for the last segment by name.
    //    Scrapers often pass just a leaf name; this lets that work as long
    //    as the name is unique enough to land once.
    const lastTarget = normalizeCategoryName(segments[segments.length - 1]);
    if (!lastTarget) return null;
    const [flat]: any = await pool.query(
        'SELECT id, name FROM Category WHERE isHidden = 0'
    );
    const flatHit = (flat as any[]).find(
        (r: any) => normalizeCategoryName(r.name) === lastTarget
    );
    return flatHit ? flatHit.id : null;
};

export const getCategoryById = async (id: number, locale: Locale = 'lt') => {
    const tr = localizedCategoryNameSql(locale);
    const [rows]: any = await pool.query(
        `SELECT c.id, c.parentCategoryId, c.isHidden,
                ${tr.nameSql} AS name,
                c.name AS nameKey
         FROM Category c
         ${tr.joinSql}
         WHERE c.id = ?`,
        [tr.localeParam, id],
    );
    return rows[0] || null;
};

export const getCategoryPath = async (id: number, locale: Locale = 'lt'): Promise<string> => {
    const parts: string[] = [];
    let currentId: number | null = id;
    const tr = localizedCategoryNameSql(locale);

    while (currentId !== null) {
        const [rows]: any = await pool.query(
            `SELECT c.id, c.parentCategoryId,
                    ${tr.nameSql} AS name
             FROM Category c
             ${tr.joinSql}
             WHERE c.id = ?`,
            [tr.localeParam, currentId],
        );
        if (!rows[0]) break;
        parts.unshift(rows[0].name);
        currentId = rows[0].parentCategoryId;
    }

    return parts.join(' > ');
};

export const getAllProductsByParentCategory = async (parentCategoryId: number) => {
    const [rows]: any = await pool.query(
        `SELECT DISTINCT p.*
         FROM Product p
         JOIN Category c ON p.categoryId = c.id
         WHERE c.parentCategoryId = ?`,
        [parentCategoryId]
    );
    return rows;
};

export const getCategoryAncestors = async (id: number, locale: Locale = 'lt') => {
    const chain: any[] = [];
    let currentId: number | null = id;
    const tr = localizedCategoryNameSql(locale);
    while (currentId !== null) {
        const [rows]: any = await pool.query(
            `SELECT c.id, c.parentCategoryId,
                    ${tr.nameSql} AS name,
                    c.name AS nameKey
             FROM Category c
             ${tr.joinSql}
             WHERE c.id = ?`,
            [tr.localeParam, currentId],
        );
        if (!rows[0]) break;
        chain.unshift(rows[0]);
        currentId = rows[0].parentCategoryId;
    }
    return {
        l1: chain[0] ? { id: chain[0].id, name: chain[0].name, nameKey: chain[0].nameKey } : null,
        l2: chain[1] ? { id: chain[1].id, name: chain[1].name, nameKey: chain[1].nameKey } : null,
        l3: chain[2] ? { id: chain[2].id, name: chain[2].name, nameKey: chain[2].nameKey } : null,
    };
};

export const getStoreProductsByCategoryAndChain = async (
    categoryId: number,
    chainId: number,
    includeSubcategories: boolean = true
) => {
    // categoryId may be L1, L2, or L3. If includeSubcategories, match any descendant.
    const [rows]: any = includeSubcategories
        ? await pool.query(
            `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                    sp.isWeighable, sp.amount, sp.unit,
                    sp.imageUrl, p.name AS productName
             FROM StoreProduct sp
             JOIN Product p ON sp.productId = p.id
             JOIN Category c ON p.categoryId = c.id
             WHERE sp.chainId = ?
               AND (c.id = ? OR c.parentCategoryId = ? OR c.parentCategoryId IN
                    (SELECT id FROM Category WHERE parentCategoryId = ?))
             ORDER BY sp.storeProductName`,
            [chainId, categoryId, categoryId, categoryId]
        )
        : await pool.query(
            `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                    sp.isWeighable, sp.amount, sp.unit,
                    sp.imageUrl, p.name AS productName
             FROM StoreProduct sp
             JOIN Product p ON sp.productId = p.id
             WHERE sp.chainId = ? AND p.categoryId = ?
             ORDER BY sp.storeProductName`,
            [chainId, categoryId]
        );
    return rows.map((r: any) => ({
        ...r,
        isWeighable: !!r.isWeighable,
        amount: r.amount !== null ? parseFloat(r.amount) : null,
    }));
};

export const searchL3CategoriesByName = async (query: string, locale: Locale = 'lt') => {
    // Search on the canonical LT name AND the translated name so users
    // typing in either language find their category. The autocomplete
    // is short-lived UI, so two LIKEs is fine.
    const tr3 = localizedCategoryNameSql(locale, { categoryAlias: 'c3', translationAlias: 'ct3' });
    const tr2 = localizedCategoryNameSql(locale, { categoryAlias: 'c2', translationAlias: 'ct2' });
    const tr1 = localizedCategoryNameSql(locale, { categoryAlias: 'c1', translationAlias: 'ct1' });
    const like = `%${query}%`;
    const [rows]: any = await pool.query(
        `SELECT c3.id,
                ${tr3.nameSql} AS name,
                c3.name        AS nameKey,
                c2.id          AS l2Id,
                ${tr2.nameSql} AS l2Name,
                ${tr1.nameSql} AS l1Name
         FROM Category c3
         JOIN Category c2 ON c2.id = c3.parentCategoryId
         JOIN Category c1 ON c1.id = c2.parentCategoryId
         ${tr3.joinSql}
         ${tr2.joinSql}
         ${tr1.joinSql}
         WHERE (c3.name LIKE ? OR ct3.name LIKE ?)
           AND c3.isHidden = 0 AND c2.isHidden = 0 AND c1.isHidden = 0
         ORDER BY name
         LIMIT 20`,
        [tr3.localeParam, tr2.localeParam, tr1.localeParam, like, like],
    );

    return rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        nameKey: r.nameKey,
        l2Id: Number(r.l2Id),
        l2Name: r.l2Name,
        path: `${r.l1Name} > ${r.l2Name} > ${r.name}`,
    }));
};
