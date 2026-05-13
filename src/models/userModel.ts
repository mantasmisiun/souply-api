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

/**
 * Throttled "last seen" stamp. The `WHERE … AND lastActiveAt < NOW() - INTERVAL 5 MINUTE`
 * clause makes the UPDATE match-but-no-op for the typical case (active
 * user already stamped within the last 5 minutes), so MySQL doesn't hold
 * the row's X-lock for the duration of the surrounding request handler
 * or, worse, the duration of an unrelated long-running transaction.
 *
 * This used to be an unconditional UPDATE called from every
 * `fetchUserProfile`, which serialised behind any concurrent transaction
 * holding the User row (e.g. `awardReceiptPoints` inside the receipt
 * save pipeline). Under batch uploads, profile fetches queued up and
 * blew the `innodb_lock_wait_timeout`.
 *
 * 5 minutes is a UX-safe granularity for "last active" tracking — fine
 * enough for analytics, coarse enough to eliminate the contention.
 */
export const updateLastActive = async (id: string) => {
    await pool.query(
        `UPDATE User
            SET lastActiveAt = NOW()
          WHERE id = ?
            AND (lastActiveAt IS NULL
                 OR lastActiveAt < NOW() - INTERVAL 5 MINUTE)`,
        [id],
    );
};

export const addPoints = async (id: string, delta: number, conn?: any) => {
    const db = conn ?? pool;
    await db.query('UPDATE User SET points = points + ? WHERE id = ?', [delta, id]);
};

export const getPoints = async (id: string): Promise<number> => {
    const [rows]: any = await pool.query('SELECT points FROM User WHERE id = ?', [id]);
    return rows[0]?.points ?? 0;
};