import pool from '../config/db.js';
import { nameSimilarity } from '../utils/productNameNormalize.js';
import type { RawSlot2Row } from '../services/slot2QueueBuilder.js';
import type { Locale } from '../middleware/locale.js';
import { localizedSpNameSql } from '../middleware/locale.js';

/**
 * Slot 2 candidate minimum similarity (cross-chain name match).
 *
 * Lowered from 0.75 → 0.60 because 0.75 starves real users: at 0.75
 * only ~8 of a typical 100+-orphan user's products surfaced a viable
 * candidate, and once those were voted the queue dried up forever
 * (and Neatpažinta stayed stuck). Private-label and brand-prefixed
 * names (LIDL/ICA/BON GELATI/etc.) rarely share enough trigrams with
 * generic catalog rows to clear 0.75 even when they're obviously the
 * same product.
 *
 * Lower bar surfaces more swipe cards. Wrong matches still get
 * filtered: the user swipes "Skirtinga" (different), the vote is
 * recorded, and the same pair is never shown again. Net effect is
 * 5× more rescuable orphans per user.
 */
const SLOT2_MIN_SCORE = 0.60;
const SLOT2B_ANCHOR_MIN_SCORE = 0.85;
/**
 * Slot-2a "reject → next candidate": the OSC seeder stores up to TOP_K (=5) ranked
 * cross-chain candidates per orphan. 2a fetches ranks 1..this and, per orphan, serves
 * the LOWEST-ranked one the user hasn't already voted on — so a 'different' on the
 * rank-1 pair advances to rank-2 instead of hiding the orphan forever. Mirrors the
 * seeder's TOP_K. */
const SLOT2A_MAX_RANK = 5;

function canonicalPairKey(spA: number, spB: number): string {
    return `${Math.min(spA, spB)}-${Math.max(spA, spB)}`;
}
/**
 * Safety cap: orphans per chain fetched for Slot 2b fallback pass.
 *
 * The slot 2b orphan pool is anchored to the USER'S OWN orphan SPs first
 * (so receipts they uploaded surface their own Nepriskirta items, which
 * is what the user expects when they hit "Pagerinti atpažinimą"). When
 * that pool is small we top up with a global same-chain sample for breadth
 * — that's what this cap protects.
 */
const MAX_GLOBAL_ORPHANS_PER_CHAIN = 50;

// ── Slot 2a ────────────────────────────────────────────────────────────────

/**
 * Slot 2a — Uncategorised product rescue via OrphanSwipeCandidate.
 *
 * For each auto-matched SP in the user's receipts that is orphaned
 * (Product.categoryId = 688), surface the best UNVOTED cross-chain candidate
 * from OrphanSwipeCandidate (score ≥ floor). These pairs let the user confirm
 * whether the orphan is the same product as its best candidate, rescuing it
 * from the "Nepriskirta" bucket on community consensus.
 *
 * REJECT → NEXT: a 'different' vote records the rank-1 pair in `votedPairKeys`;
 * rather than hiding the orphan (the old `rankPos = 1` join did exactly that),
 * we fetch ranks 1..SLOT2A_MAX_RANK and, per orphan, serve the lowest-ranked
 * pair not yet voted — so the orphan offers candidate #2, #3, … over sessions.
 * When `votedPairKeys` is omitted this reduces to the old rank-1 behaviour.
 */
