/**
 * Souply 2.0 — basket auto-archive job (mirrors sweepTripAutoArchive).
 *
 * A PERSONAL draft/compared basket is an in-progress shopping cart. If it is
 * not converted into a shopping list within 48 h of its last edit it's an
 * abandoned cart: archive it so it leaves the resumable pool (the Add chooser
 * and any silent-resume) instead of being silently resurrected days later —
 * the "banana landed in a basket I made a while ago" bug.
 *
 * NEVER archived:
 *   · family / shared baskets (householdId set) — a shared context, not a
 *     personal cart, and its own resume rules apply.
 *   · converted baskets — a ShoppingList was created from it (or tripId is
 *     set); it graduated to a plan and lives on as trip history.
 *
 * Inactivity anchor = Basket.updatedAt (bumped by any item add/remove/rename).
 * SET-BASED, one UPDATE. Idempotent: an already-archived row won't re-match.
 */
import pool from '../config/db.js';

export interface BasketArchiveSweepResult {
    archived: number;
}

export const sweepBasketAutoArchive = async (): Promise<BasketArchiveSweepResult> => {
    const [res]: any = await pool.query(
        `UPDATE Basket b
         SET b.archivedAt = NOW()
         WHERE b.archivedAt IS NULL
           AND b.householdId IS NULL
           AND b.tripId IS NULL
           AND b.status IN ('draft', 'compared')
           AND b.updatedAt < DATE_SUB(NOW(), INTERVAL 48 HOUR)
           AND NOT EXISTS (SELECT 1 FROM ShoppingList sl WHERE sl.basketId = b.id)`,
    );
    const result = { archived: Number(res.affectedRows ?? 0) };
    if (result.archived > 0) {
        console.log(`[basketArchive] archived: ${result.archived}`);
    }
    return result;
};
