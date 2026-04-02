import pool from '../config/db';

export const createStoreChain = async (name: string, logoUrl: string | null) => {
    const [result]: any = await pool.query(
        'INSERT INTO StoreChain (name, logoUrl) VALUES (?, ?)',
        [name, logoUrl]
    );
    return result.insertId;
};