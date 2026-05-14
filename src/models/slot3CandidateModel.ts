import pool from '../config/db.js';
import { nameSimilarity } from '../utils/productNameNormalize.js';
import type { RawSlot3Row } from '../services/slot3QueueBuilder.js';
import { swipeLog } from '../utils/swipeLogger.js';
import type { Locale } from '../middleware/locale.js';

const SLOT3_MIN_SCORE = 0.75;

/** Cap per (chainId, categoryId) for receipt-anchored candidates. */
const MAX_CANDIDATES_PER_GROUP = 15;
/** Cap per (chainId, categoryId) for the global fallback. */
const MAX_GLOBAL_PER_GROUP = 15;

// ── Receipt-anchored (primary) ─────────────────────────────────────────────

/**
 * Finds same-chain duplicate candidates for products the user matched on their
 * receipts. One side of every pair is always a product from the user's receipts,
 * making these directly relevant to their price comparison.
 */
async function fetchSlot3ReceiptRows(userId: string, receiptId?: number, locale: Locale = 'lt'): Promise<RawSlot3Row[]> {
    // Anchor from Price rows rather than ReceiptSwipeCandidate.
    // ReceiptSwipeCandidate contains the mobile app's cross-chain altMatches
    // (often Maxima/Barbora SPs for a Rimi receipt), which are filtered out by
    // the chain check. Price rows always reference the resolver-assigned SP in
    // the correct chain, so they're a reliable source of "what the user bought."
    const receiptFilter = receiptId !== undefined ? 'AND r.id = ?' : '';
    const params: any[] = receiptId !== undefined ? [locale, userId, receiptId] : [locale, userId];

    swipeLog(`[Slot3] fetchSlot3ReceiptRows userId=${userId} receiptId=${receiptId ?? 'all'}`);

    const [anchorRows]: any = await pool.query(
        `SELECT DISTINCT
             sp.id                                    AS spId,
             sp.chainId,
             p.id                                     AS productId,
             p.name                                   AS productName,
             p.categoryId,
             COALESCE(sp.storeProductName, p.name)    AS displayName,
             sp.brandName, sp.imageUrl,
             sc.name                                  AS chainName,
             sc.logoUrl                               AS chainLogoUrl,
             COALESCE(ct.name, c.name)                AS categoryName
           FROM Receipt r
           JOIN Price         pr ON pr.receiptId = r.id
           JOIN StoreProduct  sp ON sp.id = pr.storeProductId
           JOIN Product       p  ON p.id  = sp.productId
            AND p.mergedIntoId IS NULL
            AND p.categoryId  != 688
           JOIN StoreChain    sc ON sc.id = sp.chainId
           JOIN Category      c  ON c.id  = p.categoryId
           LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
          WHERE r.userId = ?
          ${receiptFilter}`,
        params,
    );

    swipeLog(`[Slot3] receipt anchors: ${(anchorRows as any[]).length} (chains: ${[...new Set((anchorRows as any[]).map((r: any) => `${r.chainName}(${r.chainId})`))].join(', ')})`);
    if (!(anchorRows as any[]).length) return [];

    const chainIds = [...new Set((anchorRows as any[]).map((r: any) => Number(r.chainId)))];

    const [candidateRows]: any = await pool.query(
        `SELECT spId, chainId, productId, productName, displayName, brandName, imageUrl, categoryId
           FROM (
               SELECT
                   sp.id                                   AS spId,
                   sp.chainId,
                   p.id                                    AS productId,
                   p.name                                  AS productName,
                   COALESCE(sp.storeProductName, p.name)   AS displayName,
                   sp.brandName, sp.imageUrl, p.categoryId,
                   ROW_NUMBER() OVER (
                       PARTITION BY sp.chainId, p.categoryId ORDER BY p.id
                   ) AS rn
                 FROM StoreProduct sp
                 JOIN Product p ON p.id = sp.productId
                  AND p.mergedIntoId IS NULL
                  AND p.categoryId  != 688
                WHERE sp.chainId IN (?)
           ) ranked
          WHERE rn <= ?`,
        [chainIds, MAX_CANDIDATES_PER_GROUP],
    );

    const chainMeta = new Map<number, { chainName: string; chainLogoUrl: string | null }>();
    const categoryMeta = new Map<number, string>();
    for (const r of anchorRows as any[]) {
        chainMeta.set(Number(r.chainId), { chainName: String(r.chainName), chainLogoUrl: r.chainLogoUrl ?? null });
        categoryMeta.set(Number(r.categoryId), String(r.categoryName));
    }

    const candidatesByGroup = new Map<string, any[]>();
    for (const r of candidateRows as any[]) {
        const key = `${r.chainId}:${r.categoryId}`;
        if (!candidatesByGroup.has(key)) candidatesByGroup.set(key, []);
        candidatesByGroup.get(key)!.push(r);
    }

    const result: RawSlot3Row[] = [];
    // Deduplicate by product ID pair so the same semantic duplicate doesn't appear
    // with different SP IDs (e.g. 3 SP IDs for Fairy Lemon × 2 for Fairy Apple = 6 cards).
    const seenProductPairs = new Set<string>();

    for (const anchor of anchorRows as any[]) {
        const key = `${anchor.chainId}:${anchor.categoryId}`;
        const candidates = candidatesByGroup.get(key) ?? [];
        const chain = chainMeta.get(Number(anchor.chainId))!;
        const anchorCategoryName = categoryMeta.get(Number(anchor.categoryId)) ?? '';

        // Keep only the single best match per anchor — no score floor.
        // This guarantees Slot 3 cards are always anchored to the receipt even
        // when no pair scores above 0.75.
        let bestScore = -1;
        let bestCand: any = null;

        for (const cand of candidates) {
            if (Number(cand.productId) === Number(anchor.productId)) continue;
            const score = nameSimilarity(String(anchor.productName), String(cand.productName));
            if (score > bestScore) {
                bestScore = score;
                bestCand = cand;
            }
        }

        if (!bestCand) continue;

        const productPairKey = `${Math.min(Number(anchor.productId), Number(bestCand.productId))}-${Math.max(Number(anchor.productId), Number(bestCand.productId))}`;
        if (seenProductPairs.has(productPairKey)) continue;
        seenProductPairs.add(productPairKey);

        const [left, right] =
            Number(anchor.spId) < Number(bestCand.spId) ? [anchor, bestCand] : [bestCand, anchor];

        result.push({
            spIdA: Number(left.spId),
            spIdB: Number(right.spId),
            score: bestScore,
            left: {
                productId: Number(left.productId),
                name: String(left.displayName),
                brandName: left.brandName ?? null,
                imageUrl: left.imageUrl ?? null,
                chainId: Number(anchor.chainId),
                chainName: chain.chainName,
                chainLogoUrl: chain.chainLogoUrl,
                categoryId: Number(left.categoryId ?? anchor.categoryId),
                categoryName: anchorCategoryName,
            },
            right: {
                productId: Number(right.productId),
                name: String(right.displayName),
                brandName: right.brandName ?? null,
                imageUrl: right.imageUrl ?? null,
                chainId: Number(anchor.chainId),
                chainName: chain.chainName,
                chainLogoUrl: chain.chainLogoUrl,
                categoryId: Number(right.categoryId ?? anchor.categoryId),
                categoryName: anchorCategoryName,
            },
        });
    }

    swipeLog(`[Slot3] receipt pairs found: ${result.length} (best-per-anchor, no score floor)`);
    for (const r of result) {
        swipeLog(`[Slot3]   receipt pair spId=${r.spIdA} "${r.left.name}" vs spId=${r.spIdB} "${r.right.name}" chain=${r.left.chainName} score=${r.score.toFixed(3)}`);
    }
    return result;
}

