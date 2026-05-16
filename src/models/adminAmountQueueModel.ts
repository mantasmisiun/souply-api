import pool from '../config/db.js';
import {
    parseAmountFromName,
    amountsAgree,
    isWeighableForUnit,
    type ParsedAmount,
    type CanonicalUnit,
} from '../utils/nameAmountParser.js';
import { loadCanonicalsForProducts } from '../services/productCanonical.js';

/**
 * Queue model for the admin amounts-cleanup tab.
 *
 * Detection runs JS-side: parse every candidate SP's name, compare
 * against stored DB values, surface only mismatches. SPs where the
 * parser finds nothing in the name are silently skipped — there's no
 * actionable signal.
 *
 * Priority order:
 *   1. User-flagged (`ReceiptLineIssue.flags.amount = true AND status='pending'`)
 *   2. Parser hit, doesn't agree with DB (mismatch)
 *
 * No "missing-only" tier — the parser is the gatekeeper. Real coverage
 * sits around 3.5 % of SPs (about 1 800 mismatches in test DB).
 *
 * Because the JS filter walks `pool` × candidates, we over-fetch a
 * broad SQL pool and trust the filter to find at least N actionable
 * rows. Pool size scales with batchSize to stay within reasonable
 * memory limits.
 */

const RECENT_PURCHASE_WINDOW_DAYS = 30;
const POOL_MULTIPLIER = 40;       // Fetch 40× requested rows; ~3.5 % parseable mismatch hit-rate
const MAX_POOL_SIZE = 2000;       // Hard ceiling so the picker never explodes
const MIN_POOL_SIZE = 100;

export interface AdminAmountQueueRow {
    spId: number;
    name: string;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    categoryName: string;
    storedAmount: number | null;
    storedUnit: string | null;
    storedIsWeighable: boolean;
    flaggedByUser: boolean;
    flagReceiptId: number | null;
    flagLineIdx: number | null;
    recentPurchaseCount: number;
    /**
     * Parsed amount + unit derived from the SP name. Non-null for rows
     * surfaced by the parser-mismatch path. May be null for canonical
     * outliers whose names don't carry parseable amount info — those
     * rows still need admin attention, just for a different reason.
     */
    suggestion: {
        amount: number;
        unit: CanonicalUnit;
        matched: string;
        isWeighable: boolean;
    } | null;
    /**
     * Non-null when this SP belongs to a Product whose canonical unit
     * family differs from the SP's own family — i.e. the matcher gate
     * would refuse this merge today, but a legacy SP slipped through
     * before the gate was in place. Surfaces with priority in the admin
     * queue so the data team can split it into its own Product or fix
     * the unit. Format: short machine code, e.g. "outlier:family".
     */
    outlierReason: string | null;
}

/**
 * Resolve the next batch of spIds for an admin claim. Two-stage:
 *
 *   1. SQL picks a pool ranked by (flagged DESC, recentPurchase DESC,
 *      spId ASC), excluding currently-leased SPs.
 *   2. JS walks the pool, parses names, keeps the rows whose parsed
 *      result disagrees with the DB. Stops at `batchSize` hits.
 *
 * Returns the spIds to lease. `claimBatch` in adminLeaseModel handles
 * the actual lease INSERT atomically. The hydrate step turns these
 * into AdminAmountQueueRow with the parsed suggestion attached.
 *
 * Note: this can't be expressed as plain SQL because the parser is
 * non-trivial regex logic. Trying to embed it in SQL via REGEXP would
 * be slow and unreadable.
 */
/**
 * Find SPs that are canonical-unit outliers in their Product (e.g. a 1 vnt
 * row in an otherwise all-kg cluster). Returns spIds sorted by
 * recent-purchase count (priority), excluding rows that are already
 * leased, currently flagged, or recently admin-resolved — same exclusion
 * rules as the parser-mismatch path so a single SP can't appear twice.
 */
