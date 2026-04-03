import pool from '../config/db';

export const createListItem = async (
    listId: number,
    productId: number,
    quantity: number
) => {
    const [result]: any = await pool.query(
        'INSERT INTO ShoppingListItem (listId, productId, quantity) VALUES (?, ?, ?)',
        [listId, productId, quantity]
    );
    return result.insertId;
};

export const getListItemsByShoppingListId = async (listId: number) => {
    console.log('Fetching items for listId:', listId);
    const [rows]: any = await pool.query(
        `SELECT ShoppingListItem.*, Product.name AS productName 
         FROM ShoppingListItem 
         JOIN Product ON ShoppingListItem.productId = Product.id
         WHERE ShoppingListItem.listId = ?`,
        [listId]
    );
    return rows.map((row: any) => ({
    ...row,
    isChecked: row.isChecked === 1
    }));
};

export const updateListItemQuantity = async (
    id: number,
    quantity: number
) => {
    await pool.query(
        'UPDATE ShoppingListItem SET quantity = ? WHERE id = ?',    
        [quantity, id]
    );
};

export const toggleListItem = async (id: number, isChecked: boolean) => {
    await pool.query(
        'UPDATE ShoppingListItem SET isChecked = ? WHERE id = ?',
        [isChecked, id]
    );
};

export const deleteListItem = async (id: number) => {
    await pool.query('DELETE FROM ShoppingListItem WHERE id = ?', [id]);
};