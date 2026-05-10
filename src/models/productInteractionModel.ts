import pool from '../config/db.js';

export type InteractionType = 'basket_add' | 'list_add' | 'list_check';

const DECAY_DAYS = 90;

const WEIGHTED_SCORE_EXPR = `
    SUM(
        CASE pi.type
            WHEN 'list_check' THEN 3
            WHEN 'basket_add' THEN 2
            WHEN 'list_add'   THEN 1
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
