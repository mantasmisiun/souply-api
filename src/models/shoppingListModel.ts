import pool from '../config/db.js';
import type { Connection } from 'mysql2/promise';

export const createShoppingList = async (
    userId: string,
    storeId: number,
    basketId?: number | null,
    conn?: Connection
) => {
    const db = (conn ?? pool) as any;
    const [result]: any = await db.query(
        'INSERT INTO ShoppingList (userId, storeId, status, basketId) VALUES (?, ?, "active", ?)',
        [userId, storeId, basketId ?? null]
    );
    return result.insertId;
};

/**
 * Find an existing ShoppingList for this basketId — used to block
 * duplicate list creation against the same basket. Returns null if none
 * (the expected state before creating a new list). Thanks to the
 * UNIQUE(basketId) constraint this is effectively redundant for NULL-
 * basketId rows but still useful as a friendly pre-check that returns a
 * 409 instead of a raw SQL error.
 */
export const getShoppingListByBasketId = async (basketId: number): Promise<any | null> => {
    const [rows]: any = await pool.query(
        'SELECT * FROM ShoppingList WHERE basketId = ? LIMIT 1',
        [basketId]
    );
    return rows[0] || null;
};

/** Find an existing list for this basket+store pair — used for split combo duplicate guard. */
export const getShoppingListByBasketAndStore = async (basketId: number, storeId: number): Promise<any | null> => {
    const [rows]: any = await pool.query(
        'SELECT * FROM ShoppingList WHERE basketId = ? AND storeId = ? LIMIT 1',
        [basketId, storeId]
    );
    return rows[0] || null;
};

export const getShoppingListsByUserId = async (userId: string) => {
    // A user sees a list if they created it OR they're a member of it
    // (from claiming a share QR). Inner JOIN on ShoppingListMember —
    // since every list gets an owner row at creation time (see
    // backfill migration + addShoppingList controller), the join never
    // drops legitimate rows and de-duplicates on GROUP BY.
    const [rows]: any = await pool.query(
        `SELECT ShoppingList.*, Store.address, Store.name AS storeName,
                Store.chainId AS chainId,
                StoreChain.name AS chainName, StoreChain.logoUrl,
                COUNT(ShoppingListItem.id) AS itemCount,
                SUM(CASE WHEN ShoppingListItem.isChecked = 1 THEN 1 ELSE 0 END) AS checkedCount,
                (SELECT COUNT(*) FROM Receipt r WHERE r.shoppingListId = ShoppingList.id) AS receiptCount
         FROM ShoppingList
         JOIN Store ON ShoppingList.storeId = Store.id
         JOIN StoreChain ON Store.chainId = StoreChain.id
         JOIN ShoppingListMember slm ON slm.listId = ShoppingList.id AND slm.userId = ?
         LEFT JOIN ShoppingListItem ON ShoppingList.id = ShoppingListItem.listId
         GROUP BY ShoppingList.id
         ORDER BY ShoppingList.createdAt DESC`,
        [userId]
    );
    return rows;
};

export const getShoppingListById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT ShoppingList.*, Store.name AS storeName, Store.address,
                StoreChain.id AS chainId, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM ShoppingList
         JOIN Store ON ShoppingList.storeId = Store.id
         JOIN StoreChain ON Store.chainId = StoreChain.id
         WHERE ShoppingList.id = ?`,
        [id]
    );
    return rows[0] || null;
};

export const updateShoppingListStatus = async (id: number, status: string) => {
    await pool.query(
        'UPDATE ShoppingList SET status = ? WHERE id = ?',
        [status, id]
    );
};

/**
 * Link a receipt to a list row (the store trip it covers) by setting
 * Receipt.shoppingListId. Used by the upload flow and the duplicate-link path
 * (a re-photographed receipt already in the DB is pointed at the list instead
 * of inserting a new row).
 */
export const linkReceiptToList = async (receiptId: number, listId: number) => {
    await pool.query('UPDATE Receipt SET shoppingListId = ? WHERE id = ?', [listId, receiptId]);
};

/**
 * Count of the user's "awaiting receipt" list groups for the List-tab badge: a
 * completed list row with no Receipt pointing at it. Grouped by basketId so a
 * 2/3-store split counts once until all its stores' receipts are in; standalone
 * single-store lists (no basketId) count per row.
 */
export const countListsAwaitingReceipt = async (userId: string): Promise<number> => {
    const [rows]: any = await pool.query(
        `SELECT COUNT(*) AS cnt FROM (
            SELECT COALESCE(sl.basketId, -sl.id) AS grp
            FROM ShoppingList sl
            JOIN ShoppingListMember slm ON slm.listId = sl.id AND slm.userId = ?
            WHERE sl.status = 'completed'
              AND NOT EXISTS (SELECT 1 FROM Receipt r WHERE r.shoppingListId = sl.id)
            GROUP BY grp
         ) g`,
        [userId],
    );
    return Number(rows[0]?.cnt ?? 0);
};

export const deleteShoppingList = async (id: number) => {
    await pool.query('DELETE FROM ShoppingList WHERE id = ?', [id]);
};

export const duplicateShoppingList = async (id: number, userId: string): Promise<number> => {
    const original = await getShoppingListById(id);
    if (!original) throw new Error('Shopping list not found');

    const newId = await createShoppingList(userId, original.storeId);
    return newId;
};

/** True when EVERY list of the basket is completed — the basket (trip) is only
 *  terminal when the whole split is done, not when its first store finishes. */
export const allBasketListsCompleted = async (basketId: number): Promise<boolean> => {
    const [rows]: any = await pool.query(
        'SELECT COUNT(*) AS open FROM ShoppingList WHERE basketId = ? AND status <> "completed"',
        [basketId]
    );
    return Number(rows[0]?.open ?? 0) === 0;
};

export const getBasketIdByListId = async (listId: number): Promise<number | null> => {
    const [rows]: any = await pool.query(
        'SELECT basketId FROM ShoppingList WHERE id = ?',
        [listId]
    );
    return rows[0]?.basketId || null;
};

export const updateShoppingListBasket = async (listId: number, basketId: number) => {
    await pool.query('UPDATE ShoppingList SET basketId = ? WHERE id = ?', [basketId, listId]);
};

export const getListOwnerUserId = async (listId: number): Promise<string | null> => {
    const [rows]: any = await pool.query(
        'SELECT userId FROM ShoppingList WHERE id = ? LIMIT 1',
        [listId],
    );
    return rows[0]?.userId ?? null;
};