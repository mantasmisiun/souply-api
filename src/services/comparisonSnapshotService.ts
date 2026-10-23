import pool from '../config/db.js';
import { getReceiptComparison } from './receiptComparisonService.js';

/**
 * Souply 2.0 Phase 5 — freeze the receipt's comparable-store deltas at save
 * time (spec: Sutaupyta = median comparable-store total − paid, SIGNED;
 * Galėjai sutaupyti = paid − cheapest alternative). Recomputed whenever the
 * receipt's products change (initial save, autosave, reparse) — never when
 * catalog prices later drift.
 */
export const snapshotReceiptComparison = async (receiptId: number): Promise<void> => {
    const cmp = await getReceiptComparison(receiptId);
    const paid = Number(cmp?.currentChain?.total) || 0;
    const altTotals = (cmp?.alternatives ?? [])
        .map((a: any) => Number(a.total))
        .filter((v: number) => Number.isFinite(v) && v > 0)
        .sort((a: number, b: number) => a - b);
    const median = altTotals.length
        ? (altTotals.length % 2
            ? altTotals[(altTotals.length - 1) / 2]
            : (altTotals[altTotals.length / 2 - 1] + altTotals[altTotals.length / 2]) / 2)
        : null;
    const cheapest = altTotals.length ? altTotals[0] : null;
    await pool.query(
        `INSERT INTO ReceiptComparisonSnapshot (receiptId, paidTotal, medianAltTotal, cheapestAltTotal, altCount, computedAt)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE paidTotal=VALUES(paidTotal), medianAltTotal=VALUES(medianAltTotal),
                                 cheapestAltTotal=VALUES(cheapestAltTotal), altCount=VALUES(altCount), computedAt=NOW()`,
        [receiptId, paid, median, cheapest, altTotals.length],
    );
};

export interface TripSavingsDeltas {
    /** Σ (median alternative − paid) over snapshotted receipts — SIGNED. */
    savedVsMedian: number | null;
    /** Σ max(0, paid − cheapest alternative) — what a perfect chooser keeps. */
    couldHaveSaved: number | null;
    snapshotCount: number;
}

export const tripSavingsDeltas = async (tripId: number): Promise<TripSavingsDeltas> => {
    const [rows]: any = await pool.query(
        `SELECT s.paidTotal, s.medianAltTotal, s.cheapestAltTotal
           FROM ReceiptComparisonSnapshot s
           JOIN Receipt r ON r.id = s.receiptId
          WHERE r.tripId = ?`,
        [tripId],
    );
    if (rows.length === 0) return { savedVsMedian: null, couldHaveSaved: null, snapshotCount: 0 };
    let saved = 0, could = 0, savedN = 0, couldN = 0;
    for (const row of rows) {
        const paid = Number(row.paidTotal) || 0;
        if (row.medianAltTotal != null) { saved += Number(row.medianAltTotal) - paid; savedN++; }
        if (row.cheapestAltTotal != null) { could += Math.max(0, paid - Number(row.cheapestAltTotal)); couldN++; }
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
        savedVsMedian: savedN ? r2(saved) : null,
        couldHaveSaved: couldN ? r2(could) : null,
        snapshotCount: rows.length,
    };
};
