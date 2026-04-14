import pool from '../config/db';

export const createListItem = async (
    listId: number,
    productId: number | null,
    quantity: number,
    price: number | null = null,
    customName: string | null = null
) => {
    const [result]: any = await pool.query(
        'INSERT INTO ShoppingListItem (listId, productId, quantity, price, customName) VALUES (?, ?, ?, ?, ?)',
        [listId, productId, quantity, price, customName]
    );
    return result.insertId;
};

export const getListItemsByShoppingListId = async (listId: number) => {
    const [rows]: any = await pool.query(
        `SELECT ShoppingListItem.*,
                COALESCE(Product.name, ShoppingListItem.customName) AS productName,
                Product.isWeighable,
                Product.imageUrl
         FROM ShoppingListItem
         LEFT JOIN Product ON ShoppingListItem.productId = Product.id
         WHERE ShoppingListItem.listId = ?
         ORDER BY ShoppingListItem.isChecked ASC, ShoppingListItem.id ASC`,
        [listId]
    );
    return rows.map((row: any) => ({
        ...row,
        isChecked: row.isChecked === 1,
        isWeighable: row.isWeighable === 1,
        quantity: parseFloat(row.quantity),
        price: row.price ? parseFloat(row.price) : null,
    }));
};

export const updateListItemQuantity = async (id: number, quantity: number) => {
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

export const getListItemByListAndProduct = async (listId: number, productId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM ShoppingListItem WHERE listId = ? AND productId = ?',
        [listId, productId]
    );
    return rows[0] || null;
};

export const duplicateListItems = async (originalListId: number, newListId: number): Promise<void> => {
    const [rows]: any = await pool.query(
        'SELECT * FROM ShoppingListItem WHERE listId = ?',
        [originalListId]
    );
    for (const item of rows) {
        await pool.query(
            'INSERT INTO ShoppingListItem (listId, productId, quantity, price, customName) VALUES (?, ?, ?, ?, ?)',
            [newListId, item.productId, item.quantity, item.price, item.customName]
        );
    }
};

export const checkAllItemsByListId = async (listId: number) => {
    await pool.query(
        'UPDATE ShoppingListItem SET isChecked = 1 WHERE listId = ?',
        [listId]
    );
};