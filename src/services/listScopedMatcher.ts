import pool from '../config/db.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { scoreNameRelaxed } from '../utils/productMatcher.js';
import { getChainSpsByProductIds } from '../models/storeProductModel.js';
import { updateReceiptItem } from '../models/receiptItemModel.js';

type Connection = typeof pool | any;

/**
 * LIST-SCOPED candidate BOOSTING — the shopping-list analogue of the price fisher
 * (priceRound2Matcher.fishPriceScopedCandidates). When a receipt is linked to a
 * shopping list, the list's products are a strong same-chain hint for what the
 * receipt's still-UNLINKED lines probably are: fish each list product's same-chain
 * StoreProduct, re-score its name against the OCR line at the relaxed floor the
 * price fisher uses, and APPEND survivors to the line's altMatches flagged
 * `viaList`. The proposed-card swipe (Card-B) can then ask the user; one confirm
 * links the SP + teaches the vocabulary alias so future receipts match directly.
 *
 * HARD invariants (see the list-narrowing spec):
 *  - NEVER auto-links. A viaList entry is only ever a PROPOSAL the user confirms via
 *    Card-B (castReceiptLineVote validates proposedSpId ∈ the line's stored altMatches —
 *    which is exactly why we persist here).
 *  - BOOSTER, never a FILTER: existing candidates are never removed or suppressed, and
 *    an off-list line's normal ladder is untouched (a line only gains entries).
 *  - Additive + fail-open per line: any error skips just that line, never the save/link.
 *
 * Mirrors the price fisher: unlinked cardable lines only (matchedSpId NULL, band S2/S3,
 * same rule as receiptResolveQueueService), relaxed name floor (price.fishMinNameScore),
 * per-line cap (list.fishMaxPerLine), excludes storeProductIds already in altMatches.
 * Returns the count of lines augmented.
 */
export const fishListScopedCandidates = async (
    receiptId: number,
    chainId: number,
    listProductIds: number[],
    conn?: Connection,
): Promise<number> => {
    if (!Number.isFinite(receiptId) || !Number.isFinite(chainId)) return 0;
    const productIds = [...new Set((listProductIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (productIds.length === 0) return 0;

    const db = conn || pool;
    const L = RECOGNITION.list;
    const FLOOR = RECOGNITION.price.fishMinNameScore; // reuse the price fisher's relaxed floor

    // Same "unlinked cardable line" rule buildReceiptResolveCards uses: no SP yet, and
    // uncertain (band S2/S3). matchedSpId is also read + re-checked below so an already-
    // linked line can never be touched even if the WHERE ever loosened.
    const [rows]: any = await db.query(
        `SELECT lineIdx, name, matchedSpId, altMatches
           FROM ReceiptItem
          WHERE receiptId = ?
            AND matchedSpId IS NULL
            AND band IN ('S2', 'S3')`,
        [receiptId],
    );
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    // One same-chain SP resolution for the whole list; scored per line locally.
    const pool_ = await getChainSpsByProductIds(chainId, productIds, db);
    if (pool_.length === 0) return 0;

    let fished = 0;
    for (const row of rows) {
        // Belt-and-suspenders: never touch a line that already carries a match.
        if (row?.matchedSpId != null) continue;
        const name = typeof row?.name === 'string' ? row.name : '';
        if (!name.trim()) continue;
        try {
            const existing = (() => {
                const a = row?.altMatches;
                if (Array.isArray(a)) return a;
                if (typeof a === 'string') { try { return JSON.parse(a) || []; } catch { return []; } }
                return [];
            })();
            const excludeIds = new Set(
                existing.map((am: any) => Number(am?.storeProductId)).filter((n: number) => Number.isFinite(n) && n > 0),
            );
            const scored = pool_
                .filter((c) => !excludeIds.has(c.storeProductId))
                .map((c) => ({ c, score: scoreNameRelaxed(name, c.name) }))
                .filter((s) => s.score >= FLOOR)
                .sort((a, b) => b.score - a.score)
                .slice(0, L.fishMaxPerLine);
            if (scored.length === 0) continue;
            const augmented = [
                ...existing,
                ...scored.map(({ c, score }) => ({
                    storeProductId: c.storeProductId,
                    productId: c.productId,
                    categoryId: c.categoryId,
                    categoryName: c.categoryName,
                    categoryL2Name: c.categoryL2Name,
                    name: c.name,
                    brandName: c.brandName,
                    amount: c.amount,
                    unit: c.unit,
                    isWeighable: c.isWeighable,
                    confidence: Math.round(score * 100) / 100,
                    isCatalog: c.isCatalog,
                    viaList: true,
                })),
            ];
            await updateReceiptItem(receiptId, Number(row.lineIdx), { altMatches: augmented }, db);
            fished++;
            console.log(
                `[list-fish] receipt ${receiptId} L${row.lineIdx} "${name}" → +${scored.length}: `
                + scored.map((s) => `sp=${s.c.storeProductId} "${s.c.name}" name≈${s.score.toFixed(2)}`).join(' | '),
            );
        } catch (e) {
            console.warn(`[list-fish] receipt ${receiptId} L${row?.lineIdx} skipped (non-fatal):`, (e as Error)?.message ?? e);
        }
    }
    return fished;
};

/**
 * Link-path entry point: fire-and-forget from the receipt→list link (tripLinkService
 * / the link controllers) once Receipt.shoppingListId is set. Resolves the receipt's
 * chainId (Store→chain) and the list's product ids (COALESCE(sli.productId,
 * sp.productId), mirroring planningScoreService's list query), then boosts. Wholly
 * fail-open: any misstep logs and returns, never breaking or blocking the link.
 */
export const fishListForLinkedReceipt = async (
    receiptId: number,
    listId: number,
    conn?: Connection,
): Promise<void> => {
    try {
        const db = conn || pool;
        const [[chainRow]]: any = await db.query(
            `SELECT s.chainId AS chainId
               FROM Receipt r JOIN Store s ON s.id = r.storeId
              WHERE r.id = ?`,
            [receiptId],
        );
        const chainId = chainRow?.chainId != null ? Number(chainRow.chainId) : NaN;
        if (!Number.isFinite(chainId)) return; // no store/chain (bare upload) → nothing to scope

        const [listRows]: any = await db.query(
            `SELECT DISTINCT COALESCE(sli.productId, sp.productId) AS productId
               FROM ShoppingListItem sli
               LEFT JOIN StoreProduct sp ON sp.id = sli.storeProductId
              WHERE sli.listId = ?`,
            [listId],
        );
        const productIds = (listRows as any[])
            .map((r) => Number(r.productId))
            .filter((n) => Number.isFinite(n) && n > 0);
        if (productIds.length === 0) return;

        const n = await fishListScopedCandidates(receiptId, chainId, productIds, db);
        if (n > 0) console.log(`[list-fish] receipt ${receiptId} ← list ${listId}: boosted ${n} unlinked line(s)`);
    } catch (e) {
        console.warn(`[list-fish] receipt ${receiptId} ← list ${listId} skipped (non-fatal):`, (e as Error)?.message ?? e);
    }
};
