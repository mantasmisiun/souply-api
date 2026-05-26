import pool from '../config/db.js';
import { logAdminAction } from './adminActionLog.js';
import { markResolvedForProductPair } from '../models/orphanSwipeCandidateModel.js';

export interface MergeResult {
    winnerId: number;
    winnerName: string;
    loserIds: number[];
    loserNames: string[];
}

/**
 * Merge 2+ Products into one canonical winner (highest globalScore).
 *
 * All writes run inside a single transaction. Order matters:
 *   1. Cache SP ids for winner + losers (needed for equivalence cleanup
 *      before SPs are re-pointed).
 *   2. Set Product.mergedIntoId on every loser.
 *   3. Delete UserStoreProductEquivalence rows where the user voted a
 *      winner-SP vs. loser-SP pair as 'different' — those contradict
 *      the merge and would incorrectly resurface the loser for that user.
 *   4. Re-point StoreProduct.productId → winner.
 *   5. Migrate ProductInteraction → winner (so nightly score recalc
 *      aggregates all purchase history into the winner).
 *   6. Drop stale UserProductScore rows for losers (stale after SP re-point).
 *   7. Basket dedup: sum quantities when a basket already has both winner
 *      and a loser, then re-point remaining loser rows.
 *   8. Re-point ShoppingListItem.productId → winner.
 *   9. Remove loser rows from DiscountedProductSummary (materialised view;
 *      winner's row refreshes on next scrape/cron cycle).
 *  10. Mark OrphanSwipeCandidate rows resolved for every winner↔loser pair.
 *  11. Write one AdminAuditLog row per loser.
 */
export async function mergeProducts(
    productIds: number[],
    actingAdminId: string,
): Promise<MergeResult> {
    if (productIds.length < 2) throw new Error('At least 2 products required');

    // Load all candidates — validates existence in one query.
    const [rows]: any = await pool.query(
        `SELECT id, name, globalScore, mergedIntoId FROM Product WHERE id IN (?)`,
        [productIds],
    );

    if ((rows as any[]).length !== productIds.length) {
        throw new Error('One or more products not found');
    }
    for (const r of rows as any[]) {
        if (r.mergedIntoId !== null) {
            throw new Error(`Product ${r.id} ("${r.name}") is already merged into ${r.mergedIntoId} — resolve the chain first`);
        }
    }

    // Winner = highest globalScore. Ties broken by lower id (stable sort).
    const sorted = [...(rows as any[])].sort((a, b) => {
        const scoreDiff = Number(b.globalScore) - Number(a.globalScore);
        return scoreDiff !== 0 ? scoreDiff : Number(a.id) - Number(b.id);
    });
    const winner = sorted[0];
    const losers = sorted.slice(1);
    const loserIds = losers.map((r: any) => Number(r.id));

    const conn = await (pool as any).getConnection();
    try {
        await conn.beginTransaction();

        // ── Step 1: Cache SP ids before re-pointing ──────────────────────────
        const [winnerSpRows]: any = await conn.query(
            `SELECT id FROM StoreProduct WHERE productId = ?`,
            [winner.id],
        );
        const winnerSpIds: number[] = (winnerSpRows as any[]).map(r => Number(r.id));

        const loserSpMap: Map<number, number[]> = new Map();
        for (const loserId of loserIds) {
            const [loserSpRows]: any = await conn.query(
                `SELECT id FROM StoreProduct WHERE productId = ?`,
                [loserId],
            );
            loserSpMap.set(loserId, (loserSpRows as any[]).map(r => Number(r.id)));
        }

        // ── Step 2: Soft-delete losers ───────────────────────────────────────
        await conn.query(
            `UPDATE Product SET mergedIntoId = ? WHERE id IN (?)`,
            [winner.id, loserIds],
        );

        // ── Step 3: Delete contradicting personal equivalences ───────────────
        for (const loserId of loserIds) {
            const loserSps = loserSpMap.get(loserId) ?? [];
            if (winnerSpIds.length === 0 || loserSps.length === 0) continue;
            await conn.query(
                `DELETE FROM UserStoreProductEquivalence
                  WHERE verdict = 'different'
                    AND (
                        (spIdA IN (?) AND spIdB IN (?))
                     OR (spIdA IN (?) AND spIdB IN (?))
                    )`,
                [winnerSpIds, loserSps, loserSps, winnerSpIds],
            );
        }

        // ── Step 4: Re-point loser SPs to winner ────────────────────────────
        await conn.query(
            `UPDATE StoreProduct SET productId = ? WHERE productId IN (?)`,
            [winner.id, loserIds],
        );

        // ── Step 5: Migrate ProductInteraction ──────────────────────────────
        await conn.query(
            `UPDATE ProductInteraction SET productId = ? WHERE productId IN (?)`,
            [winner.id, loserIds],
        );

        // ── Step 6: Drop stale UserProductScore rows ─────────────────────────
        await conn.query(
            `DELETE FROM UserProductScore WHERE productId IN (?)`,
            [loserIds],
        );

        // ── Step 7: Basket dedup then re-point ──────────────────────────────
        for (const loserId of loserIds) {
            // Find baskets that hold both the loser and the winner.
            const [overlaps]: any = await conn.query(
                `SELECT bi_l.basketId,
                        bi_l.id      AS loserItemId,
                        bi_l.quantity AS loserQty,
                        bi_w.id      AS winnerItemId,
                        bi_w.quantity AS winnerQty
                   FROM BasketItem bi_l
                   JOIN BasketItem bi_w
                     ON bi_w.basketId  = bi_l.basketId
                    AND bi_w.productId = ?
                  WHERE bi_l.productId = ?`,
                [winner.id, loserId],
            );
            for (const ov of overlaps as any[]) {
                await conn.query(
                    `UPDATE BasketItem SET quantity = ? WHERE id = ?`,
                    [Number(ov.winnerQty) + Number(ov.loserQty), ov.winnerItemId],
                );
                await conn.query(`DELETE FROM BasketItem WHERE id = ?`, [ov.loserItemId]);
            }
        }
        // Re-point any remaining loser basket rows.
        await conn.query(
            `UPDATE BasketItem SET productId = ? WHERE productId IN (?)`,
            [winner.id, loserIds],
        );

        // ── Step 8: Re-point ShoppingListItems ──────────────────────────────
        await conn.query(
            `UPDATE ShoppingListItem SET productId = ? WHERE productId IN (?)`,
            [winner.id, loserIds],
        );

        // ── Step 9: Remove loser rows from materialized discounts table ──────
        await conn.query(
            `DELETE FROM DiscountedProductSummary WHERE productId IN (?)`,
            [loserIds],
        );

        // ── Step 10: Resolve orphan swipe candidates ─────────────────────────
        for (const loserId of loserIds) {
            await markResolvedForProductPair(Number(winner.id), loserId, 'promoted', conn);
        }

        // ── Step 11: Audit log ───────────────────────────────────────────────
        for (const loser of losers) {
            await logAdminAction({
                adminUserId: actingAdminId,
                action: 'product_merge',
                targetType: 'Product',
                targetId: Number(winner.id),
                valueBefore: { mergedProductId: Number(loser.id), mergedProductName: loser.name },
                valueAfter: { winnerId: Number(winner.id), winnerName: winner.name },
            });
        }

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    return {
        winnerId: Number(winner.id),
        winnerName: winner.name,
        loserIds,
        loserNames: losers.map((r: any) => r.name),
    };
}
