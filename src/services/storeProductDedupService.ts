import pool from '../config/db.js';

/**
 * Physically merge a DUPLICATE StoreProduct into the listing that stays.
 * For two SPs of the SAME chain whose names are token-set-identical — the same
 * listing recorded twice — so their price histories interleave correctly.
 *
 * Every table referencing storeProductId is re-pointed drop→keep inside one
 * transaction using the same two-step pattern:
 *   1. UPDATE IGNORE …  (unique-key collisions — the keep row already has the
 *      equivalent entry — are skipped, keeping the keep-side row)
 *   2. DELETE the leftover drop-side rows the IGNORE skipped
 * Pair tables (votes/equivalences/matches) first drop rows where BOTH sides are
 * in {keep, drop} — a vote between the two halves of one listing is meaningless.
 *
 * The drop SP row is deleted at the end. The caller handles the (possibly now
 * SP-less) Product that owned it — e.g. soft-merge via promoteMergeByProductIds.
 */
export async function dedupStoreProduct(keepSpId: number, dropSpId: number): Promise<void> {
    if (keepSpId === dropSpId) throw new Error('keep and drop SP are the same');
    const conn = await (pool as any).getConnection();
    try {
        await conn.beginTransaction();

        const [spRows]: any = await conn.query(
            'SELECT id, imageUrl FROM StoreProduct WHERE id IN (?, ?)', [keepSpId, dropSpId]);
        if ((spRows as any[]).length !== 2) throw new Error(`SP pair ${keepSpId}/${dropSpId} not found`);
        const keep = (spRows as any[]).find(r => Number(r.id) === keepSpId)!;
        const drop = (spRows as any[]).find(r => Number(r.id) === dropSpId)!;

        // Backfill image from the duplicate if the keeper has none.
        if (!keep.imageUrl && drop.imageUrl) {
            await conn.query('UPDATE StoreProduct SET imageUrl = ? WHERE id = ?', [drop.imageUrl, keepSpId]);
        }

        // Pair tables: kill self-pairs first, then re-point both sides.
        const pairTables: Array<[string, string, string]> = [
            ['UserStoreProductEquivalence', 'spIdA', 'spIdB'],
            ['StoreProductMatch', 'spIdA', 'spIdB'],
            ['StoreProductMatchVote', 'spIdA', 'spIdB'],
        ];
        for (const [t, a, b] of pairTables) {
            await conn.query(
                `DELETE FROM ${t} WHERE ${a} IN (?, ?) AND ${b} IN (?, ?)`,
                [keepSpId, dropSpId, keepSpId, dropSpId]);
            for (const col of [a, b]) {
                await conn.query(`UPDATE IGNORE ${t} SET ${col} = ? WHERE ${col} = ?`, [keepSpId, dropSpId]);
                await conn.query(`DELETE FROM ${t} WHERE ${col} = ?`, [dropSpId]);
            }
        }

        // Single-column references.
        const refs: Array<[string, string]> = [
            ['StoreProductCode', 'storeProductId'],
            ['StoreProductCodeEvidence', 'resolvedSpId'],
            ['Price', 'storeProductId'],
            ['ShoppingListItem', 'storeProductId'],
            ['StoreProductReceiptAlias', 'storeProductId'],
            ['StoreProductTranslation', 'storeProductId'],
            ['ReceiptSwipeCandidate', 'storeProductId'],
            ['BasketTemplateItem', 'anchorSpId'],
            ['AdminCardLease', 'spId'],
            ['AdminReviewFlag', 'spId'],
            ['ImagePropagationLog', 'spId'],
            ['PendingImageUpload', 'spId'],
        ];
        for (const [t, col] of refs) {
            await conn.query(`UPDATE IGNORE ${t} SET ${col} = ? WHERE ${col} = ?`, [keepSpId, dropSpId]);
            await conn.query(`DELETE FROM ${t} WHERE ${col} = ?`, [dropSpId]);
        }

        await conn.query('DELETE FROM StoreProduct WHERE id = ?', [dropSpId]);

        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}
