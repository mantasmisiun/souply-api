import pool from '../config/db.js';

export const createUser = async (id: string) => {
    // INSERT IGNORE so a device that repeats its first-launch sync on every
    // cold start (or after a network retry) doesn't fail — the row is either
    // created now or already there from a prior call. Idempotency matters
    // because every FK reference to User.id depends on this row existing,
    // so we can't afford to leave the client in a state where it thinks the
    // user is registered when the first INSERT silently failed.
    await pool.query('INSERT IGNORE INTO User (id) VALUES (?)', [id]);
    return id;
};

export const getUserById = async (id: string) => {
    const [rows]: any = await pool.query('SELECT * FROM User WHERE id = ?', [id]);
    return rows[0] || null;
};

export const updateLastActive = async (id: string) => {
    await pool.query('UPDATE User SET lastActiveAt = NOW() WHERE id = ?', [id]);
};