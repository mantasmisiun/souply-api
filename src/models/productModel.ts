import pool from '../config/db';

type Connection = typeof pool | any;

export const createProduct = async (
    categoryId: number,
    baseProductId: number | null,
    name: string,
    imageUrl: string | null,
    conn?: Connection
) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO Product (categoryId, baseProductId, name, imageUrl) VALUES (?, ?, ?, ?)',
        [categoryId, baseProductId, name, imageUrl]
    );
    return result.insertId;
};

export const searchProduct = async (query: string) => {
    const [products]: any = await pool.query(
        'SELECT * FROM Product WHERE name LIKE ?',
        [`%${query}%`]
    );
    return products;
};

export const getProductById = async (id: number) => {
    const [products]: any = await pool.query(
        'SELECT * FROM Product WHERE id = ?',
        [id]
    );
    return products[0] || null;
};

export const getProductsByCategory = async (categoryId: number) => {
    const [products]: any = await pool.query(
        'SELECT * FROM Product WHERE categoryId = ?',
        [categoryId]
    );
    return products;
};

export const getProductByName = async (name: string) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM Product WHERE name = ?',
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
        `SELECT p.id, p.name, p.imageUrl, p.categoryId,
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
        `SELECT p.id, p.name, p.imageUrl, p.categoryId,
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