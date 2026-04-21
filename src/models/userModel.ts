import pool from '../config/db.js';

export const createUser = async (id: string) => {
    await pool.query('INSERT INTO User (id) VALUES (?)', [id]);
    return id;
};

export const getUserById = async (id: string) => {
    const [rows]: any = await pool.query('SELECT * FROM User WHERE id = ?', [id]);
    return rows[0] || null;
};

export const updateLastActive = async (id: string) => {
    await pool.query('UPDATE User SET lastActiveAt = NOW() WHERE id = ?', [id]);
};