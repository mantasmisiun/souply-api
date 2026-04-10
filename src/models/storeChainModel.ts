import pool from '../config/db';

type Connection = typeof pool | any;

export const createStoreChain = async (name: string, logoUrl: string | null, conn?: Connection) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO StoreChain (name, logoUrl) VALUES (?, ?)',
        [name, logoUrl]
    );
    return result.insertId;
};

export const getStoreChainByName = async (name: string, conn?: Connection) => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        'SELECT * FROM StoreChain WHERE name = ?',
        [name]
    );
    return rows[0] || null;
};