import pool from '../config/db.js';
import type { Connection } from 'mysql2/promise';

export const addShoppingListMember = async (
    listId: number,
    userId: string,
    role: 'owner' | 'member',
    conn?: Connection
) => {
    const db = (conn ?? pool) as any;
    // INSERT IGNORE: claiming an already-claimed list (or re-adding an
    // existing owner) is a no-op rather than an error.
    await db.query(
        'INSERT IGNORE INTO ShoppingListMember (listId, userId, role) VALUES (?, ?, ?)',
        [listId, userId, role]
    );
};

/**
 * List membership is trip-aware: a user may read/add/toggle a list if they are
 * an explicit ShoppingListMember (the list creator, or a legacy share-QR
 * claimer) OR a member of the TRIP that owns the list. Deriving from trip
 * membership is what keeps checkmarks in sync across everyone the trip was
 * shared with — no per-list backfill on join, and it holds whether the list
 * was created before or after a member joined. (The old share-QR flow was the
 * ONLY writer of ShoppingListMember rows for non-owners; once it was removed,
 * trip invitees had no membership at all without this join.)
 */
export const isShoppingListMember = async (listId: number, userId: string): Promise<boolean> => {
    const [rows]: any = await pool.query(
        `SELECT 1 FROM ShoppingList sl
           LEFT JOIN ShoppingListMember slm ON slm.listId = sl.id AND slm.userId = ?
           LEFT JOIN TripMember tm ON tm.tripId = sl.tripId AND tm.userId = ?
          WHERE sl.id = ? AND (slm.userId IS NOT NULL OR tm.userId IS NOT NULL)
          LIMIT 1`,
        [userId, userId, listId]
    );
    return rows.length > 0;
};
