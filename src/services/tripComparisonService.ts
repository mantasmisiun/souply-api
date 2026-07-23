import pool from '../config/db.js';
import { getReceiptComparison } from './receiptComparisonService.js';

/**
 * Souply — trip-level cross-store basket comparison for the mobile "savings"
 * sheet. Aggregates every non-hidden receipt in the trip into ONE per-chain
 * comparison: "your whole trip's basket, priced at each nearby chain".
 *
 * Builds on getReceiptComparison (the single-receipt pricer used by the
 * snapshot service) — we call it per receipt and merge by chainId, SUMMING
 * totals so a two-store trip reads as one combined basket. Single-receipt
 * trips (the common case) pass through unchanged: the map is just that
 * receipt's currentChain + alternatives.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Median of an ASC-sorted list; 0 for an empty list. */
const medianOfSorted = (sorted: number[]): number => {
    if (!sorted.length) return 0;
    const mid = sorted.length / 2;
    return sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[mid - 1] + sorted[mid]) / 2;
};

export interface TripComparisonStore {
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    total: number;
    yours: boolean;
}

export interface TripComparison {
    stores: TripComparisonStore[];
    yoursTotal: number;
    cheapestTotal: number;
    medianTotal: number;
    cheaperStoreName: string | null;
    savedVsAvg: number;
    headroom: number;
    equalPrices: boolean;
}

const EMPTY: TripComparison = {
    stores: [],
    yoursTotal: 0,
    cheapestTotal: 0,
    medianTotal: 0,
    cheaperStoreName: null,
    savedVsAvg: 0,
    headroom: 0,
    equalPrices: true,
};

interface ChainAgg {
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    total: number;
}

export const getTripComparison = async (tripId: number): Promise<TripComparison> => {
    // Non-hidden, dated receipts only (same visibility floor the savings sheet
    // scores against — hidden/undated receipts have no comparable basket).
    const [rows]: any = await pool.query(
        `SELECT id FROM Receipt
          WHERE tripId = ? AND userDeletedAt IS NULL AND receiptDate IS NOT NULL
          ORDER BY id ASC`,
        [tripId],
    );
    if (!rows.length) return { ...EMPTY };

    const byChain = new Map<number, ChainAgg>();
    let yoursTotal = 0;
    let yoursChainId: number | null = null;

    const accumulate = (
        entry: { chainId?: number | null; chainName?: string; chainLogoUrl?: string | null; total?: number },
    ) => {
        if (entry.chainId == null) return;
        const chainId = Number(entry.chainId);
        const total = Number(entry.total) || 0;
        const existing = byChain.get(chainId);
        if (existing) {
            existing.total = round2(existing.total + total);
        } else {
            byChain.set(chainId, {
                chainId,
                chainName: entry.chainName ?? '',
                chainLogoUrl: entry.chainLogoUrl ?? null,
                total: round2(total),
            });
        }
    };

    for (const r of rows) {
        let cmp: any;
        try {
            cmp = await getReceiptComparison(Number(r.id));
        } catch {
            // A receipt with an unresolved store / no comparable basket must not
            // sink the whole trip comparison — skip it.
            continue;
        }
        const cur = cmp?.currentChain;
        if (!cur || cur.chainId == null) continue; // no scorable basket for this receipt

        // "Your chain" is ambiguous across a multi-store trip; anchor it to the
        // FIRST receipt with a resolved current chain (spec).
        if (yoursChainId === null) yoursChainId = Number(cur.chainId);
        yoursTotal = round2(yoursTotal + (Number(cur.total) || 0));

        accumulate(cur);
        for (const alt of cmp.alternatives ?? []) accumulate(alt);
    }

    if (byChain.size === 0) return { ...EMPTY };

    const stores: TripComparisonStore[] = Array.from(byChain.values())
        .map((c) => ({
            chainId: c.chainId,
            chainName: c.chainName,
            chainLogoUrl: c.chainLogoUrl,
            total: round2(c.total),
            yours: c.chainId === yoursChainId,
        }))
        .sort((a, b) => a.total - b.total);

    const totals = stores.map((s) => s.total);
    const cheapestTotal = totals[0];
    const maxTotal = totals[totals.length - 1];
    const medianTotal = round2(medianOfSorted(totals));

    // "You are the cheapest" ⇢ no store beats what you actually paid.
    const cheaperStoreName = yoursTotal > cheapestTotal ? stores[0].chainName : null;

    // "Couldn't differentiate prices" ⇢ only when the totals are genuinely flat:
    // fewer than two stores, or the whole spread is under 50 cents. NOTE: do NOT
    // gate on the imputed/flat item ratio — alternatives are routinely imputed at
    // a flat reference while YOUR store's real paid total still differs by euros
    // (you were cheaper), which is a perfectly meaningful comparison to show.
    const equalPrices =
        stores.length < 2 ||
        (maxTotal - cheapestTotal) < 0.50;

    return {
        stores,
        yoursTotal: round2(yoursTotal),
        cheapestTotal: round2(cheapestTotal),
        medianTotal,
        cheaperStoreName,
        savedVsAvg: round2(medianTotal - yoursTotal),
        headroom: round2(Math.max(0, yoursTotal - cheapestTotal)),
        equalPrices,
    };
};
