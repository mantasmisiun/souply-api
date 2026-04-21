import pool from '../config/db.js';

export const createListItem = async (
    listId: number,
    productId: number,
    storeProductId: number | null,
    quantity: number,
    price: number | null = null
) => {
    const [result]: any = await pool.query(
        'INSERT INTO ShoppingListItem (listId, productId, storeProductId, quantity, price) VALUES (?, ?, ?, ?, ?)',
        [listId, productId, storeProductId, quantity, price]
    );
    return result.insertId;
};

export const getListItemsByShoppingListId = async (listId: number) => {
    const [rows]: any = await pool.query(
        `SELECT sli.*,
                COALESCE(sp.storeProductName, p.name) AS productName,
                p.imageUrl,
                sp.unit,
                sp.amount,
                sp.isWeighable
         FROM ShoppingListItem sli
         LEFT JOIN Product p ON sli.productId = p.id
         LEFT JOIN StoreProduct sp ON sli.storeProductId = sp.id
         WHERE sli.listId = ?
         ORDER BY sli.isChecked ASC, sli.id ASC`,
        [listId]
    );
    return rows.map((row: any) => ({
        ...row,
        isChecked: row.isChecked === 1,
        isWeighable: row.isWeighable === 1,
        quantity: parseFloat(row.quantity),
        price: row.price ? parseFloat(row.price) : null,
        unit: row.isWeighable ? 'kg' : 'vnt.',
        amount: row.amount ? parseFloat(row.amount) : null,
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
            'INSERT INTO ShoppingListItem (listId, productId, storeProductId, quantity, price) VALUES (?, ?, ?, ?, ?)',
            [newListId, item.productId, item.storeProductId, item.quantity, item.price]
        );
    }
};

export const checkAllItemsByListId = async (listId: number) => {
    await pool.query(
        'UPDATE ShoppingListItem SET isChecked = 1 WHERE listId = ?',
        [listId]
    );
};