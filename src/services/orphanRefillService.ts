import pool from '../config/db.js';
import { refillForOrphans } from '../scripts/seedOrphanSwipeCandidates.js';

/**
 * On-demand orphan candidate refill scoped to a single user.
 *
 * The batch seeder (`seedOrphanSwipeCandidates`) is a manual script that
 * doesn't run after every receipt upload, so orphans created since the
 * last seed have no `OrphanSwipeCandidate` rows. Voluntary mode hits
 * this service before fetching the queue to fill the gap just-in-time
 * for the requesting user.
 *
 * Scope is narrowed by:
 *  - userId (only the user's own auto-matched orphan SPs trigger refill)
 *  - having `OrphanSwipeCandidate.orphanProductId IS NULL` (already-seeded
 *    orphans are skipped — refill is idempotent but the snapshot load is
 *    expensive enough that we don't want to redo it for nothing)
 *
 * Returns the number of OSC rows newly inserted.
 */
export async function refillUserOrphansIfMissing(userId: string): Promise<number> {
    const [rows]: any = await pool.query(
        `SELECT DISTINCT op.id AS productId
           FROM Receipt r
           JOIN ReceiptSwipeCandidate rsc
             ON rsc.receiptId = r.id AND rsc.autoMatched = 1
           JOIN StoreProduct osp ON osp.id = rsc.storeProductId
           JOIN Product op
             ON op.id = osp.productId
            AND op.categoryId = 688
            AND op.mergedIntoId IS NULL
           LEFT JOIN OrphanSwipeCandidate osc
             ON osc.orphanProductId = op.id
          WHERE r.userId = ?
            AND osc.id IS NULL`,
        [userId],
    );

    const productIds = (rows as any[]).map(r => Number(r.productId));
    if (productIds.length === 0) return 0;
    return refillForOrphans(productIds);
}
