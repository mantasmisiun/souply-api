import pool from '../config/db.js';
import type { Connection } from 'mysql2/promise';

export const createListItem = async (
    listId: number,
    productId: number | null,
    storeProductId: number | null,
    quantity: number,
    price: number | null = null,
    customName: string | null = null,
    isWeighable: boolean = false,
    conn?: Connection
) => {
    const db = (conn ?? pool) as any;
    const [result]: any = await db.query(
        'INSERT INTO ShoppingListItem (listId, productId, storeProductId, quantity, price, customName, isWeighable) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [listId, productId, storeProductId, quantity, price, customName, isWeighable ? 1 : 0]
    );
    return result.insertId;
};

/**
 * Batch insert. Used by the atomic-create endpoint and the duplicate-list
 * path to avoid N+1 INSERTs over HTTP. Runs inside the caller's transaction
 * if one is provided; otherwise opens its own.
 */
export const createListItemsBatch = async (
    listId: number,
    items: Array<{
        productId: number | null;
        storeProductId: number | null;
        quantity: number;
        price: number | null;
    }>,
    conn?: Connection
): Promise<number> => {
    if (items.length === 0) return 0;
    const db = (conn ?? pool) as any;
    const values = items.map(it => [
        listId,
        it.productId,
        it.storeProductId,
        it.quantity,
        it.price,
    ]);
    const [res]: any = await db.query(
        `INSERT INTO ShoppingListItem
            (listId, productId, storeProductId, quantity, price)
         VALUES ?`,
        [values]
    );
    return res.affectedRows as number;
};

export const getListItemsByShoppingListId = async (listId: number) => {
    // Ordering:
    //   1. unchecked first (isChecked ASC)
    //   2. alphabetically by resolved name within each bucket — stable
    //      for manual (null productId) items too, which previously sat
    //      wherever their insertion id placed them.
    //
    // Category chain joined in for the future group-by-aisle feature —
    // frontend can ignore these fields today.
    const [rows]: any = await pool.query(
        `SELECT sli.*,
                COALESCE(sp.storeProductName, p.name, sli.customName) AS productName,
                (SELECT JSON_ARRAYAGG(spi.imageUrl)
                 FROM StoreProduct spi
                 WHERE spi.productId = COALESCE(sp.productId, sli.productId, p.id)
                   AND spi.imageUrl IS NOT NULL) AS imageUrls,
                sp.unit,
                sp.amount,
                -- Weighable is a property of the PRODUCT, not the list row. The
                -- sli.isWeighable column is NOT NULL DEFAULT 0, so it can't be
                -- the first COALESCE arg or it shadows the real flag for every
                -- basket-created item. Resolve from: the exact store product →
                -- any store product of the product (covers substitutions with a
                -- null storeProductId) → an explicitly-set custom-item flag → 0.
                COALESCE(
                    sp.isWeighable,
                    (SELECT MAX(spi.isWeighable) FROM StoreProduct spi
                      WHERE spi.productId = COALESCE(sp.productId, sli.productId, p.id)),
                    NULLIF(sli.isWeighable, 0),
                    0
                ) AS isWeighable,
                c3.id   AS l3CategoryId,
                c3.name AS l3CategoryName,
                c2.id   AS l2CategoryId,
                c2.name AS l2CategoryName,
                c1.id   AS l1CategoryId,
                (SELECT CONCAT('-', ROUND((1 - pr.promoPrice / pr.price) * 100), '%')
                 FROM Price pr
                 WHERE pr.storeProductId = sli.storeProductId
                   AND pr.requiresCoupon = 1
                   AND pr.promoEnd IS NOT NULL AND pr.promoEnd > NOW()
                   AND pr.price > 0 AND pr.promoPrice > 0
                 ORDER BY pr.date DESC LIMIT 1) AS couponLabel
         FROM ShoppingListItem sli
         LEFT JOIN Product p ON sli.productId = p.id
         LEFT JOIN StoreProduct sp ON sli.storeProductId = sp.id
         LEFT JOIN Category c3 ON p.categoryId = c3.id
         LEFT JOIN Category c2 ON c3.parentCategoryId = c2.id
         LEFT JOIN Category c1 ON c2.parentCategoryId = c1.id
         WHERE sli.listId = ?
         ORDER BY sli.isChecked ASC,
                  COALESCE(sp.storeProductName, p.name, sli.customName, '') ASC,
                  sli.id ASC`,
        [listId]
    );
    return rows.map((row: any) => ({
        ...row,
        isChecked: row.isChecked === 1,
        isWeighable: row.isWeighable === 1,
        quantity: parseFloat(row.quantity),
        price: row.price ? parseFloat(row.price) : null,
        // Preserve the store product's pack unit (l/ml/g/…) for the app's
        // "N × 500 ml" render — fall back to vnt. only when the row has no SP
        // unit. Weighables stay 'kg': their display path measures, not packs.
        unit: row.isWeighable ? 'kg' : (row.unit ?? 'vnt.'),
        amount: row.amount ? parseFloat(row.amount) : null,
        requiresCoupon: row.couponLabel != null,
        couponLabel: row.couponLabel ?? null,
    }));
};

export const updateListItemQuantity = async (id: number, quantity: number) => {
    await pool.query(
        'UPDATE ShoppingListItem SET quantity = ? WHERE id = ?',
        [quantity, id]
    );
};

export const toggleListItem = async (id: number, isChecked: boolean) => {
    await pool.query(
        'UPDATE ShoppingListItem SET isChecked = ? WHERE id = ?',
        [isChecked, id]
    );
};

export const deleteListItem = async (id: number) => {
    await pool.query('DELETE FROM ShoppingListItem WHERE id = ?', [id]);
};

export const getListItemById = async (id: number) => {
    const [rows]: any = await pool.query(
        'SELECT id, listId, productId FROM ShoppingListItem WHERE id = ? LIMIT 1',
        [id],
    );
    return rows[0] || null;
};

export const getListItemByListAndProduct = async (listId: number, productId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM ShoppingListItem WHERE listId = ? AND productId = ?',
        [listId, productId]
    );
    return rows[0] || null;
};

export const duplicateListItems = async (originalListId: number, newListId: number): Promise<void> => {
    const [rows]: any = await pool.query(
        'SELECT productId, storeProductId, quantity, price FROM ShoppingListItem WHERE listId = ?',
        [originalListId]
    );
    if (rows.length === 0) return;
    await createListItemsBatch(newListId, rows);
};

export const checkAllItemsByListId = async (listId: number) => {
    await pool.query(
        'UPDATE ShoppingListItem SET isChecked = 1 WHERE listId = ?',
        [listId]
    );
};