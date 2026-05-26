import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { countOutstandingImageQueue } from '../models/adminImageQueueModel.js';

// Mirrors FALLBACK_CATEGORY_IDS in adminUncategorisedQueueModel.ts
const UNCATEGORISED_CATEGORY_ID = 688;

/**
 * GET /api/admin/queue/counts
 *
 * Returns approximate item counts for each admin queue type.
 * Used to show badge numbers on filter chips in the unified Eilė tab.
 * Counts are rough (leased items not excluded) — accuracy is sufficient
 * for badge display and the queries must be fast.
 */
export const getQueueCounts = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const [[flagRows], [uncatRows], [amountRows], images] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS n FROM ReceiptLineIssue WHERE status = 'pending'`),
            pool.query(`SELECT COUNT(*) AS n FROM Product WHERE categoryId = ?`, [UNCATEGORISED_CATEGORY_ID]),
            // Proxy for the heuristic + user-flagged pool: SPs with amount IS NULL
            // that have been purchased recently. Computing the exact queue size
            // requires running the parser (see adminAmountQueueModel comments),
            // so this is an intentional approximation for badge display only.
            pool.query(
                `SELECT COUNT(DISTINCT sp.id) AS n
                   FROM StoreProduct sp
                   JOIN Price pr ON pr.storeProductId = sp.id
                  WHERE sp.amount IS NULL
                    AND pr.receiptId IS NOT NULL
                    AND pr.date > NOW() - INTERVAL 90 DAY`,
            ),
            countOutstandingImageQueue(),
        ]);

        res.json({
            flags: Number((flagRows as any[])[0]?.n ?? 0),
            uncategorised: Number((uncatRows as any[])[0]?.n ?? 0),
            images,
            amounts: Number((amountRows as any[])[0]?.n ?? 0),
        });
    } catch (e) { next(e); }
};
