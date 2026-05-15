import pool from '../config/db.js';
import { MatchThresholds } from '../config/matchThresholds.js';

/**
 * Queue model for the Uncategorised (Nepriskirti) admin tab — Tab 4.
 *
 * Surfaces `Product` rows sitting in the "Nepriskirta" fallback
 * bucket (categoryId = 688 by default — see
 * `MatchThresholds.nepriskirtaCategoryId`). These are products the
 * resolver couldn't slot into a proper L3 — admin assigns the
 * correct category, optionally fixes the name, or deletes the row.
 *
 * `Product.categoryId` is NOT NULL in the schema, so the fallback
 * id is the only signal we have to identify rescue candidates. If
 * other fallback buckets surface in production (e.g. a per-chain
 * "uncategorised"), append them to `FALLBACK_CATEGORY_IDS`.
 *
 * Ranking: high-traffic, multi-chain Products first, so a single
 * category assignment heals the biggest possible slice of the
 * browsing UX. SpId-stable tiebreak.
 *
 * Card key is `Product.id`. The lease layer stores it in
 * `AdminCardLease.spId` (single bigint, doubles as productId here —
 * same pattern the Flags tab uses for its encoded composite key).
 */

const RECENT_PURCHASE_WINDOW_DAYS = 30;
const FALLBACK_CATEGORY_IDS: number[] = [MatchThresholds.nepriskirtaCategoryId];

export interface UncategorisedQueueRow {
    productId: number;
    productName: string;
    /** Current category id + name (almost always null in this queue,
     *  except when it's a fallback-bucket id). */
    categoryId: number | null;
    categoryName: string | null;
    /** First non-null SP.imageUrl across this Product's chain SPs. */
    bestImageUrl: string | null;
    /** Number of receipt-driven Price rows in the last 30 days. */
    recentPurchaseCount: number;
    /** Comma-joined chain names with at least one SP for this Product. */
    chainCoverage: string;
    spCount: number;
    /** True iff any SP of this Product has a pending ReceiptLineIssue. */
    hasPendingFlags: boolean;
    /** Count of BaseProductLink rows touching this Product's baseProductId. */
    baseProductLinkCount: number;
}

/**
 * Pick the next batch of productIds eligible for the queue.
 * Excludes:
 *   - currently leased ids (queueKind='uncategorised')
 *   - ids touched by an admin action (`uncategorised_*`) in the last 90 days
 */
export async function pickUncategorisedProductIds(args: {
    batchSize: number;
}): Promise<number[]> {
    const wanted = Math.max(1, args.batchSize);

    // categoryId is NOT NULL in the schema; rescue candidates are
    // identified solely by the fallback bucket id list.
    if (FALLBACK_CATEGORY_IDS.length === 0) return [];
    const categoryClause = `p.categoryId IN (${FALLBACK_CATEGORY_IDS.join(',')})`;

    // Lean picker — just productIds ranked by p.id DESC (newest
    // first). The Nepriskirta bucket holds ~12k Products on the test
    // DB; an in-picker GROUP-BY join over their SPs + Prices is too
    // expensive for a typeahead-style query. The per-card recent
    // purchase count + chain coverage etc. come from the hydrate
    // step, which only runs on the 10 ids the lease layer claims.
    const [rows]: any = await pool.query(
        `SELECT p.id AS productId
           FROM Product p
          WHERE ${categoryClause}
            AND NOT EXISTS (
                SELECT 1 FROM AdminCardLease l
                 WHERE l.queueKind = 'uncategorised'
                   AND l.spId = p.id
                   AND l.completedAt IS NULL
                   AND l.abandonedAt IS NULL
                   AND l.expiresAt > NOW()
            )
            AND NOT EXISTS (
                SELECT 1 FROM AdminAuditLog a
                 WHERE a.targetType = 'Product'
                   AND a.targetId = p.id
                   AND a.action IN ('uncategorised_set', 'uncategorised_delete', 'uncategorised_skip')
                   AND a.reversedAt IS NULL
                   AND a.createdAt > NOW() - INTERVAL 90 DAY
            )
          ORDER BY p.id DESC
          LIMIT ?`,
        [wanted],
    );
    return (rows as any[]).map(r => Number(r.productId));
}

/**
 * Hydrate productIds into full card payloads. The picker only returns
 * ids so we can use the same `claimSpIds` helper as the flag queue;
 * the heavy joins live here, after the lease rows are written.
 */
