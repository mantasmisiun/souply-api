import pool from '../config/db';

export const createBasketItem = async (
    basketId: number,
    productId: number,
    quantity: number
) => {
    const [result]: any = await pool.query(
        'INSERT INTO BasketItem (basketId, productId, quantity) VALUES (?, ?, ?)',
        [basketId, productId, quantity]
    );
    return result.insertId;
};

export const getBasketItemsByBasketId = async (basketId: number) => {
    const [rows]: any = await pool.query(
        `SELECT BasketItem.*, Product.name AS productName 
         FROM BasketItem 
         JOIN Product ON BasketItem.productId = Product.id
         WHERE BasketItem.basketId = ?`,
        [basketId]
    );
    return rows;
};

export const updateBasketItemQuantity = async (
    id: number,
    quantity: number
) => {
    await pool.query(
        'UPDATE BasketItem SET quantity = ? WHERE id = ?',    
        [quantity, id]
    );
};

export const deleteBasketItem = async (id: number) => {
    await pool.query('DELETE FROM BasketItem WHERE id = ?', [id]);
};