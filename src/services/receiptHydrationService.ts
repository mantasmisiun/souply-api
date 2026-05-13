import pool from '../config/db.js';

/**
 * Read-time category enrichment for receipt responses.
 *
 * Receipts store the matched product candidates (altMatches) with cached
 * categoryName / categoryL2Name from upload time. That cache goes stale
 * any time the catalog moves a product between categories — most
 * commonly when the swipe-vote "rescue" path promotes an SP out of the
 * Nepriskirta bucket (Product.categoryId 688 → real category) once
 * enough users vote "identical" on a candidate pair.
 *
 * Strategy: every receipt GET re-resolves categories live from
 * StoreProduct → Product.categoryId → Category. Never persisted back —
 * parsedData stays the immutable upload snapshot; the enrichment lives
 * only in the response. This is the read-through pattern used by
 * Stripe / GitHub / Slack for derived values: no cache invalidation
 * logic, always correct, and the API contract stays stable so a Redis
 * cache layer can slot in later without touching the client.
 *
 * Lookup is keyed by altMatches[*].storeProductId rather than the
 * cached categoryId, because the SP→Product mapping is stable across
 * rescues (categoryId on the Product moves; the SP ID does not). Falls
 * back to the stored value when an SP has been deleted between upload
 * and now.
 *
 * Returns the receipt with the same parsedData shape (string vs object)
 * the caller passed in.
 */

interface SpCategoryRow {
    spId: number;
    productId: number | null;
    categoryId: number | null;
    leafName: string | null;
    l2Name: string | null;
}

interface PersonalRescue {
    categoryId: number | null;
    leafName: string | null;
    l2Name: string | null;
}

const collectSpIds = (parsed: any): number[] => {
    const ids = new Set<number>();
    if (!parsed || !Array.isArray(parsed.products)) return [];
    for (const p of parsed.products) {
        if (!Array.isArray(p?.altMatches)) continue;
        for (const am of p.altMatches) {
            const id = Number(am?.storeProductId);
            if (Number.isFinite(id) && id > 0) ids.add(id);
        }
    }
    return Array.from(ids);
};

/**
 * For a given user, resolve orphan Products (categoryId=688) through their
 * personal "identical" votes. The global promotion path requires a
 * Wilson threshold of 3+ voters — so a single user testing alone never
 * sees their Neatpažinta count drop without this override.
 *
 * Keyed by `orphanProductId` (NOT spId): when the user pairs orphan SP X
 * with candidate SP Y via "identical", the rescue should apply to every
 * SP that points to X's Product — different chains list the same
 * physical product under different SPs (e.g. "Žemės riešutai GAR2" and
 * "Žemės riešutai JĖGA" share Product 99159). Keying on SP missed every
 * sibling row.
 *
 * The caller overlays this on top of the global resolution; it doesn't
 * change Product.categoryId, just the per-user receipt view.
 */
const fetchUserPersonalRescues = async (
    userId: string,
    productIds: number[],
): Promise<Map<number, PersonalRescue>> => {
    const map = new Map<number, PersonalRescue>();
    if (productIds.length === 0) return map;
    const [rows]: any = await pool.query(
        `SELECT
             CASE WHEN pA.categoryId = 688 THEN pA.id ELSE pB.id END AS orphanProductId,
             CASE WHEN pA.categoryId = 688 THEN pB.categoryId ELSE pA.categoryId END AS categoryId,
             CASE WHEN pA.categoryId = 688 THEN cB.name ELSE cA.name END AS leafName,
             CASE WHEN pA.categoryId = 688
               THEN CASE
                 WHEN cB.parentCategoryId IS NULL  THEN NULL
                 WHEN cB2.parentCategoryId IS NULL THEN cB.name
                 ELSE cB2.name
               END
               ELSE CASE
                 WHEN cA.parentCategoryId IS NULL  THEN NULL
                 WHEN cA2.parentCategoryId IS NULL THEN cA.name
                 ELSE cA2.name
               END
             END AS l2Name
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct spA ON spA.id = e.spIdA
           JOIN StoreProduct spB ON spB.id = e.spIdB
           JOIN Product pA ON pA.id = spA.productId
           JOIN Product pB ON pB.id = spB.productId
           LEFT JOIN Category cA  ON cA.id  = pA.categoryId
           LEFT JOIN Category cA2 ON cA2.id = cA.parentCategoryId
           LEFT JOIN Category cB  ON cB.id  = pB.categoryId
           LEFT JOIN Category cB2 ON cB2.id = cB.parentCategoryId
          WHERE e.userId = ?
            AND e.verdict = 'same'
            AND ((pA.categoryId = 688 AND pB.categoryId != 688 AND pA.id IN (?))
              OR (pB.categoryId = 688 AND pA.categoryId != 688 AND pB.id IN (?)))`,
        [userId, productIds, productIds],
    );
    for (const r of rows) {
        const pid = Number(r.orphanProductId);
        if (!Number.isFinite(pid)) continue;
        map.set(pid, {
            categoryId: r.categoryId !== null ? Number(r.categoryId) : null,
            leafName: r.leafName ?? null,
            l2Name: r.l2Name ?? null,
        });
    }
    return map;
};

