import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Fetch a receipt row, parse its parsedData, and return with chain info. */
async function fetchReceiptRow(id: string) {
    const [rows]: any = await pool.query(
        `SELECT r.*,
                u.firstName AS userFirstName,
                sc.id       AS chainId,
                sc.logoUrl  AS chainLogoUrl
           FROM Receipt r
           LEFT JOIN User       u  ON u.id        = r.userId
           LEFT JOIN Store      s  ON s.id        = r.storeId
           LEFT JOIN StoreChain sc ON sc.id       = s.chainId
          WHERE r.id = ?`,
        [id],
    );
    return rows[0] ?? null;
}

/** Format a MySQL DATE value (returned as a JS Date) to YYYY-MM-DD using
 *  local date components so the result matches the stored date regardless
 *  of the server's UTC offset. */
function fmtDate(d: Date | null | undefined): string | null {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Mark a receipt as admin-edited. */
async function touchAdminEdited(receiptId: string) {
    await pool.query(
        `UPDATE Receipt SET adminEditedAt = NOW() WHERE id = ?`,
        [receiptId],
    );
}

/** Update a single path inside parsedData using MySQL JSON_SET. */
async function jsonSet(receiptId: string, path: string, value: any) {
    await pool.query(
        `UPDATE Receipt SET parsedData = JSON_SET(parsedData, ?, CAST(? AS JSON)) WHERE id = ?`,
        [path, JSON.stringify(value), receiptId],
    );
}

async function jsonSetString(receiptId: string, path: string, value: string) {
    await pool.query(
        `UPDATE Receipt SET parsedData = JSON_SET(parsedData, ?, ?) WHERE id = ?`,
        [path, value, receiptId],
    );
}

function productPath(index: number, field: string) {
    return `$.products[${index}].${field}`;
}

// ── GET /api/admin/receipts ──────────────────────────────────────────

export const getAdminReceiptList = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const page   = Math.max(0, Number(req.query.page ?? 0));
        const limit  = Math.max(1, Math.min(50, Number(req.query.limit ?? 20)));
        const filter = String(req.query.filter ?? 'all'); // all | flagged | fixed
        const offset = page * limit;

        const conditions: string[] = [`r.processingStatus = 'completed'`];
        if (filter === 'flagged') {
            conditions.push(
                `EXISTS (SELECT 1 FROM ReceiptLineIssue rli WHERE rli.receiptId = r.id AND rli.status = 'pending')`,
            );
        } else if (filter === 'fixed') {
            conditions.push(`r.adminEditedAt IS NOT NULL`);
        }
        const where = conditions.join(' AND ');

        const [[{ total }]]: any = await pool.query(
            `SELECT COUNT(*) AS total FROM Receipt r WHERE ${where}`,
        );

        const [rows]: any = await pool.query(
            `SELECT
                r.id,
                r.userId,
                u.firstName                                                     AS userFirstName,
                sc.id                                                           AS chainId,
                sc.logoUrl                                                      AS chainLogoUrl,
                r.receiptDate                                                   AS date,
                JSON_EXTRACT(r.parsedData, '$.footer.total')                   AS total,
                JSON_LENGTH(r.parsedData, '$.products')                        AS lineCount,
                r.adminEditedAt IS NOT NULL                                     AS hasInspectEdits,
                EXISTS (
                    SELECT 1 FROM ReceiptLineIssue rli
                    WHERE rli.receiptId = r.id AND rli.status = 'pending'
                )                                                               AS flagged
             FROM Receipt r
             LEFT JOIN User       u  ON u.id   = r.userId
             LEFT JOIN Store      s  ON s.id   = r.storeId
             LEFT JOIN StoreChain sc ON sc.id  = s.chainId
            WHERE ${where}
            ORDER BY r.id DESC
            LIMIT ? OFFSET ?`,
            [limit, offset],
        );

        const receipts = rows.map((r: any) => ({
            id:              r.id,
            userId:          r.userId,
            userInitial:     (r.userFirstName ?? '?')[0].toUpperCase(),
            chainId:         r.chainId,
            chainLogoUrl:    r.chainLogoUrl ?? null,
            date:            fmtDate(r.date),
            total:           r.total != null ? Number(r.total) : null,
            lineCount:       Number(r.lineCount ?? 0),
            hasInspectEdits: Boolean(r.hasInspectEdits),
            flagged:         Boolean(r.flagged),
        }));

        res.json({ receipts, total: Number(total), page });
    } catch (e) { next(e); }
};

// ── GET /api/admin/receipts/:id ──────────────────────────────────────

export const getAdminReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const row = await fetchReceiptRow(String(req.params.id));
        if (!row) { res.status(404).json({ error: 'Not found' }); return; }

        const parsedData = typeof row.parsedData === 'string'
            ? JSON.parse(row.parsedData)
            : row.parsedData;

        res.json({
            id:           row.id,
            userId:       row.userId,
            userInitial:  (row.userFirstName ?? '?')[0].toUpperCase(),
            chainId:      row.chainId,
            chainLogoUrl: row.chainLogoUrl ?? null,
            date:         fmtDate(row.receiptDate),
            flagged:      false, // field exists for consistency; full flag list via flags queue
            adminEditedAt: row.adminEditedAt ?? null,
            parsedData,
        });
    } catch (e) { next(e); }
};

