import pool from '../config/db';

type Connection = typeof pool | any;

export const createProduct = async (
    categoryId: number,
    baseProductId: number | null,
    name: string,
    imageUrl: string | null,
    isWeighable: boolean,
    conn?: Connection
) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO Product (categoryId, baseProductId, name, imageUrl, isWeighable) VALUES (?, ?, ?, ?, ?)',
        [categoryId, baseProductId, name, imageUrl, isWeighable]
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