export async function hydrateUncategorisedRows(
    productIds: number[],
    locale: string = 'lt',
): Promise<UncategorisedQueueRow[]> {
    if (productIds.length === 0) return [];

    const [
        [detailRows],
        [imageRows],
        [purchaseRows],
        [chainRows],
        [spCountRows],
        [flagRows],
        [bplRows],
    ]: any[] = await Promise.all([
        pool.query(
            `SELECT p.id AS productId,
                    p.name AS productName,
                    p.categoryId,
                    COALESCE(ct.name, c.name) AS categoryName
               FROM Product p
               LEFT JOIN Category c ON c.id = p.categoryId
               LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
              WHERE p.id IN (?)`,
            [locale, productIds],
        ),
        // First non-null image per Product (any chain).
        pool.query(
            `SELECT sp.productId, MIN(sp.imageUrl) AS bestImageUrl
               FROM StoreProduct sp
              WHERE sp.productId IN (?) AND sp.imageUrl IS NOT NULL
              GROUP BY sp.productId`,
            [productIds],
        ),
        pool.query(
            `SELECT sp.productId, COUNT(*) AS n
               FROM Price pr
               JOIN StoreProduct sp ON sp.id = pr.storeProductId
              WHERE sp.productId IN (?)
                AND pr.receiptId IS NOT NULL
                AND pr.date > NOW() - INTERVAL ? DAY
              GROUP BY sp.productId`,
            [productIds, RECENT_PURCHASE_WINDOW_DAYS],
        ),
        // Distinct chains touching each product (via SPs with at least
        // one Price). Aggregate as comma-joined chain names — small
        // result set, fine for the card view.
        pool.query(
            `SELECT sp.productId,
                    GROUP_CONCAT(DISTINCT sc.name ORDER BY sc.name SEPARATOR ', ') AS chainCoverage
               FROM StoreProduct sp
               JOIN StoreChain sc ON sc.id = sp.chainId
              WHERE sp.productId IN (?)
              GROUP BY sp.productId`,
            [productIds],
        ),
        pool.query(
            `SELECT productId, COUNT(*) AS n
               FROM StoreProduct
              WHERE productId IN (?)
              GROUP BY productId`,
            [productIds],
        ),
        // Any pending ReceiptLineIssue whose SP maps to one of these
        // Products. Resolves via Price (the SP-to-receipt link) since
        // ReceiptLineIssue itself doesn't carry storeProductId.
        pool.query(
            `SELECT DISTINCT sp.productId
               FROM ReceiptLineIssue rli
               JOIN Price pr ON pr.receiptId = rli.receiptId
               JOIN StoreProduct sp ON sp.id = pr.storeProductId
              WHERE rli.status = 'pending'
                AND sp.productId IN (?)`,
            [productIds],
        ),
        // BaseProductLink references baseProductId, not productId
        // directly. Surface the count so the admin sees "deleting this
        // could break cross-chain links" before they nuke it.
        pool.query(
            `SELECT p.id AS productId,
                    COALESCE((SELECT COUNT(*)
                                FROM BaseProductLink bpl
                               WHERE bpl.bpIdA = p.baseProductId
                                  OR bpl.bpIdB = p.baseProductId), 0) AS bplCount
               FROM Product p
              WHERE p.id IN (?)`,
            [productIds],
        ),
    ]);

    const detailById = new Map<number, any>();
    for (const r of detailRows as any[]) detailById.set(Number(r.productId), r);
    const imageById = new Map<number, string>();
    for (const r of imageRows as any[]) imageById.set(Number(r.productId), String(r.bestImageUrl));
    const purchaseById = new Map<number, number>();
    for (const r of purchaseRows as any[]) purchaseById.set(Number(r.productId), Number(r.n));
    const chainById = new Map<number, string>();
    for (const r of chainRows as any[]) chainById.set(Number(r.productId), String(r.chainCoverage ?? ''));
    const spCountById = new Map<number, number>();
    for (const r of spCountRows as any[]) spCountById.set(Number(r.productId), Number(r.n));
    const flagSet = new Set<number>();
    for (const r of flagRows as any[]) flagSet.add(Number(r.productId));
    const bplById = new Map<number, number>();
    for (const r of bplRows as any[]) bplById.set(Number(r.productId), Number(r.bplCount));

    return productIds
        .map(pid => {
            const d = detailById.get(pid);
            if (!d) return null;
            return {
                productId: pid,
                productName: String(d.productName ?? ''),
                categoryId: d.categoryId !== null && d.categoryId !== undefined
                    ? Number(d.categoryId) : null,
                categoryName: d.categoryName ?? null,
                bestImageUrl: imageById.get(pid) ?? null,
                recentPurchaseCount: purchaseById.get(pid) ?? 0,
                chainCoverage: chainById.get(pid) ?? '',
                spCount: spCountById.get(pid) ?? 0,
                hasPendingFlags: flagSet.has(pid),
                baseProductLinkCount: bplById.get(pid) ?? 0,
            };
        })
        .filter((r): r is UncategorisedQueueRow => r !== null);
}

/**
 * Pre-flight safety check for a delete attempt. Counts every ref that
 * would either fail the delete (FK) or silently lose data. Returns
 * non-empty when blocked; empty when safe.
 */
export interface DeleteBlocker {
    prices: number;
    basketItems: number;
    shoppingListItems: number;
}

export async function checkProductDeleteBlockers(productId: number): Promise<DeleteBlocker> {
    const [[priceRow]]: any = await pool.query(
        `SELECT COUNT(*) AS n FROM Price pr
           JOIN StoreProduct sp ON sp.id = pr.storeProductId
          WHERE sp.productId = ?`,
        [productId],
    );
    let basketItems = 0;
    let shoppingListItems = 0;
    // Best-effort — tables may not exist in every install.
    try {
        const [[r]]: any = await pool.query(
            `SELECT COUNT(*) AS n FROM BasketItem bi
               JOIN StoreProduct sp ON sp.id = bi.storeProductId
              WHERE sp.productId = ?`,
            [productId],
        );
        basketItems = Number(r?.n ?? 0);
    } catch { /* ignore */ }
    try {
        const [[r]]: any = await pool.query(
            `SELECT COUNT(*) AS n FROM ShoppingListItem sli
               JOIN StoreProduct sp ON sp.id = sli.storeProductId
              WHERE sp.productId = ?`,
            [productId],
        );
        shoppingListItems = Number(r?.n ?? 0);
    } catch { /* ignore */ }
    return {
        prices: Number(priceRow?.n ?? 0),
        basketItems,
        shoppingListItems,
    };
}