const fetchSpCategories = async (spIds: number[]): Promise<Map<number, SpCategoryRow>> => {
    const map = new Map<number, SpCategoryRow>();
    if (spIds.length === 0) return map;
    // Same CASE as statsService / storeProductModel — single source of
    // truth for L2 resolution so the breakdown, Profilis, and the
    // match endpoint all label products identically.
    //   c is L1                       → L2 = NULL (excluded from breakdown)
    //   c is L2 (c2.parent IS NULL)   → L2 = c.name
    //   c is L3                       → L2 = c2.name (the L2 parent)
    const [rows]: any = await pool.query(
        `SELECT sp.id AS spId, sp.productId, p.categoryId,
                c.name AS leafName,
                CASE
                  WHEN c.parentCategoryId IS NULL  THEN NULL
                  WHEN c2.parentCategoryId IS NULL THEN c.name
                  ELSE c2.name
                END AS l2Name
           FROM StoreProduct sp
           JOIN Product p   ON p.id  = sp.productId
           LEFT JOIN Category c  ON c.id  = p.categoryId
           LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
          WHERE sp.id IN (?)`,
        [spIds],
    );
    for (const r of rows) {
        map.set(Number(r.spId), {
            spId: Number(r.spId),
            productId: r.productId !== null ? Number(r.productId) : null,
            categoryId: r.categoryId !== null ? Number(r.categoryId) : null,
            leafName: r.leafName ?? null,
            l2Name: r.l2Name ?? null,
        });
    }
    return map;
};

/**
 * Live-resolves category fields on altMatches[*] of the receipt's
 * parsedData. Backward-compat alias of the old name; renamed
 * semantically to "live" because the behaviour is read-through, not a
 * one-shot migration.
 */
export const hydrateReceiptCategoriesIfNeeded = async (
    _receiptId: number,
    receipt: any,
): Promise<any> => {
    return resolveReceiptCategoriesLive(receipt);
};

export const resolveReceiptCategoriesLive = async (receipt: any): Promise<any> => {
    if (!receipt?.parsedData) return receipt;

    const parsedDataIsString = typeof receipt.parsedData === 'string';
    let parsed: any;
    try {
        parsed = parsedDataIsString ? JSON.parse(receipt.parsedData) : receipt.parsedData;
    } catch {
        // Malformed parsedData — let the caller's error path handle it.
        return receipt;
    }
    if (!parsed || !Array.isArray(parsed.products)) return receipt;

    const spIds = collectSpIds(parsed);
    if (spIds.length === 0) return receipt;

    // The receipt owner is the only viewer of this endpoint, so we use
    // their userId to resolve personal "identical" votes on top of the
    // global Product.categoryId. The global promotion threshold
    // (Wilson lower bound, 3+ voters) means a solo user never sees
    // Neatpažinta drop without this overlay.
    const liveBySp = await fetchSpCategories(spIds);
    const ownerUserId: string | null = typeof receipt.userId === 'string' ? receipt.userId : null;
    // Collect the Product ids behind the SPs we just resolved — personal
    // rescues are keyed by Product so a vote on one chain's SP rescues
    // every sibling SP that shares the same Product.
    const productIds = Array.from(new Set(
        Array.from(liveBySp.values())
            .map(v => v.productId)
            .filter((id): id is number => id !== null && Number.isFinite(id)),
    ));
    const personalRescues = ownerUserId
        ? await fetchUserPersonalRescues(ownerUserId, productIds)
        : new Map<number, PersonalRescue>();

    // Overwrite cached categoryId / categoryName / categoryL2Name on
    // every altMatches[*] whose SP we resolved. SPs that have been
    // deleted between upload and now are skipped — we preserve the
    // stored value rather than blanking it, on the principle that a
    // deleted-SP receipt line is rare and the stored snapshot is
    // strictly more informative than null. Personal rescues win over
    // the global resolution when both are present.
    for (const p of parsed.products) {
        if (!Array.isArray(p?.altMatches)) continue;
        for (const am of p.altMatches) {
            const spId = Number(am?.storeProductId);
            if (!Number.isFinite(spId) || spId <= 0) continue;
            const live = liveBySp.get(spId);
            if (!live) continue;
            const personal = live.productId !== null ? personalRescues.get(live.productId) : undefined;
            const source: { categoryId: number | null; leafName: string | null; l2Name: string | null } = personal ?? live;
            am.categoryId = source.categoryId;
            am.categoryName = source.leafName;
            am.categoryL2Name = source.l2Name;
        }
    }

    return {
        ...receipt,
        parsedData: parsedDataIsString ? JSON.stringify(parsed) : parsed,
    };
};
