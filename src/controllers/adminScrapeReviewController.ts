import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';

/**
 * Scrape-review: inspect what a chain's scraper changed on a given day,
 * checkmark reviewed products away, flag suspicious ones for investigation.
 *
 * "Scraped that day" = the product has an SP of the chain that received a
 * Price row dated that day (dedup-skipped/unchanged items leave no trace and
 * deliberately don't appear — review focuses on what changed).
 */

const NEPRISKIRTA_ID = 688;

/** Days of a month (chain-scoped) that have scrape activity + global bounds. */
export const getScrapeDays = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const chainId = Number(req.query.chainId);
        const month = String(req.query.month ?? ''); // optional YYYY-MM; absent = all days
        if (!chainId || (month && !/^\d{4}-\d{2}$/.test(month))) {
            res.status(400).json({ error: 'chainId required; month must be YYYY-MM' });
            return;
        }
        const [days]: any = await pool.query(
            month
                ? `SELECT DISTINCT DATE_FORMAT(p.date, '%Y-%m-%d') AS d
                     FROM Price p JOIN StoreProduct sp ON sp.id = p.storeProductId
                    WHERE sp.chainId = ? AND p.date >= ? AND p.date < DATE_ADD(?, INTERVAL 1 MONTH)`
                : `SELECT DISTINCT DATE_FORMAT(p.date, '%Y-%m-%d') AS d
                     FROM Price p JOIN StoreProduct sp ON sp.id = p.storeProductId
                    WHERE sp.chainId = ?`,
            month ? [chainId, `${month}-01`, `${month}-01`] : [chainId],
        );
        const [bounds]: any = await pool.query(
            `SELECT DATE_FORMAT(MIN(p.date), '%Y-%m-%d') AS minDate,
                    DATE_FORMAT(MAX(p.date), '%Y-%m-%d') AS maxDate
               FROM Price p JOIN StoreProduct sp ON sp.id = p.storeProductId
              WHERE sp.chainId = ?`,
            [chainId],
        );
        res.json({
            days: (days as any[]).map(r => String(r.d)),
            minDate: bounds[0]?.minDate ?? null,
            maxDate: bounds[0]?.maxDate ?? null,
        });
    } catch (e) { next(e); }
};

/** Category subtree ids for the DEEPEST selected level (l3 > l2 > l1). */
async function subtreeIds(categoryId: number): Promise<number[]> {
    const [rows]: any = await pool.query(
        `WITH RECURSIVE sub AS (
            SELECT id FROM Category WHERE id = ?
            UNION ALL
            SELECT c.id FROM Category c JOIN sub ON c.parentCategoryId = sub.id
        ) SELECT id FROM sub`,
        [categoryId],
    );
    return (rows as any[]).map(r => Number(r.id));
}

