import pool from '../config/db';

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

//Get all top level categories
export const getTopLevelCategories = async () => {
    const [categories]: any = await pool.query(
        'SELECT * FROM Category WHERE parentCategoryId IS NULL'
    );
    return categories;
};

//Get subcategories for based on parent categoryId
export const getSubCategories = async (parentCategoryId: number) => {
    const [categories]: any = await pool.query(
        'SELECT * FROM Category WHERE parentCategoryId = ?',
        [parentCategoryId]
    );
    return categories;
};
