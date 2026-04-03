import pool from '../config/db';

export const createShoppingList = async (
    userId: string,
    storeId: number,
) => {
    const [result]: any = await pool.query(
        'INSERT INTO ShoppingList (userId, storeId) VALUES (?, ?)',
        [userId, storeId]
    );
    return result.insertId;
};

export const getShoppingListsByUserId = async (userId: string) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM ShoppingList WHERE userId = ?',
        [userId]
    );
    return rows;
};

export const getShoppingListById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT ShoppingList.*, Store.name AS storeName, Store.address,
                StoreChain.name AS chainName, StoreChain.logoUrl
         FROM ShoppingList
         JOIN Store ON ShoppingList.storeId = Store.id
         JOIN StoreChain ON Store.chainId = StoreChain.id
         WHERE ShoppingList.id = ?`,
        [id]
    );
    return rows[0] || null;
};

export const deleteShoppingList = async (id: number) => {
    await pool.query('DELETE FROM ShoppingList WHERE id = ?', [id]);
};