/** Cross-category product list for one chain + scrape day. */
export const getScrapeReview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const chainId = Number(req.query.chainId);
        const date = String(req.query.date ?? '');
        if (!chainId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            res.status(400).json({ error: 'chainId and date=YYYY-MM-DD required' });
            return;
        }
        const catParam = Number(req.query.l3 ?? 0) || Number(req.query.l2 ?? 0) || Number(req.query.l1 ?? 0) || null;
        const hideChecked = String(req.query.verification ?? '') === 'unresolved';
        // Keyword search on the SELECTED CHAIN's SP names ONLY — product names
        // and other chains' listings are deliberately not searched.
        const q = String(req.query.q ?? '').trim().slice(0, 100);
        const limit = Math.min(Number(req.query.limit ?? 200), 500);
        const offset = Math.max(Number(req.query.offset ?? 0), 0);

        let catFilter = '';
        const catParams: any[] = [];
        if (catParam) {
            const ids = catParam === NEPRISKIRTA_ID ? [NEPRISKIRTA_ID] : await subtreeIds(catParam);
            catFilter = 'AND p.categoryId IN (?)';
            catParams.push(ids);
        }

        // Same card payload as the real catalog browse (name/images/chainLogos/
        // amounts), plus category names + verification state.
        const [rows]: any = await pool.query(
            `SELECT p.id, p.name, p.categoryId, p.globalScore, p.categoryReviewPending,
                    c.name AS categoryName,
                    (SELECT JSON_ARRAYAGG(JSON_OBJECT('chainId', sc2.id, 'logoUrl', sc2.miniLogoUrl))
                     FROM StoreChain sc2
                     WHERE sc2.id IN (SELECT sp2.chainId FROM StoreProduct sp2 WHERE sp2.productId = p.id)) AS chainLogos,
                    (SELECT JSON_ARRAYAGG(sp3.imageUrl)
                     FROM StoreProduct sp3
                     WHERE sp3.productId = p.id AND sp3.imageUrl IS NOT NULL) AS imageUrls,
                    CAST(MIN(CASE WHEN sp.unit IN ('kg','l') THEN sp.amount * 1000
                                  WHEN sp.unit IN ('g','ml') THEN sp.amount END) AS UNSIGNED) AS minAmount,
                    CAST(MAX(CASE WHEN sp.unit IN ('kg','l') THEN sp.amount * 1000
                                  WHEN sp.unit IN ('g','ml') THEN sp.amount END) AS UNSIGNED) AS maxAmount,
                    CASE WHEN SUM(CASE WHEN sp.unit IN ('l','ml') THEN 1 ELSE 0 END) >
                              SUM(CASE WHEN sp.unit IN ('kg','g') THEN 1 ELSE 0 END)
                         THEN 'ml' ELSE 'g' END AS unit,
                    MAX(sp.isWeighable) AS hasWeighable,
                    v.status AS verifyStatus, v.note AS verifyNote
               FROM Product p
               JOIN Category c ON c.id = p.categoryId
               LEFT JOIN StoreProduct sp ON sp.productId = p.id
               LEFT JOIN AdminScrapeVerification v
                      ON v.chainId = ? AND v.scrapeDate = ? AND v.productId = p.id
              WHERE p.mergedIntoId IS NULL
                AND EXISTS (
                    SELECT 1 FROM StoreProduct spc
                    JOIN Price pr ON pr.storeProductId = spc.id
                    WHERE spc.productId = p.id AND spc.chainId = ?
                      AND pr.date >= ? AND pr.date < DATE_ADD(?, INTERVAL 1 DAY)
                )
                ${catFilter}
                ${hideChecked ? "AND (v.status IS NULL OR v.status <> 'checked')" : ''}
                ${q ? `AND EXISTS (SELECT 1 FROM StoreProduct spq
                                   WHERE spq.productId = p.id AND spq.chainId = ?
                                     AND spq.storeProductName LIKE ?)` : ''}
              GROUP BY p.id
              ORDER BY p.name
              LIMIT ? OFFSET ?`,
            [chainId, date, chainId, date, date, ...catParams,
             ...(q ? [chainId, `%${q}%`] : []), limit, offset],
        );
        for (const r of rows as any[]) {
            for (const k of ['chainLogos', 'imageUrls']) {
                if (typeof r[k] === 'string') { try { r[k] = JSON.parse(r[k]); } catch { r[k] = null; } }
            }
        }
        res.json({ products: rows, limit, offset });
    } catch (e) { next(e); }
};

/** Set / clear the verification state of one product for a chain+day. */
export const setScrapeVerification = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const adminId = String(req.headers['x-admin-id'] ?? '').trim() || null;
        const { chainId, date, productId, status, note } = req.body ?? {};
        if (!Number(chainId) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) || !Number(productId)) {
            res.status(400).json({ error: 'chainId, date, productId required' });
            return;
        }
        if (status == null) {
            await pool.query(
                'DELETE FROM AdminScrapeVerification WHERE chainId = ? AND scrapeDate = ? AND productId = ?',
                [chainId, date, productId],
            );
            res.json({ cleared: true });
            return;
        }
        if (!['checked', 'flagged'].includes(String(status))) {
            res.status(400).json({ error: 'status must be checked|flagged|null' });
            return;
        }
        await pool.query(
            `INSERT INTO AdminScrapeVerification (chainId, scrapeDate, productId, status, note, adminUserId)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), adminUserId = VALUES(adminUserId)`,
            [chainId, date, productId, status, typeof note === 'string' ? note.slice(0, 500) : null, adminId],
        );
        res.json({ status, note: note ?? null });
    } catch (e) { next(e); }
};