async function pickOutlierSpIds(args: {
    limit: number;
    excludeSpIds: number[];
}): Promise<number[]> {
    const { limit, excludeSpIds } = args;
    if (limit <= 0) return [];

    // Step 1: find candidate Products — those whose SP set spans more than
    // one unit family. Done in SQL with a coarse family classifier so we
    // only canonicalise the small set of multi-family Products, not every
    // Product in the catalog.
    const [productRows]: any = await pool.query(
        `SELECT productId
           FROM (
               SELECT sp.productId,
                      COUNT(DISTINCT
                          CASE
                              WHEN sp.unit IN ('kg','g','l','ml') THEN 'fluid'
                              WHEN sp.unit IN ('vnt','pak','rit') THEN 'count'
                          END
                      ) AS familyCount
                 FROM StoreProduct sp
                 JOIN Product p ON p.id = sp.productId
                WHERE p.mergedIntoId IS NULL
                  AND sp.unit IS NOT NULL
                GROUP BY sp.productId
           ) ps
          WHERE familyCount > 1
          LIMIT 5000`,
    );
    if (!productRows.length) return [];

    const productIds = (productRows as any[]).map(r => Number(r.productId));
    const canonicals = await loadCanonicalsForProducts(productIds);
    const outlierSpIds = new Set<number>();
    for (const meta of canonicals.values()) {
        if (!meta) continue;
        for (const id of meta.outlierSpIds) outlierSpIds.add(id);
    }
    if (outlierSpIds.size === 0) return [];

    // Step 2: drop excluded + already-actioned spIds. Same exclusion rules
    // as the parser-mismatch path — leased to anyone, pending flag, or
    // resolved in the last 90 days.
    const excludedSet = new Set(excludeSpIds);
    const candidateIds = [...outlierSpIds].filter(id => !excludedSet.has(id));
    if (candidateIds.length === 0) return [];

    const [filterRows]: any = await pool.query(
        `SELECT sp.id AS spId,
                COALESCE(pa.recentPurchaseCount, 0) AS recentPurchaseCount
           FROM StoreProduct sp
           LEFT JOIN (
                SELECT storeProductId, COUNT(*) AS recentPurchaseCount
                  FROM Price
                 WHERE receiptId IS NOT NULL
                   AND date > NOW() - INTERVAL ? DAY
                 GROUP BY storeProductId
           ) pa ON pa.storeProductId = sp.id
          WHERE sp.id IN (?)
            AND NOT EXISTS (
                SELECT 1 FROM AdminCardLease l
                 WHERE l.spId = sp.id
                   AND l.queueKind = 'amount'
                   AND l.completedAt IS NULL
                   AND l.abandonedAt IS NULL
                   AND l.expiresAt > NOW()
            )
            AND NOT EXISTS (
                SELECT 1 FROM ReceiptLineIssue rli
                 JOIN Price pr ON pr.receiptId = rli.receiptId
                 WHERE pr.storeProductId = sp.id
                   AND JSON_EXTRACT(rli.flags, '$.amount') = TRUE
                   AND rli.status = 'pending'
            )
            AND NOT EXISTS (
                SELECT 1 FROM AdminAuditLog a
                 WHERE a.targetType = 'StoreProduct'
                   AND a.targetId = sp.id
                   AND a.action IN ('amount_set', 'amount_skip')
                   AND a.reversedAt IS NULL
                   AND a.createdAt > NOW() - INTERVAL 90 DAY
            )
          ORDER BY recentPurchaseCount DESC, sp.id DESC
          LIMIT ?`,
        [RECENT_PURCHASE_WINDOW_DAYS, candidateIds, limit],
    );
    return (filterRows as any[]).map(r => Number(r.spId));
}

