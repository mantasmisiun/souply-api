import pool from '../config/db';

// Function to create a new product
export const createProduct = async (
    categoryId: number,
    baseProductId: number | null,
    name: string,
    imageUrl: string | null
) => {
    const [result]: any = await pool.query(
        'INSERT INTO Product (categoryId, baseProductId, name, imageUrl) VALUES (?, ?, ?, ?)',
        [categoryId, baseProductId, name, imageUrl]
    );
    return result.insertId;
};

// Function to search for products by name
export const searchProduct = async (query: string) => {
    const [products]: any = await pool.query(
        'SELECT * FROM Product WHERE name LIKE ?',
        [`%${query}%`]
    );
    return products;
};

//FUnction to get a product by ID
export const getProductById = async (id: number) => {
    const [products]: any = await pool.query(
        'SELECT * FROM Product WHERE id = ?',
        [id]
    );
    return products[0] || null;
};

// Function to get all products in a category
export const getProductsByCategory = async (categoryId: number) => {
    const [products]: any = await pool.query(
        'SELECT * FROM Product WHERE categoryId = ?',
        [categoryId]
    );
    return products;
};