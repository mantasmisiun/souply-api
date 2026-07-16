import pool from '../config/db.js';
import { computeReceiptSavings } from './statsService.js';

/**
 * Souply 2.0 Phase 5 (first slice) — per-trip stats: spend, category donut,
 * per-chain split and per-member contributions, aggregated STRICTLY from
 * ReceiptItem rows (never the parsedData blob — plan rule). Savings uses the
 * live avg-vs-paid semantic shared with the profile card; the frozen
 * "Sutaupyta / Galėjai sutaupyti" comparable-store deltas land with the
 * persisted-comparison slice later in Phase 5.
 */

export interface TripStats {
    tripId: number;
    receiptCount: number;
    totalSpent: number;
    savings: number;
    categoryBreakdown: { categoryName: string; total: number }[];
    chainBreakdown: { chainName: string; total: number }[];
    memberSpend: { userId: string; total: number; receiptCount: number }[];
}

export const getTripStats = async (tripId: number): Promise<TripStats> => {
    const [receipts]: any = await pool.query(
        `SELECT r.id, r.uploaderUserId, r.userId, sc.name AS chainName
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.tripId = ?`,
        [tripId],
    );
    const empty: TripStats = {
        tripId, receiptCount: 0, totalSpent: 0, savings: 0,
        categoryBreakdown: [], chainBreakdown: [], memberSpend: [],
    };
    if (receipts.length === 0) return empty;
    const receiptIds = receipts.map((r: any) => Number(r.id));

    const [itemRows]: any = await pool.query(
        `SELECT receiptId, matchedSpId AS storeProductId, price, promoPrice, quantity
           FROM ReceiptItem
          WHERE receiptId IN (?)`,
        [receiptIds],
    );
    if (itemRows.length === 0) return { ...empty, receiptCount: receipts.length };

    // SP → L2 category (same resolution as the profile stats: L2 label,
    // L3 rolls up to its parent, L1 is excluded from the donut).
    const spIds = [...new Set(itemRows.map((r: any) => Number(r.storeProductId)).filter((v: number) => v > 0))];
    const spCategory = new Map<number, string>();
    if (spIds.length > 0) {
        const [spRows]: any = await pool.query(
            `SELECT sp.id AS spId,
                    CASE
                        WHEN c.parentCategoryId IS NULL THEN NULL
                        WHEN c2.parentCategoryId IS NULL THEN c.name
                        ELSE c2.name
                    END AS categoryName
               FROM StoreProduct sp
               JOIN Product p ON p.id = sp.productId
               LEFT JOIN Category c ON c.id = p.categoryId
               LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
              WHERE sp.id IN (?)`,
            [spIds],
        );
        for (const row of spRows) {
            if (row.categoryName) spCategory.set(Number(row.spId), String(row.categoryName));
        }
    }

    const receiptById = new Map<number, any>(receipts.map((r: any) => [Number(r.id), r]));
    const round2 = (n: number) => Math.round(n * 100) / 100;

    let totalSpent = 0;
    const catMap: Record<string, number> = {};
    const chainMap: Record<string, number> = {};
    const memberMap: Record<string, { total: number; receipts: Set<number> }> = {};

    for (const item of itemRows) {
        const unitPrice = (item.promoPrice != null && parseFloat(item.promoPrice) > 0)
            ? parseFloat(item.promoPrice)
            : parseFloat(item.price) || 0;
        const qty = parseFloat(item.quantity) || 1;
        const itemTotal = unitPrice * qty;
        if (itemTotal <= 0) continue;
        totalSpent += itemTotal;

        const receipt = receiptById.get(Number(item.receiptId));
        const chain = receipt?.chainName ?? 'Kita';
        chainMap[chain] = (chainMap[chain] ?? 0) + itemTotal;

        const member = receipt?.uploaderUserId ?? receipt?.userId ?? 'unknown';
        const m = (memberMap[member] ??= { total: 0, receipts: new Set() });
        m.total += itemTotal;
        m.receipts.add(Number(item.receiptId));

        const cat = spCategory.get(Number(item.storeProductId));
        if (cat) catMap[cat] = (catMap[cat] ?? 0) + itemTotal;
    }

    const savings = await computeReceiptSavings(itemRows.map((i: any) => ({
        storeProductId: Number(i.storeProductId) || 0,
        price: (i.promoPrice != null && parseFloat(i.promoPrice) > 0) ? parseFloat(i.promoPrice) : parseFloat(i.price) || 0,
        quantity: parseFloat(i.quantity) || 1,
    })));

    return {
        tripId,
        receiptCount: receipts.length,
        totalSpent: round2(totalSpent),
        savings: round2(savings),
        categoryBreakdown: Object.entries(catMap)
            .map(([categoryName, total]) => ({ categoryName, total: round2(total) }))
            .sort((a, b) => b.total - a.total),
        chainBreakdown: Object.entries(chainMap)
            .map(([chainName, total]) => ({ chainName, total: round2(total) }))
            .sort((a, b) => b.total - a.total),
        memberSpend: Object.entries(memberMap)
            .map(([userId, v]) => ({ userId, total: round2(v.total), receiptCount: v.receipts.size }))
            .sort((a, b) => b.total - a.total),
    };
};
