/**
 * Retire LEGACY receipt-minted uncategorised orphan StoreProducts (ReceiptItem migration,
 * P4). Under the no-mint policy the receipt path no longer creates orphans, but the DB still
 * holds the ones minted before the cutover. This deletes only the UNENGAGED ones — nothing a
 * user or the vocabulary system ever touched — and re-points their receipt lines to unmatched
 * (matchedSpId NULL). ENGAGED orphans (a swipe vote, a learned alias, or a verified price) are
 * KEPT: they've earned catalog status. Nothing is lost — the OCR observation survives on the
 * ReceiptItem row (its price is unverified, already invisible to comparison).
 *
 * An orphan qualifies for retirement when ALL hold:
 *   - its Product is in the uncategorised category (Nepriskirta, 688),
 *   - the SP is receipt-minted (imageUrl IS NULL — scraped SKUs have images),
 *   - NO StoreProductReceiptAlias references it (no vocabulary engagement),
 *   - NO StoreProductMatchVote references it (no swipe engagement),
 *   - it has NO verified price (never confirmed).
 *
 *   Preview (safe, no writes):   npm run receipts:retireorphans
 *   Actually delete:            npm run receipts:retireorphans -- --commit
 */
import '../config/env.js'; // MUST be first — loads .env so the pool gets DB_HOST/etc.
import pool from '../config/db.js';

const COMMIT = process.argv.includes('--commit');
const NEPRISKIRTA = 688;

async function main() {
    const [orphans]: any = await pool.query(
        `SELECT sp.id AS spId, sp.productId, sp.storeProductName AS name
           FROM StoreProduct sp
           JOIN Product p ON p.id = sp.productId
          WHERE p.categoryId = ?
            AND sp.imageUrl IS NULL
            AND NOT EXISTS (SELECT 1 FROM StoreProductReceiptAlias a WHERE a.storeProductId = sp.id)
            AND NOT EXISTS (SELECT 1 FROM StoreProductMatchVote v WHERE v.spIdA = sp.id OR v.spIdB = sp.id)
            AND NOT EXISTS (SELECT 1 FROM Price pr WHERE pr.storeProductId = sp.id AND pr.priceVerified = 1)`,
        [NEPRISKIRTA],
    );

    console.log(`[retireOrphans] ${orphans.length} unengaged uncategorised orphan SP(s)${COMMIT ? '' : ' — DRY RUN (pass --commit to delete)'}`);
    if (orphans.length === 0) return;

    let sp = 0, prod = 0, price = 0, items = 0, skipped = 0;
    for (const o of orphans as Array<{ spId: number; productId: number; name: string }>) {
        if (!COMMIT) { console.log(`  would retire SP ${o.spId} ${JSON.stringify(o.name)} (product ${o.productId})`); continue; }
        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            // Re-point receipt lines to unmatched (belt-and-suspenders; the FK is ON DELETE SET NULL).
            const [ri]: any = await conn.query('UPDATE ReceiptItem SET matchedSpId = NULL WHERE matchedSpId = ?', [o.spId]);
            items += ri.affectedRows ?? 0;
            const [pr]: any = await conn.query('DELETE FROM Price WHERE storeProductId = ?', [o.spId]);
            price += pr.affectedRows ?? 0;
            await conn.query('DELETE FROM StoreProduct WHERE id = ?', [o.spId]); // cascades ReceiptSwipeCandidate etc.
            sp++;
            // Delete the Product only if it now has NO StoreProducts AND isn't a baseProduct parent.
            const [others]: any = await conn.query('SELECT 1 FROM StoreProduct WHERE productId = ? LIMIT 1', [o.productId]);
            const [asBase]: any = await conn.query('SELECT 1 FROM Product WHERE baseProductId = ? LIMIT 1', [o.productId]);
            if (others.length === 0 && asBase.length === 0) {
                await conn.query('DELETE FROM Product WHERE id = ?', [o.productId]);
                prod++;
            }
            await conn.commit();
        } catch (e) {
            await conn.rollback();
            skipped++;
            console.warn(`  SKIP SP ${o.spId} (retire failed — likely an unexpected FK reference; non-fatal): ${(e as Error)?.message ?? e}`);
        } finally { conn.release(); }
    }
    console.log(`[retireOrphans] DONE: retired ${sp} SP, ${prod} Product, ${price} Price row(s); re-pointed ${items} line(s) to unmatched; skipped ${skipped}`);
}

main()
    .then(async () => { await pool.end(); process.exit(0); })
    .catch(async (e) => { console.error('[retireOrphans] FAILED', e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
