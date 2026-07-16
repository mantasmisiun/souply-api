/**
 * Souply 2.0 — trip auto-archive job (spec: 48 h for stages 1–2, 7 d for
 * stages 3–4, never stage 5; archived trips leave the notification dot and
 * stop being auto-add targets).
 *
 * SET-BASED, one pass: stage is approximated in SQL exactly the way
 * deriveTripStage does it in code —
 *   no lists                        → stage 1/2 bucket (48 h)
 *   lists exist, any slot open      → stage 3/4 bucket (7 d)
 *   all slots closed (receipt/skip) → stage 5 (never archived)
 * Inactivity anchor = Trip.updatedAt (bumped by any trip mutation).
 */
import pool from '../config/db.js';

export interface ArchiveSweepResult {
    formingArchived: number;
    plannedArchived: number;
}

export const sweepTripAutoArchive = async (): Promise<ArchiveSweepResult> => {
    // Stage 1–2: no shopping lists attached, idle ≥ 48 h.
    const [forming]: any = await pool.query(
        `UPDATE Trip t
         SET t.archivedAt = NOW()
         WHERE t.archivedAt IS NULL
           AND t.isAdHoc = 0
           AND t.updatedAt < DATE_SUB(NOW(), INTERVAL 48 HOUR)
           AND NOT EXISTS (SELECT 1 FROM ShoppingList sl WHERE sl.tripId = t.id)`,
    );

    // Stage 3–4: lists exist, at least one slot NOT closed (no receipt for its
    // store and not skipped), idle ≥ 7 d. Closed-everything trips are stage 5.
    const [planned]: any = await pool.query(
        `UPDATE Trip t
         SET t.archivedAt = NOW()
         WHERE t.archivedAt IS NULL
           AND t.isAdHoc = 0
           AND t.updatedAt < DATE_SUB(NOW(), INTERVAL 7 DAY)
           AND EXISTS (SELECT 1 FROM ShoppingList sl WHERE sl.tripId = t.id)
           AND EXISTS (
               SELECT 1 FROM ShoppingList sl
               WHERE sl.tripId = t.id
                 AND sl.receiptSkippedAt IS NULL
                 AND NOT EXISTS (
                     SELECT 1 FROM Receipt r
                     WHERE r.tripId = sl.tripId AND r.storeId = sl.storeId
                 )
           )`,
    );

    const result = {
        formingArchived: Number(forming.affectedRows ?? 0),
        plannedArchived: Number(planned.affectedRows ?? 0),
    };
    if (result.formingArchived + result.plannedArchived > 0) {
        console.log(`[tripArchive] archived: forming=${result.formingArchived}, planned=${result.plannedArchived}`);
    }
    return result;
};
