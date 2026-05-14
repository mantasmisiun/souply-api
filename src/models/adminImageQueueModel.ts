import pool from '../config/db.js';

/**
 * Queue model for the admin image-cleanup tab.
 *
 * Two surfaces:
 *   - `buildImageQueuePickSql()` — SQL that picks spIds eligible for
 *     the queue (filtered by active leases). Used by the lease
 *     `claimBatch` helper.
 *   - `hydrateImageQueueRows(spIds)` — given a list of spIds (typically
 *     an admin's currently leased batch), fetch full row data:
 *     details, candidates (cross-chain + BaseProductLink + pending
 *     uploads), and the last propagation log for the inline-revert
 *     banner.
 *
 * Ranking inside `buildImageQueuePickSql`:
 *   1. User-flagged image issues first (ReceiptLineIssue.flags.image=true, status='pending')
 *   2. Among unflagged: descending by recent purchase count (30-day window)
 *   3. Final tiebreaker: spId asc (stable order)
 */

const RECENT_PURCHASE_WINDOW_DAYS = 30;

export interface AdminImageCandidate {
    imageUrl: string;
    sourceType: 'cross_chain_sibling' | 'base_product_link' | 'pending_upload';
    sourceSpId: number | null;
    sourceChainName?: string;
    pendingUploadId?: number;
    uploadedBy?: string;
}

export interface AdminImageQueueRow {
    spId: number;
    name: string;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    categoryName: string;
    currentImageUrl: string | null;
    flaggedByUser: boolean;
    flagIssueId: number | null;
    flagReceiptId: number | null;
    flagLineIdx: number | null;
    recentPurchaseCount: number;
    candidates: AdminImageCandidate[];
    lastPropagation: {
        id: number;
        sourceType: string;
        actor: string;
        createdAt: string;
    } | null;
}

/**
 * Picker SQL for the lease layer. Returns a single `spId` column
 * ordered by (flagged desc, recent purchases desc, spId asc), with
 * any currently-leased SPs excluded. Caller adds `LIMIT N`.
 */
export function buildImageQueuePickSql(): { sql: string; params: any[] } {
    return {
        sql: `
            SELECT q.spId
              FROM (
                    SELECT pr.storeProductId AS spId,
                           1 AS flaggedByUser
                      FROM ReceiptLineIssue rli
                      JOIN Price pr ON pr.receiptId = rli.receiptId
                     WHERE JSON_EXTRACT(rli.flags, '$.image') = TRUE
                       AND rli.status = 'pending'
                    UNION ALL
                    SELECT sp.id AS spId,
                           0 AS flaggedByUser
                      FROM StoreProduct sp
                     WHERE sp.imageUrl IS NULL
              ) q
             WHERE NOT EXISTS (
                 SELECT 1 FROM AdminCardLease l
                  WHERE l.spId = q.spId
                    AND l.queueKind = 'image'
                    AND l.completedAt IS NULL
                    AND l.abandonedAt IS NULL
                    AND l.expiresAt > NOW()
             )
             GROUP BY q.spId
             ORDER BY MAX(q.flaggedByUser) DESC,
                      COALESCE((
                          SELECT COUNT(*) FROM Price p
                           WHERE p.storeProductId = q.spId
                             AND p.receiptId IS NOT NULL
                             AND p.date > NOW() - INTERVAL ${RECENT_PURCHASE_WINDOW_DAYS} DAY
                      ), 0) DESC,
                      q.spId ASC`,
        params: [],
    };
}

/**
 * Hydrate a set of spIds (typically the admin's active batch) into
 * full queue rows ready for the UI. Five parallelisable queries:
 *   - per-SP details (name, chain, category, current image)
 *   - cross-chain sibling candidates
 *   - BaseProductLink sibling candidates (similar variants)
 *   - pending user uploads
 *   - last non-reversed propagation log row
 *   - flag presence (ReceiptLineIssue image=true)
 *   - recent purchase counts
 */
