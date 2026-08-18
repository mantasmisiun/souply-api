import pool from '../config/db.js';
import { crossChainNameSimilarity } from '../utils/productNameNormalize.js';
import { swipeLog } from '../utils/swipeLogger.js';
import type { Locale } from '../middleware/locale.js';
import { localizedSpNameSql } from '../middleware/locale.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { fetchCanonicalAliasesForSps } from './storeProductAliasModel.js';

/**
 * Best cross-chain name similarity over a product's catalog name AND its canonical
 * receipt-name aliases on BOTH sides (Issue H vocab-driven queue). When the chains'
 * catalog names diverge but they PRINT the product similarly, a learned alias bridges
 * the pair — surfacing identity candidates a pure name comparison would miss. Reduces
 * to plain name×name similarity when neither side has aliases. See RECEIPT_VOCABULARY.md.
 */
export function bestCrossChainSimilarity(aName: string, aAliases: string[], bName: string, bAliases: string[]): number {
    const aTexts = [aName, ...aAliases];
    const bTexts = [bName, ...bAliases];
    let best = 0;
    for (const a of aTexts) {
        for (const b of bTexts) {
            const s = crossChainNameSimilarity(a, b);
            if (s > best) best = s;
        }
    }
    return best;
}

/**
 * Diagnostics-only (Log 4): same best score as bestCrossChainSimilarity, but also reports
 * whether the WINNING text pair used a learned alias (index > 0) rather than the catalog
 * name on either side — so the Slot-1 vocab-bridge log can flag when the vocabulary, not
 * the catalog names, is what surfaced a cross-chain identity candidate. Kept SEPARATE from
 * the hot-path function above so per-candidate scoring is untouched; called once, only for
 * the winning candidate.
 */
export function bestCrossChainSimilarityDetailed(
    aName: string, aAliases: string[], bName: string, bAliases: string[],
): { score: number; viaAlias: boolean; aText: string; bText: string; catalogScore: number } {
    const aTexts = [aName, ...aAliases];
    const bTexts = [bName, ...bAliases];
    let best = 0, bi = 0, bj = 0;
    for (let i = 0; i < aTexts.length; i++) {
        for (let j = 0; j < bTexts.length; j++) {
            const s = crossChainNameSimilarity(aTexts[i], bTexts[j]);
            if (s > best) { best = s; bi = i; bj = j; }
        }
    }
    // catalogScore = the catalog-name × catalog-name pair (index 0×0) on its own, so the
    // log can say whether the alias was NECESSARY (catalog below threshold) or merely
    // scored higher (catalog already above threshold).
    return { score: best, viaAlias: bi > 0 || bj > 0, aText: aTexts[bi], bText: bTexts[bj], catalogScore: crossChainNameSimilarity(aName, bName) };
}

/** Minimum match score for an anchor SP to be used as a Slot 1 source. */
const SLOT1_ANCHOR_MIN_SCORE = RECOGNITION.match.slot1AnchorMinScore;
/**
 * Minimum cross-chain name similarity to surface a pair.
 * Lower than Slot 3 (0.75) because chain-specific naming diverges cross-chain
 * even after stripping brand tokens.
 */
const SLOT1_CROSS_CHAIN_MIN_SCORE = RECOGNITION.match.slot1CrossChainMinScore;
/** Candidates fetched per (otherChainId, categoryId) group for JS scoring. */
const MAX_CANDIDATES_PER_GROUP = RECOGNITION.match.maxCandidatesPerGroup;

export interface RawSlot1Row {
    leftSpId: number;
    rightSpId: number;
    score: number;
    left: {
        productId: number;
        name: string;
        brandName: string | null;
        imageUrl: string | null;
        chainId: number;
        chainName: string;
        chainLogoUrl: string | null;
        categoryId: number;
        categoryName: string;
    };
    right: {
        productId: number;
        name: string;
        brandName: string | null;
        imageUrl: string | null;
        chainId: number;
        chainName: string;
        chainLogoUrl: string | null;
        categoryId: number;
        categoryName: string;
    };
}

/**
 * Slot 1 — Cross-chain identity confirmation.
 *
 * For each confirmed receipt SP (auto-matched, score ≥ 0.85) finds the closest
 * matching SP in every other chain within the same product category. Presents
 * as a swipe card: "Is this Rimi product the same as this Maxima product?"
 *
 * When `priorityReceiptId` is supplied (mandatory post-upload flow), only that
 * receipt's SPs are used as anchors so unrelated cards from older receipts
 * don't appear. The standalone queue omits it to draw from all receipts.
 *
 * Votes feed the cross-chain StoreProductMatchVote table and ultimately drive
 * the price-comparison equivalence graph.
 */