export async function pickAmountQueueSpIds(args: {
    batchSize: number;
    excludeSpIds?: number[];      // already-leased to this admin in a previous step (resume case)
}): Promise<number[]> {
    const wanted = Math.max(1, args.batchSize);
    const poolSize = Math.min(MAX_POOL_SIZE, Math.max(MIN_POOL_SIZE, wanted * POOL_MULTIPLIER));
    const excluded = (args.excludeSpIds ?? []).filter(n => Number.isInteger(n));

    // PRIORITY: canonical outliers. These are SPs that the matcher gate
    // would block today but slipped in before the gate existed. They block
    // the calc service from offering them as the cheapest option (calc
    // filters outliers out), so resolving them unlocks better price hits.
    //
    // Cap outliers at half the batch so the parser-mismatch path doesn't
    // starve when many outliers exist — admins still want a mix of card
    // types per session, not 25 outliers in a row.
    const outlierCap = Math.max(1, Math.ceil(wanted / 2));
    const outlierHits = await pickOutlierSpIds({ limit: outlierCap, excludeSpIds: excluded });
    const remaining = wanted - outlierHits.length;
    if (remaining <= 0) return outlierHits;
    const outlierSet = new Set(outlierHits);

    // Two perf-critical decisions here:
    //
    // 1. Recent-purchase counts come from a single GROUP BY join, not
    //    a correlated subquery. Per-row subqueries multiply the cost
    //    by the (50k+ SP) pool size; one aggregate scan over Price
    //    runs in milliseconds and shifts the sort to RAM.
    //
    // 2. Name pre-filter `REGEXP '[0-9]'` skips SPs whose names lack
    //    any digit — those can never produce a parseable suggestion,
    //    so feeding them through the JS regex is wasted work. Cuts
    //    the candidate pool ~half against real catalog data.
    //
    // Heuristic-only pool. User-flagged amount reports now route
    // through the Flags tab — a flagged item resolved from either
    // side would lead to double-counted audit entries, so single-
    // owner-per-flag-type keeps the lifecycle clean.
    const [rows]: any = await pool.query(
        `SELECT sp.id AS spId,
                COALESCE(sp.storeProductName, p.name) AS name,
                sp.amount AS storedAmount,
                sp.unit   AS storedUnit,
                sp.isWeighable AS storedIsWeighable,
                COALESCE(pa.recentPurchaseCount, 0) AS recentPurchaseCount
           FROM StoreProduct sp
           JOIN Product p ON p.id = sp.productId
           LEFT JOIN (
                SELECT storeProductId, COUNT(*) AS recentPurchaseCount
                  FROM Price
                 WHERE receiptId IS NOT NULL
                   AND date > NOW() - INTERVAL ? DAY
                 GROUP BY storeProductId
           ) pa ON pa.storeProductId = sp.id
          WHERE COALESCE(sp.storeProductName, '') REGEXP '[0-9]'
            AND NOT EXISTS (
                SELECT 1 FROM AdminCardLease l
                 WHERE l.spId = sp.id
                   AND l.queueKind = 'amount'
                   AND l.completedAt IS NULL
                   AND l.abandonedAt IS NULL
                   AND l.expiresAt > NOW()
            )
            -- Cede ownership to the Flags tab: any SP with a pending
            -- amount flag belongs there, not here.
            AND NOT EXISTS (
                SELECT 1 FROM ReceiptLineIssue rli
                 JOIN Price pr ON pr.receiptId = rli.receiptId
                 WHERE pr.storeProductId = sp.id
                   AND JSON_EXTRACT(rli.flags, '$.amount') = TRUE
                   AND rli.status = 'pending'
            )
            -- "Recently-resolved" filter: an admin already acted on
            -- this SP (confirmed an amount or skipped). Skip for 90
            -- days so the same card doesnt keep coming back when the
            -- admins override didnt match the parsers suggestion.
            -- The reversedAt IS NULL clause lets a reverted action
            -- put the row back into the queue immediately. The
            -- amount_revert action is intentionally excluded from the
            -- action list so a revert re-surfaces the card right away.
            AND NOT EXISTS (
                SELECT 1 FROM AdminAuditLog a
                 WHERE a.targetType = 'StoreProduct'
                   AND a.targetId = sp.id
                   AND a.action IN ('amount_set', 'amount_skip')
                   AND a.reversedAt IS NULL
                   AND a.createdAt > NOW() - INTERVAL 90 DAY
            )
            ${excluded.length > 0 ? 'AND sp.id NOT IN (?)' : ''}
          ORDER BY recentPurchaseCount DESC, sp.id DESC
          LIMIT ?`,
        excluded.length > 0
            ? [RECENT_PURCHASE_WINDOW_DAYS, excluded, poolSize]
            : [RECENT_PURCHASE_WINDOW_DAYS, poolSize],
    );

    const hits: number[] = [];
    for (const r of rows as any[]) {
        const spId = Number(r.spId);
        if (outlierSet.has(spId)) continue;                     // already in outlier hits
        const parsed = parseAmountFromName(String(r.name ?? ''));
        if (!parsed) continue;                                  // unparseable → skip
        const storedAmountNum = r.storedAmount !== null && r.storedAmount !== undefined
            ? parseFloat(String(r.storedAmount))
            : null;
        const agrees = amountsAgree(parsed, {
            amount: storedAmountNum,
            unit: r.storedUnit ?? null,
        });
        if (agrees) continue;                                   // matched → no admin work
        hits.push(spId);
        if (hits.length >= remaining) break;
    }
    return [...outlierHits, ...hits];
}

