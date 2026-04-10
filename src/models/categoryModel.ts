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

//Get all categories for category assignment
export const getAllCategories = async () => {
    const [categories]: any = await pool.query(
        'SELECT id, parentCategoryId, name FROM Category'
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