// ── PATCH /api/admin/receipts/:id/date ───────────────────────────────

export const patchReceiptDate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const { date } = req.body ?? {};
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            res.status(400).json({ error: 'date must be YYYY-MM-DD' });
            return;
        }
        await pool.query(`UPDATE Receipt SET receiptDate = ? WHERE id = ?`, [date, id]);
        await jsonSetString(id, '$.footer.date', date);
        await pool.query(`UPDATE Price SET date = ? WHERE receiptId = ?`, [date, id]);
        await touchAdminEdited(id);
        res.json({ ok: true });
    } catch (e) { next(e); }
};

// ── PATCH /api/admin/receipts/:id/products/:index/name ───────────────

export const patchProductName = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const index = String(req.params.index);
        const idx = Number(index);
        const { name } = req.body ?? {};
        if (!name || typeof name !== 'string' || !name.trim()) {
            res.status(400).json({ error: 'name required' });
            return;
        }

        // Update parsedData.products[idx].name and clear stale match fields.
        await pool.query(
            `UPDATE Receipt
                SET parsedData = JSON_SET(
                    JSON_SET(
                        JSON_SET(
                            JSON_SET(
                                JSON_SET(parsedData,
                                    ?, ?),
                                ?, NULL),
                            ?, NULL),
                        ?, NULL),
                    ?, FALSE)
              WHERE id = ?`,
            [
                productPath(idx, 'name'), name.trim(),
                productPath(idx, 'storeProductId'),
                productPath(idx, 'matchedName'),
                productPath(idx, 'matchConfidence'),
                productPath(idx, 'matchConfirmed'),
                id,
            ],
        );
        await touchAdminEdited(id);

        // Find the receipt's chain so we can prefer within-chain matches.
        const [[chainRow]]: any = await pool.query(
            `SELECT sc.id AS chainId
               FROM Receipt r
               LEFT JOIN Store s ON s.id = r.storeId
               LEFT JOIN StoreChain sc ON sc.id = s.chainId
              WHERE r.id = ?`,
            [id],
        );
        const chainId: number | null = chainRow?.chainId ?? null;

        const trimmed = name.trim();

        // Ranked search: exact > starts-with > contains. Use first word for the
        // broad contains filter so we cast a wide net, then let the CASE rank it.
        const firstWord = trimmed.split(/\s+/)[0];
        const containsPattern  = `%${firstWord}%`;
        const startsWithPattern = `${trimmed}%`;

        const spSearchSql = (chainClause: string) => `
            SELECT sp.id AS storeProductId, sp.storeProductName, p.name AS productName,
                   CASE
                     WHEN sp.storeProductName = ?          THEN 0
                     WHEN sp.storeProductName LIKE ?       THEN 1
                     ELSE                                       2
                   END AS matchRank
              FROM StoreProduct sp
              JOIN Product p ON p.id = sp.productId
             WHERE ${chainClause}
               AND sp.storeProductName LIKE ?
             ORDER BY matchRank ASC, sp.id DESC
             LIMIT 8`;

        // Chain-scoped first; fall back to global when chainId is missing or empty.
        let rawCandidates: any[] = [];
        if (chainId != null) {
            const [rows]: any = await pool.query(
                spSearchSql('sp.chainId = ?'),
                [trimmed, startsWithPattern, chainId, containsPattern],
            );
            rawCandidates = rows;
        }
        if (rawCandidates.length === 0) {
            const [rows]: any = await pool.query(
                spSearchSql('1=1'),
                [trimmed, startsWithPattern, containsPattern],
            );
            rawCandidates = rows;
        }

        const RANK_CONFIDENCE: Record<number, number> = { 0: 1.0, 1: 0.85, 2: 0.6 };
        const candidates = rawCandidates.map((r: any) => ({
            storeProductId:   r.storeProductId,
            storeProductName: r.storeProductName,
            productName:      r.productName,
            confidence:       RANK_CONFIDENCE[r.matchRank] ?? 0.5,
        }));

        res.json({ ok: true, candidates });
    } catch (e) { next(e); }
};

// ── POST /api/admin/receipts/:id/products/:index/confirm-match ────────

export const postConfirmMatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const index = String(req.params.index);
        const idx = Number(index);
        const { storeProductId } = req.body ?? {};
        if (!Number.isInteger(storeProductId)) {
            res.status(400).json({ error: 'storeProductId required' });
            return;
        }

        const [spRows]: any = await pool.query(
            `SELECT sp.storeProductName, p.name AS productName
               FROM StoreProduct sp
               JOIN Product p ON p.id = sp.productId
              WHERE sp.id = ?`,
            [storeProductId],
        );
        if (!spRows[0]) { res.status(404).json({ error: 'StoreProduct not found' }); return; }

        const sp = spRows[0];
        await pool.query(
            `UPDATE Receipt
                SET parsedData = JSON_SET(
                    JSON_SET(
                        JSON_SET(parsedData,
                            ?, ?),
                        ?, ?),
                    ?, TRUE)
              WHERE id = ?`,
            [
                productPath(idx, 'storeProductId'), storeProductId,
                productPath(idx, 'matchedName'), sp.productName,
                productPath(idx, 'matchConfirmed'),
                id,
            ],
        );
        await touchAdminEdited(id);
        res.json({ ok: true });
    } catch (e) { next(e); }
};

