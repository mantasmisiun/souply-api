import pool from '../config/db.js';

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

export const getTopLevelCategories = async () => {
    const [categories]: any = await pool.query(
        'SELECT * FROM Category WHERE parentCategoryId IS NULL AND isHidden = 0'
    );
    return categories;
};

export const getSubCategories = async (parentCategoryId: number) => {
    const [categories]: any = await pool.query(
        'SELECT * FROM Category WHERE parentCategoryId = ? AND isHidden = 0',
        [parentCategoryId]
    );
    return categories;
};

export const getAllCategories = async () => {
    const [categories]: any = await pool.query(
        'SELECT id, parentCategoryId, name FROM Category WHERE isHidden = 0'
    );
    return categories;
};

export const getCategoryById = async (id: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM Category WHERE id = ?',
        [id]
    );
    return rows[0] || null;
};

export const getCategoryPath = async (id: number): Promise<string> => {
    const parts: string[] = [];
    let currentId: number | null = id;
    
    while (currentId !== null) {
        const [rows]: any = await pool.query(
            'SELECT * FROM Category WHERE id = ?',
            [currentId]
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

export const getCategoryAncestors = async (id: number) => {
    const chain: any[] = [];
    let currentId: number | null = id;
    while (currentId !== null) {
        const [rows]: any = await pool.query(
            'SELECT id, name, parentCategoryId FROM Category WHERE id = ?',
            [currentId]
        );
        if (!rows[0]) break;
        chain.unshift(rows[0]);
        currentId = rows[0].parentCategoryId;
    }
    return {
        l1: chain[0] ? { id: chain[0].id, name: chain[0].name } : null,
        l2: chain[1] ? { id: chain[1].id, name: chain[1].name } : null,
        l3: chain[2] ? { id: chain[2].id, name: chain[2].name } : null,
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
export const searchL3CategoriesByName = async (query: string) => {
    const [rows]: any = await pool.query(
        `SELECT c3.id, c3.name,
                c2.name AS l2Name,
                c1.name AS l1Name
         FROM Category c3
         JOIN Category c2 ON c2.id = c3.parentCategoryId
         JOIN Category c1 ON c1.id = c2.parentCategoryId
         WHERE c3.name LIKE ?
           AND c3.isHidden = 0 AND c2.isHidden = 0 AND c1.isHidden = 0
         ORDER BY c3.name
         LIMIT 20`,
        [`%${query}%`]
    );

    return rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        path: `${r.l1Name} > ${r.l2Name} > ${r.name}`,
    }));
};