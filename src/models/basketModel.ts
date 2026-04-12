import pool from '../config/db';

export const createBasket = async (userId: string) => {
    const [result]: any = await pool.query(
        'INSERT INTO Basket (userId) VALUES (?)',
        [userId]
    );
    return result.insertId;
};

export const getBasketsByUserId = async (userId: string) => {
    const [rows]: any = await pool.query(
        `SELECT * FROM Basket 
         WHERE userId = ?
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