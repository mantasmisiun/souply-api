import pool from '../config/db.js';
import type { Connection } from 'mysql2/promise';

export const createBasket = async (userId: string, sourceTemplateId: number | null = null, conn?: Connection) => {
    const db = (conn ?? pool) as any;
    const [result]: any = await db.query(
        'INSERT INTO Basket (userId, sourceTemplateId) VALUES (?, ?)',
        [userId, sourceTemplateId]
    );
    return result.insertId;
};

/**
 * Find the user's most recent non-completed basket that was spawned from
 * the given template AND is not abandoned. Abandonment is the conjunction
 * of "never calculated" + "never user-edited" — both flags need to flip
 * for a basket to count as meaningfully in-progress.
 *
 * Returns null when nothing matches; the instantiate endpoint then prunes
 * any abandoned instance and creates a fresh one.
 */
export const findActiveBasketFromTemplate = async (
    userId: string,
    templateId: number,
): Promise<any | null> => {
    const [rows]: any = await pool.query(
        `SELECT * FROM Basket
          WHERE userId = ?
            AND sourceTemplateId = ?
            AND status <> 'completed'
            AND (hasBeenCalculated = 1 OR userEditedAfterCreation = 1)
          ORDER BY updatedAt DESC
          LIMIT 1`,
        [userId, templateId],
    );
    return rows[0] ?? null;
};

/**
 * Find any abandoned basket(s) the user owns from the given template —
 * status != completed, never calculated, never edited. These can be
 * deleted before creating a fresh instance because there's nothing
 * meaningful to resume.
 */
export const findAbandonedBasketsFromTemplate = async (
    userId: string,
    templateId: number,
): Promise<number[]> => {
    const [rows]: any = await pool.query(
        `SELECT id FROM Basket
          WHERE userId = ?
            AND sourceTemplateId = ?
            AND status <> 'completed'
            AND hasBeenCalculated = 0
            AND userEditedAfterCreation = 0`,
        [userId, templateId],
    );
    return rows.map((r: any) => r.id as number);
};

/**
 * Flip the "calculated at least once" flag — called by the calculate
 * endpoint. Stays 1 even after revert; the flag tracks lifetime fact,
 * not current status.
 */
export const markBasketCalculated = async (id: number, conn?: Connection) => {
    const db = (conn ?? pool) as any;
    await db.query(
        `UPDATE Basket SET hasBeenCalculated = 1 WHERE id = ? AND hasBeenCalculated = 0`,
        [id],
    );
};

/**
 * Persist the cheapest store's total from the most recent comparison
 * run. Drives the "nuo €X" line on Krepselis cards for compared
 * baskets without forcing the list endpoint to re-run the comparison
 * engine. Pass null to clear (e.g. on revert).
 */
export const updateBasketCheapestTotal = async (
    id: number,
    cheapest: number | null,
    conn?: Connection,
) => {
    const db = (conn ?? pool) as any;
    await db.query(
        `UPDATE Basket SET cheapestTotal = ? WHERE id = ?`,
        [cheapest, id],
    );
};

/**
 * Flip the "user-edited after creation" flag — called by basket item
 * add/update/delete. The guard `WHERE userEditedAfterCreation = 0`
 * keeps repeated edits as cheap no-op writes.
 */
export const markBasketUserEdited = async (id: number, conn?: Connection) => {
    const db = (conn ?? pool) as any;
    await db.query(
        `UPDATE Basket SET userEditedAfterCreation = 1 WHERE id = ? AND userEditedAfterCreation = 0`,
        [id],
    );
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
    // Pull the selected-store total for inProgress / completed baskets so
    // the Krepselis card can show what the user actually spent at their
    // chosen shop. `cheapestTotal` is the persisted result of the most
    // recent comparison run — drives the "nuo €X" line on compared
    // baskets. Both are correlated subqueries / direct columns to keep
    // the GROUP BY trivial.
    const [rows]: any = await pool.query(
        `SELECT Basket.*,
                COUNT(BasketItem.id) as itemCount,
                (SELECT ROUND(SUM(sli.price * sli.quantity), 2)
                   FROM ShoppingList sl
                   JOIN ShoppingListItem sli ON sli.listId = sl.id
                  WHERE sl.basketId = Basket.id
                    AND sli.price IS NOT NULL) AS selectedStoreTotal,
                t.coverColor   AS templateCoverColor,
                t.coverImage   AS templateCoverImage,
                u.username     AS templateCreatorHandle,
                t.name         AS templateName
         FROM Basket
         LEFT JOIN BasketItem ON Basket.id = BasketItem.basketId
         LEFT JOIN BasketTemplate t ON t.id = Basket.sourceTemplateId
         LEFT JOIN User u ON u.id = t.userId
         WHERE Basket.userId = ?
         GROUP BY Basket.id
         ORDER BY updatedAt DESC`,
        [userId]
    );
    return rows;
};

export const getBasketById = async (id: number) => {
    // Join the source template's cover identity + creator handle so the
    // basket inherits the emoji/colour strip and shows attribution. NULL for
    // manual baskets (no sourceTemplateId).
    const [rows]: any = await pool.query(
        `SELECT Basket.*,
                t.coverColor    AS templateCoverColor,
                t.coverImage    AS templateCoverImage,
                u.username      AS templateCreatorHandle,
                t.name          AS templateName
           FROM Basket
           LEFT JOIN BasketTemplate t ON t.id = Basket.sourceTemplateId
           LEFT JOIN User u ON u.id = t.userId
          WHERE Basket.id = ?`,
        [id]
    );
    return rows[0] || null;
};

export const updateBasketUpdatedAt = async (id: number) => {
    await pool.query('UPDATE Basket SET updatedAt = NOW() WHERE id = ?', [id]);
};

export const updateBasketStatus = async (id: number, status: string, conn?: Connection) => {
    // Caller may pass an open connection to keep the UPDATE inside their
    // transaction. Without this, the atomic shopping-list creation path
    // would insert a ShoppingList row (holding an FK shared lock on the
    // referenced Basket), then the separate pool.query UPDATE on the
    // same Basket row would wait forever for the original transaction to
    // release — a cross-connection deadlock that times out at 50s.
    const db = (conn ?? pool) as any;
    await db.query(
        'UPDATE Basket SET status = ? WHERE id = ?',
        [status, id]
    );
};

export const updateBasketSavedAmount = async (id: number, amount: number) => {
    await pool.query('UPDATE Basket SET savedAmount = ? WHERE id = ?', [amount, id]);
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
        `SELECT bi.productId, bi.quantity, bi.matchMode, bi.anchorAmount, bi.anchorUnit, p.name
         FROM BasketItem bi
         JOIN Product p ON bi.productId = p.id
         WHERE bi.basketId = ?`,
        [basketId]
    );
    return rows;
};