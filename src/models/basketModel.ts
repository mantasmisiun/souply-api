import pool from '../config/db.js';

export const createBasket = async (userId: string) => {
    const [result]: any = await pool.query(
        'INSERT INTO Basket (userId) VALUES (?)',
        [userId]
    );
    return result.insertId;
};

/**
 * Return the user's current draft basket id, or null if they don't have
 * one. Used by POST /api/baskets to keep the endpoint idempotent: if a
 * draft already exists, we return its id instead of minting a new basket.
 * Backstops the frontend's in-flight-singleton guard (basketUtils.ts) so
 * no matter how racy the client, at most one draft basket exists per user
 * at any given time.
 */
export const getUserDraftBasketId = async (userId: string): Promise<number | null> => {
    const [rows]: any = await pool.query(
        `SELECT id FROM Basket
          WHERE userId = ? AND status = 'draft'
          ORDER BY updatedAt DESC
          LIMIT 1`,
        [userId]
    );
    return rows[0]?.id ?? null;
};

export const getBasketsByUserId = async (userId: string) => {
    const [rows]: any = await pool.query(
        `SELECT Basket.*, COUNT(BasketItem.id) as itemCount
         FROM Basket
         LEFT JOIN BasketItem ON Basket.id = BasketItem.basketId
         WHERE Basket.userId = ?
         GROUP BY Basket.id
         ORDER BY 
             FIELD(status, 'draft', 'compared', 'completed'),
             updatedAt DESC`,
        [userId]
    );
    return rows;
};

export const getBasketById = async (id: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM Basket WHERE id = ?',
        [id]
    );
    return rows[0] || null;
};

export const updateBasketUpdatedAt = async (id: number) => {
    await pool.query('UPDATE Basket SET updatedAt = NOW() WHERE id = ?', [id]);
};

export const updateBasketStatus = async (id: number, status: string) => {
    await pool.query(
        'UPDATE Basket SET status = ? WHERE id = ?',
        [status, id]
    );
};

export const updateBasketName = async (id: number, name: string) => {
    await pool.query(
        'UPDATE Basket SET name = ? WHERE id = ?',
        [name, id]
    );
};

export const deleteBasket = async (id: number) => {
    await pool.query('DELETE FROM Basket WHERE id = ?', [id]);
};

//For basket price comparison, to get productIds and their details for items in the basket
export const getBasketProductIds = async (basketId: number) => {
    const [rows]: any = await pool.query(
        `SELECT bi.productId, bi.quantity, bi.matchMode, p.name
         FROM BasketItem bi
         JOIN Product p ON bi.productId = p.id
         WHERE bi.basketId = ?`,
        [basketId]
    );
    return rows;
};