export async function fetchSlot1Rows(userId: string, priorityReceiptId?: number, locale: Locale = 'lt'): Promise<RawSlot1Row[]> {
    swipeLog(`[Slot1] fetchSlot1Rows userId=${userId} priorityReceiptId=${priorityReceiptId ?? 'all'}`);
    // ── Step 1: anchor SPs ────────────────────────────────────────────────────
    // In mandatory mode restrict to the specific receipt so older receipts don't
    // pollute the queue with unrelated pairs.
    const receiptFilter = priorityReceiptId !== undefined
        ? 'AND r.id = ?'
        : '';
    const anchorParams: any[] = priorityReceiptId !== undefined
        ? [SLOT1_ANCHOR_MIN_SCORE, locale, userId, priorityReceiptId]
        : [SLOT1_ANCHOR_MIN_SCORE, locale, userId];

    const [anchorRows]: any = await pool.query(
        `SELECT DISTINCT
             rsc.storeProductId                         AS anchorSpId,
             sp.chainId                                 AS anchorChainId,
             p.id                                       AS anchorProductId,
             p.categoryId                               AS anchorCategoryId,
             p.name                                     AS anchorProductName,
             ${localizedSpNameSql(locale, 'sp', 'COALESCE(sp.storeProductName, p.name)')}      AS anchorDisplayName,
             sp.brandName                               AS anchorBrandName,
             sp.imageUrl                                AS anchorImageUrl,
             sc.name                                    AS anchorChainName,
             sc.logoUrl                                 AS anchorChainLogoUrl,
             COALESCE(ct.name, c.name)                  AS anchorCategoryName
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

    swipeLog(`[Slot1] anchors: ${(anchorRows as any[]).length}`);
    for (const a of anchorRows as any[]) {
        swipeLog(`[Slot1]   anchor spId=${a.anchorSpId} "${a.anchorProductName}" chain=${a.anchorChainName}(${a.anchorChainId}) cat=${a.anchorCategoryName}(${a.anchorCategoryId})`);
    }
    if (!(anchorRows as any[]).length) return [];

    const anchorChainIds = [...new Set((anchorRows as any[]).map((r: any) => Number(r.anchorChainId)))];
    const anchorCategoryIds = [...new Set((anchorRows as any[]).map((r: any) => Number(r.anchorCategoryId)))];

    // ── Step 2: candidate SPs from OTHER chains, same categories ─────────────
    const [candidateRows]: any = await pool.query(
        `SELECT spId, chainId, productId, categoryId,
                productName, displayName, brandName, imageUrl,
                chainName, chainLogoUrl, categoryName
           FROM (
               SELECT
                   sp.id                                   AS spId,
                   sp.chainId,
                   p.id                                    AS productId,
                   p.categoryId,
                   p.name                                  AS productName,
                   ${localizedSpNameSql(locale, 'sp', 'COALESCE(sp.storeProductName, p.name)')}   AS displayName,
                   sp.brandName,
                   sp.imageUrl,
                   sc.name                                 AS chainName,
                   sc.logoUrl                              AS chainLogoUrl,
                   COALESCE(ct.name, c.name)               AS categoryName,
                   ROW_NUMBER() OVER (
                       PARTITION BY sp.chainId, p.categoryId ORDER BY p.id
                   ) AS rn
                 FROM StoreProduct sp
                 JOIN Product p ON p.id = sp.productId
                  AND p.categoryId  != 688
                  AND p.mergedIntoId IS NULL
                  AND p.categoryId  IN (?)
                 JOIN StoreChain sc ON sc.id = sp.chainId
                 JOIN Category   c  ON c.id  = p.categoryId
                 LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
                WHERE sp.chainId NOT IN (?)
           ) ranked
          WHERE rn <= ?`,
        [anchorCategoryIds, locale, anchorChainIds, MAX_CANDIDATES_PER_GROUP],
    );

    swipeLog(`[Slot1] candidates fetched: ${(candidateRows as any[]).length} (chains: ${[...new Set((candidateRows as any[]).map((r: any) => `${r.chainName}(${r.chainId})`))].join(', ')})`);
    if (!(candidateRows as any[]).length) return [];

    // Group candidates by chainId:categoryId for O(1) lookup during scoring.
    const byGroup = new Map<string, any[]>();
    for (const r of candidateRows as any[]) {
        const key = `${r.chainId}:${r.categoryId}`;
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key)!.push(r);
    }

    const candidateChainIds = [...new Set((candidateRows as any[]).map((r: any) => Number(r.chainId)))];

    // Vocabulary bridge (Issue H): attach canonical receipt-name aliases to anchors +
    // candidates so scoring can match the way each chain PRINTS a product, not just its
    // catalog name. Targeted fetch (only the SPs in play); no-op until aliases exist.
    const aliasBySp = await fetchCanonicalAliasesForSps([
        ...(anchorRows as any[]).map((a: any) => Number(a.anchorSpId)),
        ...(candidateRows as any[]).map((c: any) => Number(c.spId)),
    ]);

    // ── Step 3: score anchors vs candidates, keep best per canonical pair ─────
    const best = new Map<string, { score: number; row: RawSlot1Row }>();

    for (const anchor of anchorRows as any[]) {
        for (const chainId of candidateChainIds) {
            const groupKey = `${chainId}:${anchor.anchorCategoryId}`;
            const candidates = byGroup.get(groupKey) ?? [];
            if (!candidates.length) continue;

            let bestScore = SLOT1_CROSS_CHAIN_MIN_SCORE;
            let bestCand: any = null;

            for (const cand of candidates) {
                const score = bestCrossChainSimilarity(
                    String(anchor.anchorProductName),
                    aliasBySp.get(Number(anchor.anchorSpId)) ?? [],
                    String(cand.productName),
                    aliasBySp.get(Number(cand.spId)) ?? [],
                );
                if (score > bestScore) {
                    bestScore = score;
                    bestCand = cand;
                }
            }

            if (!bestCand) {
                swipeLog(`[Slot1]   anchor "${anchor.anchorProductName}" vs chain=${chainId} cat=${anchor.anchorCategoryId}: no candidate above threshold ${SLOT1_CROSS_CHAIN_MIN_SCORE}`);
                continue;
            }
            swipeLog(`[Slot1]   anchor "${anchor.anchorProductName}" (${anchor.anchorChainName}) → best match "${bestCand.productName}" (${bestCand.chainName}) score=${bestScore.toFixed(3)}`);
            // Log 4 — vocab bridge: flag (always, ungated) when a LEARNED alias, not the
            // catalog names, is what carried this cross-chain pair over the threshold. No-op
            // until canonical aliases exist, so it stays silent on a cold vocabulary.
            const bridge = bestCrossChainSimilarityDetailed(
                String(anchor.anchorProductName), aliasBySp.get(Number(anchor.anchorSpId)) ?? [],
                String(bestCand.productName), aliasBySp.get(Number(bestCand.spId)) ?? [],
            );
            if (bridge.viaAlias) {
                const aliasNeeded = bridge.catalogScore < SLOT1_CROSS_CHAIN_MIN_SCORE;
                console.log(
                    `[VOCAB] slot-1 bridge: "${anchor.anchorProductName}" ↔ "${bestCand.productName}" — top score via learned alias "${bridge.aText}" ≈ "${bridge.bText}" (${bridge.score.toFixed(3)}); ` +
                    `catalog names alone ${bridge.catalogScore.toFixed(3)} ` +
                    (aliasNeeded
                        ? `< ${SLOT1_CROSS_CHAIN_MIN_SCORE} — alias was NEEDED to surface this pair`
                        : `≥ ${SLOT1_CROSS_CHAIN_MIN_SCORE} — alias only raised the score, catalog names would have surfaced it too`),
                );
            }

            const anchorSpId = Number(anchor.anchorSpId);
            const candSpId = Number(bestCand.spId);
            const pairKey = `${Math.min(anchorSpId, candSpId)}-${Math.max(anchorSpId, candSpId)}`;

            const existing = best.get(pairKey);
            if (existing && existing.score >= bestScore) continue;

            const anchorIsLeft = anchorSpId < candSpId;

            const anchorSide = {
                productId: Number(anchor.anchorProductId),
                name: String(anchor.anchorDisplayName),
                brandName: anchor.anchorBrandName ?? null,
                imageUrl: anchor.anchorImageUrl ?? null,
                chainId: Number(anchor.anchorChainId),
                chainName: String(anchor.anchorChainName),
                chainLogoUrl: anchor.anchorChainLogoUrl ?? null,
                categoryId: Number(anchor.anchorCategoryId),
                categoryName: String(anchor.anchorCategoryName),
            };

            const candSide = {
                productId: Number(bestCand.productId),
                name: String(bestCand.displayName),
                brandName: bestCand.brandName ?? null,
                imageUrl: bestCand.imageUrl ?? null,
                chainId: Number(bestCand.chainId),
                chainName: String(bestCand.chainName),
                chainLogoUrl: bestCand.chainLogoUrl ?? null,
                categoryId: Number(bestCand.categoryId),
                categoryName: String(bestCand.categoryName),
            };

            best.set(pairKey, {
                score: bestScore,
                row: {
                    leftSpId:  anchorIsLeft ? anchorSpId : candSpId,
                    rightSpId: anchorIsLeft ? candSpId   : anchorSpId,
                    score: bestScore,
                    left:  anchorIsLeft ? anchorSide : candSide,
                    right: anchorIsLeft ? candSide   : anchorSide,
                },
            });
        }
    }

    const finalRows = [...best.values()].map(v => v.row);
    swipeLog(`[Slot1] final pairs: ${finalRows.length}`);
    for (const r of finalRows) {
        swipeLog(`[Slot1]   pair "${r.left.name}" (${r.left.chainName}) vs "${r.right.name}" (${r.right.chainName}) score=${r.score.toFixed(3)}`);
    }
    return finalRows;
}
