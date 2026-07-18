import pool from '../config/db.js';

/**
 * Souply 2.0 households (Phase 1c). ONE household per user — enforced by
 * HouseholdMember's PRIMARY KEY(userId), not by application checks. Each
 * household owns AT MOST one shared basket (UNIQUE Basket.householdId): the
 * persistent container trips pull items from; it never completes.
 */

export interface HouseholdRow {
    id: number;
    createdByUserId: string;
    name: string | null;
    createdAt: string;
}

/** Create a household + owner membership + the shared basket, atomically. */
export const createHousehold = async (userId: string, name: string | null): Promise<{ householdId: number; sharedBasketId: number }> => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [h]: any = await conn.query(
            'INSERT INTO Household (createdByUserId, name) VALUES (?, ?)', [userId, name]);
        const householdId = h.insertId as number;
        // PRIMARY KEY(userId) throws ER_DUP_ENTRY if the user already has a
        // household — the controller maps that to the "leave first" 409.
        await conn.query(
            "INSERT INTO HouseholdMember (userId, householdId, role) VALUES (?, ?, 'owner')",
            [userId, householdId]);
        const [b]: any = await conn.query(
            "INSERT INTO Basket (userId, status, householdId) VALUES (?, 'draft', ?)",
            [userId, householdId]);
        await conn.commit();
        return { householdId, sharedBasketId: b.insertId as number };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
};

export const getHouseholdForUser = async (userId: string): Promise<(HouseholdRow & { role: string; sharedBasketId: number | null }) | null> => {
    const [rows]: any = await pool.query(
        `SELECT h.*, hm.role,
                (SELECT b.id FROM Basket b WHERE b.householdId = h.id LIMIT 1) AS sharedBasketId
         FROM HouseholdMember hm
         JOIN Household h ON h.id = hm.householdId
         WHERE hm.userId = ?`,
        [userId]);
    return rows[0] ?? null;
};

export const getHouseholdMembers = async (householdId: number): Promise<{ userId: string; role: string; joinedAt: string }[]> => {
    const [rows]: any = await pool.query(
        'SELECT userId, role, joinedAt FROM HouseholdMember WHERE householdId = ? ORDER BY joinedAt',
        [householdId]);
    return rows;
};

export const isHouseholdMember = async (householdId: number, userId: string): Promise<boolean> => {
    const [rows]: any = await pool.query(
        'SELECT 1 FROM HouseholdMember WHERE householdId = ? AND userId = ? LIMIT 1',
        [householdId, userId]);
    return rows.length > 0;
};

export const joinHousehold = async (householdId: number, userId: string): Promise<void> => {
    await pool.query(
        "INSERT INTO HouseholdMember (userId, householdId, role) VALUES (?, ?, 'member')",
        [userId, householdId]);
};


/** Owner-only member removal. Returns false when the caller isn't the owner,
 *  the target isn't a member of the caller's household, or the target IS the
 *  owner (owners leave via leaveHousehold, never get removed). */
export const removeMemberFromHousehold = async (ownerUserId: string, memberUserId: string): Promise<boolean> => {
    if (ownerUserId === memberUserId) return false;
    const own = await getHouseholdForUser(ownerUserId);
    if (!own || own.role !== 'owner') return false;
    const [result]: any = await pool.query(
        "DELETE FROM HouseholdMember WHERE householdId = ? AND userId = ? AND role <> 'owner'",
        [own.id, memberUserId]);
    return result.affectedRows > 0;
};

/** Leave; when the LAST member leaves, the household + its shared basket go too. */
export const leaveHousehold = async (userId: string): Promise<boolean> => {
    const current = await getHouseholdForUser(userId);
    if (!current) return false;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM HouseholdMember WHERE userId = ?', [userId]);
        const [left]: any = await conn.query(
            'SELECT COUNT(*) AS n FROM HouseholdMember WHERE householdId = ?', [current.id]);
        if (Number(left[0].n) === 0) {
            await conn.query('DELETE FROM BasketItem WHERE basketId IN (SELECT id FROM Basket WHERE householdId = ?)', [current.id]);
            await conn.query('DELETE FROM Basket WHERE householdId = ?', [current.id]);
            await conn.query('DELETE FROM Household WHERE id = ?', [current.id]);
        }
        await conn.commit();
        return true;
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
};
