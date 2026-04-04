import pool from '../config/db';

//Create a new store chain
export const createStoreChain = async (name: string, logoUrl: string | null) => {
    const [result]: any = await pool.query(
        'INSERT INTO StoreChain (name, logoUrl) VALUES (?, ?)',
        [name, logoUrl]
    );
    return result.insertId;
};
//Get store chain by name for OCR matching
export const getStoreChainByName = async (name: string) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM StoreChain WHERE name = ?',
        [name]
    );
    return rows[0] || null;
};