export async function hydrateImageQueueRows(
    spIds: number[],
    locale: string = 'lt',
): Promise<AdminImageQueueRow[]> {
    if (spIds.length === 0) return [];

    const [
        [detailRows],
        [siblingRows],
        [linkRows],
        [pendingRows],
        [propRows],
        [flagRows],
        [purchaseRows],
    ]: any[] = await Promise.all([
        // Details
        pool.query(
            `SELECT sp.id AS spId,
                    COALESCE(sp.storeProductName, p.name) AS name,
                    sp.imageUrl AS currentImageUrl,
                    sp.chainId,
                    sc.name AS chainName,
                    sc.logoUrl AS chainLogoUrl,
                    COALESCE(ct.name, c.name) AS categoryName
               FROM StoreProduct sp
               JOIN Product p ON p.id = sp.productId
               LEFT JOIN StoreChain sc ON sc.id = sp.chainId
               LEFT JOIN Category c ON c.id = p.categoryId
               LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
              WHERE sp.id IN (?)`,
            [locale, spIds],
        ),
        // Cross-chain siblings
        pool.query(
            `SELECT sp_missing.id AS forSpId,
                    sp_src.id AS sourceSpId,
                    sp_src.imageUrl AS imageUrl,
                    sc_src.name AS sourceChainName
               FROM StoreProduct sp_missing
               JOIN StoreProduct sp_src ON sp_src.productId = sp_missing.productId
                                      AND sp_src.id != sp_missing.id
                                      AND sp_src.imageUrl IS NOT NULL
               LEFT JOIN StoreChain sc_src ON sc_src.id = sp_src.chainId
              WHERE sp_missing.id IN (?)`,
            [spIds],
        ),
        // BaseProductLink similar siblings (both directions)
        pool.query(
            `SELECT sp_missing.id AS forSpId,
                    sp_src.id AS sourceSpId,
                    sp_src.imageUrl AS imageUrl,
                    sc_src.name AS sourceChainName
               FROM StoreProduct sp_missing
               JOIN Product p_missing ON p_missing.id = sp_missing.productId
               JOIN BaseProductLink bpl ON bpl.bpIdA = p_missing.baseProductId
               JOIN Product p_src ON p_src.baseProductId = bpl.bpIdB
               JOIN StoreProduct sp_src ON sp_src.productId = p_src.id
                                      AND sp_src.id != sp_missing.id
                                      AND sp_src.imageUrl IS NOT NULL
               LEFT JOIN StoreChain sc_src ON sc_src.id = sp_src.chainId
              WHERE sp_missing.id IN (?) AND p_missing.baseProductId IS NOT NULL
              UNION
             SELECT sp_missing.id AS forSpId,
                    sp_src.id AS sourceSpId,
                    sp_src.imageUrl AS imageUrl,
                    sc_src.name AS sourceChainName
               FROM StoreProduct sp_missing
               JOIN Product p_missing ON p_missing.id = sp_missing.productId
               JOIN BaseProductLink bpl ON bpl.bpIdB = p_missing.baseProductId
               JOIN Product p_src ON p_src.baseProductId = bpl.bpIdA
               JOIN StoreProduct sp_src ON sp_src.productId = p_src.id
                                      AND sp_src.id != sp_missing.id
                                      AND sp_src.imageUrl IS NOT NULL
               LEFT JOIN StoreChain sc_src ON sc_src.id = sp_src.chainId
              WHERE sp_missing.id IN (?) AND p_missing.baseProductId IS NOT NULL`,
            [spIds, spIds],
        ),
        // Pending user uploads
        pool.query(
            `SELECT spId, id AS pendingUploadId, filePath, uploadedBy
               FROM PendingImageUpload
              WHERE spId IN (?) AND status = 'pending'
              ORDER BY createdAt ASC`,
            [spIds],
        ),
        // Last non-reversed propagation per SP
        pool.query(
            `SELECT spId, id, sourceType, actor, createdAt
               FROM ImagePropagationLog ipl1
              WHERE spId IN (?)
                AND reversedAt IS NULL
                AND id = (SELECT MAX(id) FROM ImagePropagationLog ipl2
                           WHERE ipl2.spId = ipl1.spId AND ipl2.reversedAt IS NULL)`,
            [spIds],
        ),
        // Flag presence
        pool.query(
            `SELECT DISTINCT pr.storeProductId AS spId,
                    rli.receiptId, rli.receiptLineIdx
               FROM ReceiptLineIssue rli
               JOIN Price pr ON pr.receiptId = rli.receiptId
              WHERE JSON_EXTRACT(rli.flags, '$.image') = TRUE
                AND rli.status = 'pending'
                AND pr.storeProductId IN (?)`,
            [spIds],
        ),
        // Recent purchase counts
        pool.query(
            `SELECT storeProductId AS spId, COUNT(*) AS n
               FROM Price
              WHERE storeProductId IN (?)
                AND receiptId IS NOT NULL
                AND date > NOW() - INTERVAL ? DAY
              GROUP BY storeProductId`,
            [spIds, RECENT_PURCHASE_WINDOW_DAYS],
        ),
    ]);

    const detailBySpId = new Map<number, any>();
    for (const r of detailRows as any[]) detailBySpId.set(Number(r.spId), r);

    const propBySpId = new Map<number, any>();
    for (const r of propRows as any[]) propBySpId.set(Number(r.spId), r);

    const flagBySpId = new Map<number, { receiptId: number; receiptLineIdx: number }>();
    for (const r of flagRows as any[]) {
        flagBySpId.set(Number(r.spId), {
            receiptId: Number(r.receiptId),
            receiptLineIdx: Number(r.receiptLineIdx),
        });
    }

    const purchaseCountBySpId = new Map<number, number>();
    for (const r of purchaseRows as any[]) {
        purchaseCountBySpId.set(Number(r.spId), Number(r.n));
    }

    // Dedupe candidates per SP by imageUrl — the same image can surface
    // from multiple sources (e.g. cross-chain Rimi has the same image as
    // a BaseProductLink-similar Maxima sibling).
    const candidatesBySpId = new Map<number, AdminImageCandidate[]>();
    const seenImagesPerSp = new Map<number, Set<string>>();
    const addCandidate = (spId: number, c: AdminImageCandidate) => {
        if (!c.imageUrl) return;
        let seen = seenImagesPerSp.get(spId);
        if (!seen) { seen = new Set(); seenImagesPerSp.set(spId, seen); }
        if (seen.has(c.imageUrl)) return;
        seen.add(c.imageUrl);
        let arr = candidatesBySpId.get(spId);
        if (!arr) { arr = []; candidatesBySpId.set(spId, arr); }
        arr.push(c);
    };
    for (const r of siblingRows as any[]) {
        addCandidate(Number(r.forSpId), {
            imageUrl: String(r.imageUrl),
            sourceType: 'cross_chain_sibling',
            sourceSpId: Number(r.sourceSpId),
            sourceChainName: r.sourceChainName ?? undefined,
        });
    }
    for (const r of linkRows as any[]) {
        addCandidate(Number(r.forSpId), {
            imageUrl: String(r.imageUrl),
            sourceType: 'base_product_link',
            sourceSpId: Number(r.sourceSpId),
            sourceChainName: r.sourceChainName ?? undefined,
        });
    }
    for (const r of pendingRows as any[]) {
        addCandidate(Number(r.spId), {
            imageUrl: String(r.filePath),
            sourceType: 'pending_upload',
            sourceSpId: null,
            pendingUploadId: Number(r.pendingUploadId),
            uploadedBy: r.uploadedBy ? String(r.uploadedBy).slice(-8) : undefined,
        });
    }

    // Assemble rows in the order spIds came in (preserves the rank /
    // claim order from the lease layer).
    return spIds.map(spId => {
        const detail = detailBySpId.get(spId) ?? {};
        const prop = propBySpId.get(spId) ?? null;
        const flag = flagBySpId.get(spId);
        return {
            spId,
            name: String(detail.name ?? ''),
            chainId: Number(detail.chainId ?? 0),
            chainName: String(detail.chainName ?? ''),
            chainLogoUrl: detail.chainLogoUrl ?? null,
            categoryName: String(detail.categoryName ?? ''),
            currentImageUrl: detail.currentImageUrl ?? null,
            flaggedByUser: !!flag,
            flagIssueId: null,
            flagReceiptId: flag ? flag.receiptId : null,
            flagLineIdx: flag ? flag.receiptLineIdx : null,
            recentPurchaseCount: purchaseCountBySpId.get(spId) ?? 0,
            candidates: candidatesBySpId.get(spId) ?? [],
            lastPropagation: prop
                ? {
                    id: Number(prop.id),
                    sourceType: String(prop.sourceType),
                    actor: String(prop.actor),
                    createdAt: String(prop.createdAt),
                }
                : null,
        };
    });
}

/**
 * Total count of unclaimed + unleased SPs in the queue. Surfaced in
 * the queue response so the admin sees how much work remains globally.
 */
export async function countOutstandingImageQueue(): Promise<number> {
    const [rows]: any = await pool.query(
        `SELECT COUNT(*) AS total FROM (
            SELECT DISTINCT q.spId FROM (
                SELECT pr.storeProductId AS spId
                  FROM ReceiptLineIssue rli
                  JOIN Price pr ON pr.receiptId = rli.receiptId
                 WHERE JSON_EXTRACT(rli.flags, '$.image') = TRUE
                   AND rli.status = 'pending'
                UNION ALL
                SELECT sp.id FROM StoreProduct sp WHERE sp.imageUrl IS NULL
            ) q
            WHERE NOT EXISTS (
                SELECT 1 FROM AdminCardLease l
                 WHERE l.spId = q.spId
                   AND l.queueKind = 'image'
                   AND l.completedAt IS NULL
                   AND l.abandonedAt IS NULL
                   AND l.expiresAt > NOW()
            )
        ) sub`,
    );
    return Number(rows[0]?.total ?? 0);
}