async function fetchSlot2aRows(
    userId: string,
    priorityReceiptId?: number,
    locale: Locale = 'lt',
    votedPairKeys?: Set<string>,
): Promise<RawSlot2Row[]> {
    // Optional receipt scoping. Mirrors slot 1/3 filter style: when a
    // receipt is in focus, only return orphans from THAT receipt so
    // the voluntary-mode swipe queue actually moves THIS receipt's
    // Nepriskirta number instead of resolving unrelated orphans from
    // the user's history.
    const receiptFilter = priorityReceiptId !== undefined ? 'AND r.id = ?' : '';
    const params: any[] = priorityReceiptId !== undefined
        ? [SLOT2A_MAX_RANK, SLOT2_MIN_SCORE, locale, locale, userId, priorityReceiptId]
        : [SLOT2A_MAX_RANK, SLOT2_MIN_SCORE, locale, locale, userId];
    const [rawRows]: any = await pool.query(
        `SELECT DISTINCT
             osp.id                                    AS orphanSpId,
             osc.candidateSpId                         AS candidateSpId,
             osc.similarityScore                       AS score,
             osc.rankPos                               AS rankPos,
             (osp.chainId = csp.chainId)              AS sameChain,
             op.id                                     AS orphanProductId,
             ${localizedSpNameSql(locale, 'osp', 'COALESCE(osp.storeProductName, op.name)')}   AS orphanName,
             osp.brandName                             AS orphanBrandName,
             osp.imageUrl                              AS orphanImageUrl,
             osp.unit                                  AS orphanUnit,
             osp.chainId                               AS orphanChainId,
             ochain.name                               AS orphanChainName,
             ochain.logoUrl                            AS orphanChainLogoUrl,
             op.categoryId                             AS orphanCategoryId,
             COALESCE(oct.name, oc.name)               AS orphanCategoryName,
             cp.id                                     AS candidateProductId,
             ${localizedSpNameSql(locale, 'csp', 'COALESCE(csp.storeProductName, cp.name)')}   AS candidateName,
             csp.brandName                             AS candidateBrandName,
             csp.imageUrl                              AS candidateImageUrl,
             csp.unit                                  AS candidateUnit,
             csp.chainId                               AS candidateChainId,
             cchain.name                               AS candidateChainName,
             cchain.logoUrl                            AS candidateChainLogoUrl,
             cp.categoryId                             AS candidateCategoryId,
             COALESCE(cct.name, cc.name)               AS candidateCategoryName
           FROM Receipt r
           JOIN ReceiptSwipeCandidate rsc
             ON rsc.receiptId   = r.id
            AND rsc.autoMatched = 1
           JOIN StoreProduct   osp    ON osp.id   = rsc.storeProductId
           JOIN Product        op     ON op.id    = osp.productId
            AND op.categoryId   = 688
            AND op.mergedIntoId IS NULL
           JOIN OrphanSwipeCandidate osc
             ON osc.orphanProductId  = op.id
            AND osc.resolved         = 0
            AND osc.rankPos         <= ?
            AND osc.similarityScore >= ?
            -- The seeder picks ONE canonical orphanSpId per Product (the
            -- freshest-priced SP). Joining on Product instead of SP makes
            -- the user's actual orphan SP visible even when the seeder
            -- picked a different SP from the same Product. Without this,
            -- 62 of the user's 119 orphan SPs (~52%) were invisible to
            -- slot 2a even though their Product had candidates.
           JOIN StoreProduct   csp    ON csp.id   = osc.candidateSpId
           JOIN Product        cp     ON cp.id    = csp.productId
            AND cp.mergedIntoId IS NULL
           JOIN StoreChain     ochain ON ochain.id = osp.chainId
           JOIN StoreChain     cchain ON cchain.id = csp.chainId
           JOIN Category       oc     ON oc.id    = op.categoryId
           JOIN Category       cc     ON cc.id    = cp.categoryId
           LEFT JOIN CategoryTranslation oct ON oct.categoryId = oc.id AND oct.locale = ?
           LEFT JOIN CategoryTranslation cct ON cct.categoryId = cc.id AND cct.locale = ?
          WHERE r.userId = ?
          ${receiptFilter}
          ORDER BY osp.id ASC, osc.rankPos ASC`,
        params,
    );

    // REJECT → NEXT: rows arrive grouped by orphan (osp.id) and ordered by rankPos
    // ascending. Per orphan, keep the FIRST (lowest-rank) candidate whose canonical
    // pair the user hasn't voted on — a rejected rank-1 pair is skipped so rank-2
    // surfaces next. One card per orphan (no rank spam). Empty voted set ⇒ rank-1,
    // i.e. the previous behaviour.
    const voted = votedPairKeys ?? new Set<string>();
    const rows: any[] = [];
    const chosen = new Set<number>();
    for (const r of rawRows as any[]) {
        const orphanSpId = Number(r.orphanSpId);
        if (chosen.has(orphanSpId)) continue; // already took a lower-ranked candidate
        if (voted.has(canonicalPairKey(orphanSpId, Number(r.candidateSpId)))) continue; // rejected → try next rank
        chosen.add(orphanSpId);
        rows.push(r);
    }

    return (rows as any[]).map((r): RawSlot2Row => ({
        source: '2a',
        orphanSpId: Number(r.orphanSpId),
        candidateSpId: Number(r.candidateSpId),
        score: Number(r.score),
        sameChain: !!r.sameChain,
        orphan: {
            productId: Number(r.orphanProductId),
            name: String(r.orphanName),
            brandName: r.orphanBrandName ?? null,
            imageUrl: r.orphanImageUrl ?? null,
            unit: r.orphanUnit ?? null,
            chainId: Number(r.orphanChainId),
            chainName: String(r.orphanChainName),
            chainLogoUrl: r.orphanChainLogoUrl ?? null,
            categoryId: Number(r.orphanCategoryId),
            categoryName: String(r.orphanCategoryName),
        },
        candidate: {
            productId: Number(r.candidateProductId),
            name: String(r.candidateName),
            brandName: r.candidateBrandName ?? null,
            imageUrl: r.candidateImageUrl ?? null,
            unit: r.candidateUnit ?? null,
            chainId: Number(r.candidateChainId),
            chainName: String(r.candidateChainName),
            chainLogoUrl: r.candidateChainLogoUrl ?? null,
            categoryId: Number(r.candidateCategoryId),
            categoryName: String(r.candidateCategoryName),
        },
    }));
}

