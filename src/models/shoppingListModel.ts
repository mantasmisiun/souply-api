import pool from '../config/db.js';

export const createShoppingList = async (userId: string, storeId: number, basketId?: number) => {
    const [result]: any = await pool.query(
        'INSERT INTO ShoppingList (userId, storeId, status, basketId) VALUES (?, ?, "active", ?)',
        [userId, storeId, basketId || null]
    );
    return result.insertId;
};

export const getShoppingListsByUserId = async (userId: string) => {
    const [rows]: any = await pool.query(
        `SELECT ShoppingList.*, Store.address, Store.name AS storeName,
                StoreChain.name AS chainName, StoreChain.logoUrl,
                COUNT(ShoppingListItem.id) AS itemCount,
                SUM(CASE WHEN ShoppingListItem.isChecked = 1 THEN 1 ELSE 0 END) AS checkedCount
         FROM ShoppingList
         JOIN Store ON ShoppingList.storeId = Store.id
         JOIN StoreChain ON Store.chainId = StoreChain.id
         LEFT JOIN ShoppingListItem ON ShoppingList.id = ShoppingListItem.listId
         WHERE ShoppingList.userId = ?
         GROUP BY ShoppingList.id
         ORDER BY ShoppingList.createdAt DESC`,
        [userId]
    );
    return rows;
};

export const getShoppingListById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT ShoppingList.*, Store.name AS storeName, Store.address,
                StoreChain.id AS chainId, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM ShoppingList
         JOIN Store ON ShoppingList.storeId = Store.id
         JOIN StoreChain ON Store.chainId = StoreChain.id
         WHERE ShoppingList.id = ?`,
        [id]
    );
    return rows[0] || null;
};

export const updateShoppingListStatus = async (id: number, status: string) => {
    await pool.query(
        'UPDATE ShoppingList SET status = ? WHERE id = ?',
        [status, id]
    );
};

export const deleteShoppingList = async (id: number) => {
    await pool.query('DELETE FROM ShoppingList WHERE id = ?', [id]);
};

export const duplicateShoppingList = async (id: number, userId: string): Promise<number> => {
    const original = await getShoppingListById(id);
    if (!original) throw new Error('Shopping list not found');

    const newId = await createShoppingList(userId, original.storeId);
    return newId;
};

export const getBasketIdByListId = async (listId: number): Promise<number | null> => {
    const [rows]: any = await pool.query(
        'SELECT basketId FROM ShoppingList WHERE id = ?',
        [listId]
    );
    return rows[0]?.basketId || null;
};

export const updateShoppingListBasket = async (listId: number, basketId: number) => {
    await pool.query('UPDATE ShoppingList SET basketId = ? WHERE id = ?', [basketId, listId]);
};