// ── PATCH /api/admin/receipts/:id/products/:index/unit ───────────────

export const patchProductUnit = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const index = String(req.params.index);
        const idx = Number(index);
        const { unit } = req.body ?? {};
        const VALID_UNITS = ['g', 'kg', 'ml', 'l', 'vnt', 'rit'];
        if (!unit || !VALID_UNITS.includes(unit)) {
            res.status(400).json({ error: `unit must be one of: ${VALID_UNITS.join(', ')}` });
            return;
        }

        await jsonSetString(id, productPath(idx, 'unit'), unit);

        // If the line has a matched SP, update StoreProduct.unit too.
        const [rows]: any = await pool.query(
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(parsedData, ?)) AS spId
               FROM Receipt WHERE id = ?`,
            [productPath(idx, 'storeProductId'), id],
        );
        const spId = Number(rows[0]?.spId);
        if (Number.isFinite(spId) && spId > 0) {
            await pool.query(`UPDATE StoreProduct SET unit = ? WHERE id = ?`, [unit, spId]);
        }

        await touchAdminEdited(id);
        res.json({ ok: true });
    } catch (e) { next(e); }
};

// ── PATCH /api/admin/receipts/:id/products/:index/amount ─────────────

export const patchProductAmount = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const index = String(req.params.index);
        const idx = Number(index);
        const { amount } = req.body ?? {};
        if (!Number.isFinite(amount) || amount <= 0) {
            res.status(400).json({ error: 'amount must be a positive number' });
            return;
        }

        const [rows]: any = await pool.query(
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(parsedData, ?)) AS spId
               FROM Receipt WHERE id = ?`,
            [productPath(idx, 'storeProductId'), id],
        );
        const spId = Number(rows[0]?.spId);
        if (!Number.isFinite(spId) || spId <= 0) {
            res.status(400).json({ error: 'Line must have a matched StoreProduct to update amount' });
            return;
        }

        await pool.query(`UPDATE StoreProduct SET amount = ? WHERE id = ?`, [amount, spId]);
        await touchAdminEdited(id);
        res.json({ ok: true });
    } catch (e) { next(e); }
};

// ── PATCH /api/admin/receipts/:id/products/:index/quantity ───────────

export const patchProductQuantity = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const index = String(req.params.index);
        const idx = Number(index);
        const { quantity } = req.body ?? {};
        if (!Number.isInteger(quantity) || quantity < 1) {
            res.status(400).json({ error: 'quantity must be a positive integer' });
            return;
        }

        // Read current price for this line.
        const [rows]: any = await pool.query(
            `SELECT JSON_EXTRACT(parsedData, ?) AS price,
                    JSON_UNQUOTE(JSON_EXTRACT(parsedData, ?)) AS spId
               FROM Receipt WHERE id = ?`,
            [productPath(idx, 'price'), productPath(idx, 'storeProductId'), id],
        );
        const price = Number(rows[0]?.price);
        const spId  = Number(rows[0]?.spId);

        const newPricePerUnit = Number.isFinite(price) && quantity > 0
            ? Math.round((price / quantity) * 10000) / 10000
            : null;

        await pool.query(
            `UPDATE Receipt
                SET parsedData = JSON_SET(
                    JSON_SET(parsedData,
                        ?, ?),
                    ?, ?)
              WHERE id = ?`,
            [
                productPath(idx, 'quantity'), quantity,
                productPath(idx, 'pricePerUnit'), newPricePerUnit,
                id,
            ],
        );

        // Cascade to Price row if matched.
        if (Number.isFinite(spId) && spId > 0 && newPricePerUnit !== null) {
            await pool.query(
                `UPDATE Price SET price = ? WHERE receiptId = ? AND storeProductId = ?`,
                [newPricePerUnit, id, spId],
            );
        }

        await touchAdminEdited(id);
        res.json({ ok: true, newPricePerUnit });
    } catch (e) { next(e); }
};

// ── POST /api/admin/receipts/:id/products/:index/deny-match ──────────

export const postDenyMatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = String(req.params.id);
        const index = String(req.params.index);
        const idx = Number(index);

        await pool.query(
            `UPDATE Receipt
                SET parsedData = JSON_SET(
                    JSON_SET(
                        JSON_SET(
                            JSON_SET(parsedData,
                                ?, NULL),
                            ?, NULL),
                        ?, NULL),
                    ?, FALSE)
              WHERE id = ?`,
            [
                productPath(idx, 'storeProductId'),
                productPath(idx, 'matchedName'),
                productPath(idx, 'matchConfidence'),
                productPath(idx, 'matchConfirmed'),
                id,
            ],
        );
        await touchAdminEdited(id);
        res.json({ ok: true });
    } catch (e) { next(e); }
};
