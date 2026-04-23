import pool from '../config/db.js';
import type { Connection } from 'mysql2/promise';

export const addShoppingListMember = async (
    listId: number,
    userId: string,
    role: 'owner' | 'member',
    conn?: Connection
) => {
    const db = (conn ?? pool) as any;
    // INSERT IGNORE: claiming an already-claimed list (or re-adding an
    // existing owner) is a no-op rather than an error.
    await db.query(
        'INSERT IGNORE INTO ShoppingListMember (listId, userId, role) VALUES (?, ?, ?)',
        [listId, userId, role]
    );
};

export const isShoppingListMember = async (listId: number, userId: string): Promise<boolean> => {
    const [rows]: any = await pool.query(
        'SELECT 1 FROM ShoppingListMember WHERE listId = ? AND userId = ? LIMIT 1',
        [listId, userId]
    );
    return rows.length > 0;
};
