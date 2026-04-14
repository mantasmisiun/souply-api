import pool from '../config/db';

type Connection = typeof pool | any;

export const createProduct = async (
    categoryId: number,
    baseProductId: number | null,
    name: string,
    imageUrl: string | null,
    isWeighable: boolean,
    amount: number | null = null,
    unit: string | null = null,
    conn?: Connection
) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO Product (categoryId, baseProductId, name, imageUrl, isWeighable, amount, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [categoryId, baseProductId, name, imageUrl, isWeighable, amount, unit]
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

export const updateProductIsWeighable = async (storeProductId: number, isWeighable: boolean) => {
    await pool.query(
        `UPDATE Product p
         JOIN StoreProduct sp ON sp.productId = p.id
         SET p.isWeighable = ?
         WHERE sp.id = ?`,
        [isWeighable ? 1 : 0, storeProductId]
    );
};