/**
 * Hydrate a set of leased spIds into full queue rows.
 *
 * Same shape pattern as adminImageQueueModel.hydrateImageQueueRows —
 * parallel queries for details + flag info + recent-purchase counts,
 * with the parsed suggestion attached per row.
 */
export async function hydrateAmountQueueRows(
    spIds: number[],
    locale: string = 'lt',
): Promise<AdminAmountQueueRow[]> {
    if (spIds.length === 0) return [];

    const [
        [detailRows],
        [flagRows],
        [purchaseRows],
    ]: any[] = await Promise.all([
        pool.query(
            `SELECT sp.id AS spId,
                    COALESCE(sp.storeProductName, p.name) AS name,
                    sp.amount AS storedAmount,
                    sp.unit   AS storedUnit,
                    sp.isWeighable AS storedIsWeighable,
                    sp.chainId,
                    sc.name   AS chainName,
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
        pool.query(
            `SELECT DISTINCT pr.storeProductId AS spId,
                    rli.receiptId, rli.receiptLineIdx
               FROM ReceiptLineIssue rli
               JOIN Price pr ON pr.receiptId = rli.receiptId
              WHERE JSON_EXTRACT(rli.flags, '$.amount') = TRUE
                AND rli.status = 'pending'
                AND pr.storeProductId IN (?)`,
            [spIds],
        ),
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

    // Build a set of outlier spIds (those whose Product canonical family
    // doesn't include them) so hydrate can flag them with `outlierReason`
    // even when the name parser doesn't fire. We fetch canonical-aware
    // Products for the SPs in scope.
    const productIdsForSps = new Set<number>();
    {
        const [pidRows]: any = await pool.query(
            `SELECT id, productId FROM StoreProduct WHERE id IN (?)`,
            [spIds],
        );
        for (const r of pidRows as any[]) productIdsForSps.add(Number(r.productId));
    }
    const canonicalsForOutlierCheck = productIdsForSps.size > 0
        ? await loadCanonicalsForProducts([...productIdsForSps])
        : new Map();
    const outlierSpSet = new Set<number>();
    for (const meta of canonicalsForOutlierCheck.values()) {
        if (!meta) continue;
        for (const id of meta.outlierSpIds) outlierSpSet.add(id);
    }

    const out: AdminAmountQueueRow[] = [];
    for (const spId of spIds) {
        const d = detailBySpId.get(spId);
        if (!d) continue;
        const parsed: ParsedAmount | null = parseAmountFromName(String(d.name ?? ''));
        const isOutlier = outlierSpSet.has(spId);
        // Skip rows where neither signal applies (e.g. a name edit between
        // claim and hydrate dropped the parser hit AND the SP isn't an
        // outlier — neither path has anything actionable to show).
        if (!parsed && !isOutlier) continue;
        const flag = flagBySpId.get(spId);
        out.push({
            spId,
            name: String(d.name ?? ''),
            chainId: Number(d.chainId ?? 0),
            chainName: String(d.chainName ?? ''),
            chainLogoUrl: d.chainLogoUrl ?? null,
            categoryName: String(d.categoryName ?? ''),
            storedAmount: d.storedAmount !== null && d.storedAmount !== undefined
                ? parseFloat(String(d.storedAmount))
                : null,
            storedUnit: d.storedUnit ?? null,
            storedIsWeighable: !!Number(d.storedIsWeighable),
            flaggedByUser: !!flag,
            flagReceiptId: flag ? flag.receiptId : null,
            flagLineIdx: flag ? flag.receiptLineIdx : null,
            recentPurchaseCount: purchaseCountBySpId.get(spId) ?? 0,
            suggestion: parsed
                ? {
                    amount: parsed.amount,
                    unit: parsed.unit,
                    matched: parsed.matched,
                    isWeighable: isWeighableForUnit(parsed.unit),
                }
                : null,
            outlierReason: isOutlier ? 'outlier:family' : null,
        });
    }
    return out;
}

/**
 * Outstanding count is omitted from the amounts tab. Computing it
 * requires running the parser over every SP — that's the scan script's
 * job (`npx tsx src/scripts/scanAmountCoverage.ts`). The client tab
 * just shows the admin's current batch progress; admins claim until
 * the picker comes back empty.
 */
