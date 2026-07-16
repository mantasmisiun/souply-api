import pool from '../config/db.js';

export type InteractionType = 'basket_add' | 'list_add' | 'list_check' | 'receipt_buy';

const DECAY_DAYS = 90;

const WEIGHTED_SCORE_EXPR = `
    SUM(
        CASE pi.type
            WHEN 'receipt_buy' THEN 5
            WHEN 'list_check'  THEN 3
            WHEN 'basket_add'  THEN 2
            WHEN 'list_add'    THEN 1
        END * EXP(-DATEDIFF(NOW(), pi.createdAt) / ${DECAY_DAYS})
    )
`;

export const logInteraction = async (
    userId: string,
    productId: number,
    type: InteractionType,
): Promise<void> => {
    await pool.query(
        'INSERT INTO ProductInteraction (userId, productId, type) VALUES (?, ?, ?)',
        [userId, productId, type],
    );
    recalcUserProductScore(userId, productId).catch(() => {});
};

export const recalcUserProductScore = async (
    userId: string,
    productId: number,
): Promise<void> => {
    await pool.query(
        `INSERT INTO UserProductScore (userId, productId, score, interactionCount, updatedAt)
         SELECT ?, ?,
             ${WEIGHTED_SCORE_EXPR} AS score,
             COUNT(*) AS interactionCount,
             NOW()
         FROM ProductInteraction pi
         WHERE pi.userId = ? AND pi.productId = ?
         ON DUPLICATE KEY UPDATE
             score = VALUES(score),
             interactionCount = VALUES(interactionCount),
             updatedAt = VALUES(updatedAt)`,
        [userId, productId, userId, productId],
    );
};

export const recalcGlobalScores = async (): Promise<void> => {
    console.log('[Scoring] Recalculating global product scores…');
    await pool.query(
        `UPDATE Product p
         LEFT JOIN (
             SELECT pi.productId,
                 ${WEIGHTED_SCORE_EXPR} AS score
             FROM ProductInteraction pi
             WHERE pi.createdAt >= DATE_SUB(NOW(), INTERVAL 365 DAY)
             GROUP BY pi.productId
         ) scores ON scores.productId = p.id
         SET p.globalScore = COALESCE(scores.score, 0)`,
    );
    console.log('[Scoring] Global scores updated.');
};

/**
 * Souply 2.0: which receipt lines earn a `receipt_buy` interaction — PURE for
 * testability. Rules (2026-07-16): a linked SP AND a confident band (S1/S2 —
 * garbage lines never score); once per LINE, never per quantity. The caller
 * gates on isInitialSave (reparse/autosave must not re-fire).
 */
export const collectReceiptBuySpIds = (products: any[]): number[] =>
    (Array.isArray(products) ? products : [])
        .filter((p) => {
            const spId = Number(p?.storeProductId);
            const band = p?.itemConfidence?.band;
            return Number.isFinite(spId) && spId > 0 && (band === 'S1' || band === 'S2');
        })
        .map((p) => Number(p.storeProductId));