// ── Global fallback ────────────────────────────────────────────────────────

/**
 * Scans (chainId, categoryId) groups for same-chain duplicates, restricted to
 * the given chain IDs. Capped at MAX_GLOBAL_PER_GROUP per group to bound JS
 * comparison work.
 */
async function fetchSlot3GlobalRows(chainIds: number[], locale: Locale = 'lt'): Promise<RawSlot3Row[]> {
    swipeLog(`[Slot3] fetchSlot3GlobalRows chainIds=${chainIds.join(',')}`);
    if (!chainIds.length) return [];
    const [rows]: any = await pool.query(
        `SELECT chainId, categoryId, productId, productName,
                spId, displayName, brandName, imageUrl,
                chainName, chainLogoUrl, categoryName
           FROM (
               SELECT
                   sp.chainId,
                   p.categoryId,
                   p.id                                  AS productId,
                   p.name                                AS productName,
                   sp.id                                 AS spId,
                   COALESCE(sp.storeProductName, p.name) AS displayName,
                   sp.brandName,
                   sp.imageUrl,
                   sc.name                               AS chainName,
                   sc.logoUrl                            AS chainLogoUrl,
                   COALESCE(ct.name, c.name)             AS categoryName,
                   ROW_NUMBER() OVER (
                       PARTITION BY sp.chainId, p.categoryId
                       ORDER BY p.id
                   ) AS rn
                 FROM StoreProduct sp
                 JOIN Product    p  ON p.id  = sp.productId
                  AND p.mergedIntoId IS NULL
                  AND p.categoryId  != 688
                 JOIN StoreChain sc ON sc.id = sp.chainId
                 JOIN Category   c  ON c.id  = p.categoryId
                 LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
                WHERE sp.chainId IN (?)
           ) ranked
          WHERE rn <= ?`,
        [locale, chainIds, MAX_GLOBAL_PER_GROUP],
    );

    const groups = new Map<string, any[]>();
    for (const r of rows as any[]) {
        const key = `${r.chainId}:${r.categoryId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
    }

    const result: RawSlot3Row[] = [];

    for (const products of groups.values()) {
        if (products.length < 2) continue;

        for (let i = 0; i < products.length - 1; i++) {
            for (let j = i + 1; j < products.length; j++) {
                const a = products[i];
                const b = products[j];
                if (Number(a.productId) === Number(b.productId)) continue;

                const score = nameSimilarity(String(a.productName), String(b.productName));
                if (score < SLOT3_MIN_SCORE) continue;

                const [left, right] = Number(a.spId) < Number(b.spId) ? [a, b] : [b, a];

                result.push({
                    spIdA: Number(left.spId),
                    spIdB: Number(right.spId),
                    score,
                    left: {
                        productId: Number(left.productId),
                        name: String(left.displayName),
                        brandName: left.brandName ?? null,
                        imageUrl: left.imageUrl ?? null,
                        chainId: Number(left.chainId),
                        chainName: String(left.chainName),
                        chainLogoUrl: left.chainLogoUrl ?? null,
                        categoryId: Number(left.categoryId),
                        categoryName: String(left.categoryName),
                    },
                    right: {
                        productId: Number(right.productId),
                        name: String(right.displayName),
                        brandName: right.brandName ?? null,
                        imageUrl: right.imageUrl ?? null,
                        chainId: Number(right.chainId),
                        chainName: String(right.chainName),
                        chainLogoUrl: right.chainLogoUrl ?? null,
                        categoryId: Number(right.categoryId),
                        categoryName: String(right.categoryName),
                    },
                });
            }
        }
    }

    swipeLog(`[Slot3] global pairs found: ${result.length} (chains: ${chainIds.join(',')})`);
    for (const r of result) {
        swipeLog(`[Slot3]   global pair spId=${r.spIdA} "${r.left.name}" vs spId=${r.spIdB} "${r.right.name}" chain=${r.left.chainName} score=${r.score.toFixed(3)}`);
    }
    return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getReceiptChainIds(userId: string, receiptId?: number): Promise<number[]> {
    const receiptFilter = receiptId !== undefined ? 'AND r.id = ?' : '';
    const params: any[] = receiptId !== undefined ? [userId, receiptId] : [userId];
    const [rows]: any = await pool.query(
        `SELECT DISTINCT s.chainId
           FROM Receipt r
           JOIN Store s ON s.id = r.storeId
          WHERE r.userId = ?
          ${receiptFilter}`,
        params,
    );
    return (rows as any[]).map(r => Number(r.chainId));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns Slot 3 rows: receipt-anchored pairs first (directly relevant to the
 * user's receipts), then global same-chain duplicates as overflow. The
 * buildSlot3Queue builder deduplicates and filters voted pairs.
 */
export async function fetchSlot3Rows(userId: string, receiptId?: number, locale: Locale = 'lt'): Promise<RawSlot3Row[]> {
    const receiptRows = await fetchSlot3ReceiptRows(userId, receiptId, locale);

    // Always fetch global rows as overflow — receipt-anchored pairs may all be
    // already voted, leaving slot3 empty without global. Receipt rows prepend
    // in the combined array so they stay priority over global catalog pairs.
    // Chain IDs come from receipt rows when present; DB query otherwise.
    const chainIds = receiptRows.length > 0
        ? [...new Set(receiptRows.map(r => r.left.chainId))]
        : await getReceiptChainIds(userId, receiptId);

    swipeLog(`[Slot3] receipt pairs exist (${receiptRows.length}), fetching global overflow — chainIds=${chainIds.join(',')}`);

    let globalRows: RawSlot3Row[] = [];
    if (chainIds.length > 0) {
        globalRows = await fetchSlot3GlobalRows(chainIds, locale);
    }

    // Receipt-anchored pairs take priority; global rows fill overflow.
    const seen = new Set<string>();
    const combined: RawSlot3Row[] = [];

    for (const row of receiptRows) {
        const key = `${row.spIdA}-${row.spIdB}`;
        if (!seen.has(key)) {
            seen.add(key);
            combined.push(row);
        }
    }
    for (const row of globalRows) {
        const key = `${row.spIdA}-${row.spIdB}`;
        if (!seen.has(key)) {
            seen.add(key);
            combined.push(row);
        }
    }

    return combined;
}
