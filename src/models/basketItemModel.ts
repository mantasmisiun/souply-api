import pool from '../config/db.js';

export type MatchMode = 'sku' | 'base';

export const createBasketItem = async (
    basketId: number,
    productId: number,
    quantity: number,
    matchMode: MatchMode = 'sku'
) => {
    const [result]: any = await pool.query(
        'INSERT INTO BasketItem (basketId, productId, quantity, matchMode) VALUES (?, ?, ?, ?)',
        [basketId, productId, quantity, matchMode]
    );
    return result.insertId;
};

export const getBasketItemById = async (id: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM BasketItem WHERE id = ?',
        [id]
    );
    return rows[0] || null;
};

export const getBasketItemsByBasketId = async (basketId: number) => {
    const [rows]: any = await pool.query(
        `SELECT BasketItem.id, BasketItem.basketId, BasketItem.productId,
                BasketItem.quantity, BasketItem.matchMode,
                Product.name AS productName,
                (SELECT JSON_ARRAYAGG(spi.imageUrl)
                 FROM StoreProduct spi
                 WHERE spi.productId = Product.id AND spi.imageUrl IS NOT NULL) AS imageUrls
         FROM BasketItem
         JOIN Product ON BasketItem.productId = Product.id
         WHERE BasketItem.basketId = ?`,
        [basketId]
    );
    return rows;
};

export const updateBasketItemQuantity = async (
    id: number,
    quantity: number
) => {
    await pool.query(
        'UPDATE BasketItem SET quantity = ? WHERE id = ?',    
        [quantity, id]
    );
};

export const deleteBasketItem = async (id: number) => {
    await pool.query('DELETE FROM BasketItem WHERE id = ?', [id]);
};

//Function to get a basket item by basketId and productId (used to check if item already exists in basket)
export const getBasketItemByBasketAndProduct = async (basketId: number, productId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM BasketItem WHERE basketId = ? AND productId = ?',
        [basketId, productId]
    );
    return rows[0] || null;
};

/**
 * Convert every BasketItem in a basket to the given matchMode.
 *
 * sku → base:
 *   Map each item's productId to its cluster head (COALESCE(baseProductId, id)).
 *   When multiple items map to the same head, merge them — keep the lowest
 *   id, sum quantities, delete the rest. Result: one row per cluster,
 *   pointing at the head, with matchMode='base'.
 *
 * base → sku:
 *   productId in base mode already points to the cluster head, which is a
 *   legitimate Product. Just flip matchMode='sku' in place. No productId
 *   changes, no dedup needed.
 *
 * Runs inside a transaction so a partial conversion never lands — all or
 * nothing. Returns counts so the caller can log/surface what happened.
 */
export const convertBasketItemsMode = async (
    basketId: number,
    targetMode: MatchMode
): Promise<{ converted: number; merged: number }> => {
    const conn = await (pool as any).getConnection();
    try {
        await conn.beginTransaction();

        if (targetMode === 'sku') {
            const [res]: any = await conn.query(
                `UPDATE BasketItem SET matchMode = 'sku' WHERE basketId = ?`,
                [basketId]
            );
            await conn.commit();
            return { converted: res.affectedRows as number, merged: 0 };
        }

        // sku → base: fetch items + each's cluster head id in one JOIN.
        const [items]: any = await conn.query(
            `SELECT bi.id, bi.productId, bi.quantity,
                    COALESCE(p.baseProductId, p.id) AS headId
               FROM BasketItem bi
               JOIN Product p ON p.id = bi.productId
              WHERE bi.basketId = ?
              ORDER BY bi.id ASC`,
            [basketId]
        );

        // Group by headId. Keep earliest-id item per group, sum quantities.
        const groups = new Map<number, { keepId: number; qty: number; extraIds: number[] }>();
        for (const it of items as any[]) {
            const headId = Number(it.headId);
            const qty = parseFloat(String(it.quantity));
            const itemId = Number(it.id);
            const g = groups.get(headId);
            if (!g) {
                groups.set(headId, { keepId: itemId, qty, extraIds: [] });
            } else {
                g.qty += qty;
                g.extraIds.push(itemId);
            }
        }

        let converted = 0;
        let merged = 0;
        for (const [headId, g] of groups) {
            await conn.query(
                `UPDATE BasketItem
                    SET productId = ?, matchMode = 'base', quantity = ?
                  WHERE id = ?`,
                [headId, g.qty, g.keepId]
            );
            converted++;
            if (g.extraIds.length > 0) {
                await conn.query(
                    `DELETE FROM BasketItem WHERE id IN (?)`,
                    [g.extraIds]
                );
                merged += g.extraIds.length;
            }
        }

        await conn.commit();
        return { converted, merged };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
};