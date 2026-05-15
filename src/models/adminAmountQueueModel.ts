import pool from '../config/db.js';
import {
    parseAmountFromName,
    amountsAgree,
    isWeighableForUnit,
    type ParsedAmount,
    type CanonicalUnit,
} from '../utils/nameAmountParser.js';

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
    /** Parsed amount + unit derived from the SP name. Always non-null
     *  for rows that reach the admin tab — the picker filters out
     *  unparseable names before claiming. */
    suggestion: {
        amount: number;
        unit: CanonicalUnit;
        matched: string;
        isWeighable: boolean;
    };
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
export async function pickAmountQueueSpIds(args: {
    batchSize: number;
    excludeSpIds?: number[];      // already-leased to this admin in a previous step (resume case)
}): Promise<number[]> {
    const wanted = Math.max(1, args.batchSize);
    const poolSize = Math.min(MAX_POOL_SIZE, Math.max(MIN_POOL_SIZE, wanted * POOL_MULTIPLIER));
    const excluded = (args.excludeSpIds ?? []).filter(n => Number.isInteger(n));

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
        hits.push(Number(r.spId));
        if (hits.length >= wanted) break;
    }
    return hits;
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

    const out: AdminAmountQueueRow[] = [];
    for (const spId of spIds) {
        const d = detailBySpId.get(spId);
        if (!d) continue;
        const parsed: ParsedAmount | null = parseAmountFromName(String(d.name ?? ''));
        // Sanity: a row in the lease without a parser hit shouldn't be
        // possible (the picker filtered them out), but if a name was
        // edited between claim and hydrate, skip gracefully.
        if (!parsed) continue;
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
            suggestion: {
                amount: parsed.amount,
                unit: parsed.unit,
                matched: parsed.matched,
                isWeighable: isWeighableForUnit(parsed.unit),
            },
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