// ── Slot 2b ────────────────────────────────────────────────────────────────

/**
 * Slot 2b — Anchored rescue.
 *
 * For each well-matched, categorised SP in the user's receipts (score ≥ 0.85),
 * find orphaned SPs (categoryId = 688) from the SAME chain whose name is
 * similar (≥ 0.75) to the anchor. The anchor acts as a trusted reference:
 * if the user confirms the orphan matches it, the orphan inherits the anchor's
 * category (and possibly its image on same-chain votes).
 *
 * Name similarity is computed in JS; the DB provides the raw candidate pool.
 */
async function fetchSlot2bRows(userId: string, priorityReceiptId?: number, locale: Locale = 'lt'): Promise<RawSlot2Row[]> {
    // Step 1: anchor SPs — well-matched, categorised, from user's receipts.
    // When a receipt is in focus, restrict anchors to that receipt so the
    // candidate pool (orphans whose name fuzzy-matches an anchor) is
    // shaped by the user's current receipt context.
    const receiptFilter = priorityReceiptId !== undefined ? 'AND r.id = ?' : '';
    const anchorParams: any[] = priorityReceiptId !== undefined
        ? [SLOT2B_ANCHOR_MIN_SCORE, locale, userId, priorityReceiptId]
        : [SLOT2B_ANCHOR_MIN_SCORE, locale, userId];
    const [anchorRows]: any = await pool.query(
        `SELECT DISTINCT
             rsc.storeProductId                        AS anchorSpId,
             sp.chainId                                AS chainId,
             ${localizedSpNameSql(locale, 'sp', 'COALESCE(sp.storeProductName, p.name)')}     AS anchorName,
             sp.brandName                              AS anchorBrandName,
             sp.imageUrl                               AS anchorImageUrl,
             sp.unit                                   AS anchorUnit,
             p.id                                      AS anchorProductId,
             p.categoryId                              AS anchorCategoryId,
             COALESCE(ct.name, c.name)                 AS anchorCategoryName,
             sc.name                                   AS chainName,
             sc.logoUrl                                AS chainLogoUrl
           FROM Receipt r
           JOIN ReceiptSwipeCandidate rsc
             ON rsc.receiptId   = r.id
            AND rsc.autoMatched = 1
            AND rsc.matchScore >= ?
           JOIN StoreProduct sp ON sp.id = rsc.storeProductId
           JOIN Product       p  ON p.id = sp.productId
            AND p.categoryId  != 688
            AND p.mergedIntoId IS NULL
           JOIN StoreChain    sc ON sc.id = sp.chainId
           JOIN Category      c  ON c.id  = p.categoryId
           LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
          WHERE r.userId = ?
          ${receiptFilter}`,
        anchorParams,
    );

    if ((anchorRows as any[]).length === 0) return [];

    const anchorChainIds = [...new Set((anchorRows as any[]).map(r => Number(r.chainId)))];

    // Step 2: orphan SP pool.
    //
    // First pull the USER'S OWN orphans from their receipts (any chain
    // covered by an anchor). The previous implementation did a global
    // `WHERE chainId IN (...) LIMIT N` which, at scale, almost never
    // included the user's own orphan SPs — the pink "Pagerinti
    // atpažinimą" button would open a queue that didn't actually serve
    // the user's Nepriskirta items.
    //
    // Then top up with a same-chain global pool so we still surface
    // unfamiliar orphans the user could rescue — this keeps the
    // community-rescue path alive when the user has no orphans of
    // their own in a covered chain.
    const userReceiptFilter = priorityReceiptId !== undefined ? 'AND r.id = ?' : '';
    const userOrphanParams: any[] = priorityReceiptId !== undefined
        ? [locale, userId, priorityReceiptId]
        : [locale, userId];
    const [userOrphanRows]: any = await pool.query(
        `SELECT DISTINCT
             sp.id                                    AS orphanSpId,
             sp.chainId,
             ${localizedSpNameSql(locale, 'sp', 'COALESCE(sp.storeProductName, p.name)')}    AS orphanName,
             sp.brandName                             AS orphanBrandName,
             sp.imageUrl                              AS orphanImageUrl,
             sp.unit                                  AS orphanUnit,
             p.id                                     AS orphanProductId,
             sc.name                                  AS chainName,
             sc.logoUrl                               AS chainLogoUrl,
             COALESCE(oct.name, oc.name)              AS orphanCategoryName
           FROM Receipt r
           JOIN ReceiptSwipeCandidate rsc
             ON rsc.receiptId = r.id AND rsc.autoMatched = 1
           JOIN StoreProduct sp ON sp.id = rsc.storeProductId
           JOIN Product    p  ON p.id  = sp.productId
            AND p.categoryId   = 688
            AND p.mergedIntoId IS NULL
           JOIN StoreChain sc ON sc.id = sp.chainId
           JOIN Category   oc ON oc.id = p.categoryId
           LEFT JOIN CategoryTranslation oct ON oct.categoryId = oc.id AND oct.locale = ?
          WHERE r.userId = ?
            ${userReceiptFilter}`,
        userOrphanParams,
    );

    const userOrphanSpIds = new Set<number>(
        (userOrphanRows as any[]).map(r => Number(r.orphanSpId)),
    );

    const [globalOrphanRows]: any = await pool.query(
        `SELECT
             sp.id                                    AS orphanSpId,
             sp.chainId,
             ${localizedSpNameSql(locale, 'sp', 'COALESCE(sp.storeProductName, p.name)')}    AS orphanName,
             sp.brandName                             AS orphanBrandName,
             sp.imageUrl                              AS orphanImageUrl,
             sp.unit                                  AS orphanUnit,
             p.id                                     AS orphanProductId,
             sc.name                                  AS chainName,
             sc.logoUrl                               AS chainLogoUrl,
             COALESCE(oct.name, oc.name)              AS orphanCategoryName
           FROM StoreProduct sp
           JOIN Product    p  ON p.id  = sp.productId
            AND p.categoryId   = 688
            AND p.mergedIntoId IS NULL
           JOIN StoreChain sc ON sc.id = sp.chainId
           JOIN Category   oc ON oc.id = p.categoryId
           LEFT JOIN CategoryTranslation oct ON oct.categoryId = oc.id AND oct.locale = ?
          WHERE sp.chainId IN (?)
          LIMIT ?`,
        [locale, anchorChainIds, MAX_GLOBAL_ORPHANS_PER_CHAIN * anchorChainIds.length],
    );

    // Merge: user orphans first (preferred match targets), then de-duped
    // global ones. We drop any global row whose orphanSpId is already in
    // the user pool to avoid scoring the same orphan twice.
    const mergedOrphanRows = [
        ...(userOrphanRows as any[]),
        ...(globalOrphanRows as any[]).filter(r => !userOrphanSpIds.has(Number(r.orphanSpId))),
    ];

    if (mergedOrphanRows.length === 0) return [];

    // Group orphans by chain for efficient lookup.
    const orphansByChain = new Map<number, any[]>();
    for (const orphan of mergedOrphanRows) {
        const chainId = Number(orphan.chainId);
        if (!orphansByChain.has(chainId)) orphansByChain.set(chainId, []);
        orphansByChain.get(chainId)!.push(orphan);
    }

    // Step 3: compute name similarities, keep highest-scoring anchor per orphan.
    const bestPerOrphan = new Map<number, { score: number; row: RawSlot2Row }>();

    for (const anchor of anchorRows as any[]) {
        const chainId = Number(anchor.chainId);
        const orphans = orphansByChain.get(chainId) ?? [];

        for (const orphan of orphans) {
            const score = nameSimilarity(String(anchor.anchorName), String(orphan.orphanName));
            if (score < SLOT2_MIN_SCORE) continue;

            const orphanSpId = Number(orphan.orphanSpId);
            const existing = bestPerOrphan.get(orphanSpId);
            if (existing && existing.score >= score) continue;

            const row: RawSlot2Row = {
                source: '2b',
                orphanSpId,
                candidateSpId: Number(anchor.anchorSpId),
                score,
                sameChain: true,
                orphan: {
                    productId: Number(orphan.orphanProductId),
                    name: String(orphan.orphanName),
                    brandName: orphan.orphanBrandName ?? null,
                    imageUrl: orphan.orphanImageUrl ?? null,
                    unit: orphan.orphanUnit ?? null,
                    chainId,
                    chainName: String(orphan.chainName),
                    chainLogoUrl: orphan.chainLogoUrl ?? null,
                    categoryId: 688,
                    categoryName: String(orphan.orphanCategoryName),
                },
                candidate: {
                    productId: Number(anchor.anchorProductId),
                    name: String(anchor.anchorName),
                    brandName: anchor.anchorBrandName ?? null,
                    imageUrl: anchor.anchorImageUrl ?? null,
                    unit: anchor.anchorUnit ?? null,
                    chainId,
                    chainName: String(anchor.chainName),
                    chainLogoUrl: anchor.chainLogoUrl ?? null,
                    categoryId: Number(anchor.anchorCategoryId),
                    categoryName: String(anchor.anchorCategoryName),
                },
            };
            bestPerOrphan.set(orphanSpId, { score, row });
        }
    }

    return [...bestPerOrphan.values()].map(v => v.row);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Fetch and merge Slot 2a and 2b raw rows for the given user. When
 *  `priorityReceiptId` is supplied, both 2a and 2b scope to that
 *  receipt (mirrors slot 1/3 filter style) so the queue serves the
 *  receipt's own orphans first instead of the user's entire backlog.
 *  `votedPairKeys` (the caller's no-repeat ledger) lets slot-2a advance a
 *  rejected top OSC candidate to the orphan's next-ranked one. */
export async function fetchAllSlot2Rows(
    userId: string,
    priorityReceiptId?: number,
    locale: Locale = 'lt',
    votedPairKeys?: Set<string>,
): Promise<RawSlot2Row[]> {
    const [rows2a, rows2b] = await Promise.all([
        fetchSlot2aRows(userId, priorityReceiptId, locale, votedPairKeys),
        fetchSlot2bRows(userId, priorityReceiptId, locale),
    ]);
    return [...rows2a, ...rows2b];
}
