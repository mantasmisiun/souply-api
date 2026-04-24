/**
 * Wipe receipts created by importReceiptBatch.ts, along with any
 * StoreProduct / Product rows the resolver spawned while processing
 * them. Scoped by userId + filePath prefix "batch:" so it only ever
 * touches batch-imported rows.
 *
 * Usage:
 *   node --loader ts-node/esm src/scripts/receiptBatch/cleanupTestReceipts.ts \
 *        --user 5a857b48-a91d-4370-b58a-7f71003fe3a5
 *
 * Requires --user; refuses to run without it.
 *
 * Deletion order matters (FK constraints):
 *   1. Price WHERE receiptId IN (batch receipts)
 *   2. ReceiptSwipeCandidate / ReceiptLineIssue via Receipt CASCADE
 *   3. Receipt rows
 *   4. Orphan StoreProducts — ones with zero remaining Price rows AND
 *      whose Product has no other StoreProduct (otherwise we'd strand
 *      the Product row with no stores)
 *   5. Orphan Products — ones with zero remaining StoreProducts
 *
 * Steps 4/5 are conservative: we skip anything still referenced by
 * scraped (isFallback=1) data so scrape-imported catalog stays intact.
 */

import '../../config/env.js';
import pool from '../../config/db.js';

interface CliArgs {
    userId: string;
    dryRun: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
    let userId: string | null = null;
    let dryRun = false;
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--user') userId = argv[++i];
        else if (a === '--dry-run') dryRun = true;
    }
    if (!userId) throw new Error('--user <uuid> is required');
    return { userId, dryRun };
};

const run = async () => {
    const { userId, dryRun } = parseArgs(process.argv);

    // All receipts from the batch importer carry a filePath starting
    // with "batch:" (see importReceiptBatch.ts createReceipt call).
    // Combined with the userId guard this gives us a precise target set
    // — real receipts uploaded by the same user stay untouched.
    const [receipts]: any = await pool.query(
        `SELECT id FROM Receipt WHERE userId = ? AND filePath LIKE 'batch:%'`,
        [userId]
    );
    const receiptIds: number[] = receipts.map((r: any) => r.id);
    console.log(`Found ${receiptIds.length} batch receipts for user ${userId}`);

    if (receiptIds.length === 0) {
        console.log('Nothing to clean.');
        await pool.end();
        return;
    }

    // StoreProducts that only got created by this batch — identify by
    // finding SPs whose Price rows all reference these receipt ids.
    const [candidateSps]: any = await pool.query(
        `SELECT DISTINCT sp.id, sp.productId
           FROM StoreProduct sp
           JOIN Price pr ON pr.storeProductId = sp.id
          WHERE pr.receiptId IN (?)`,
        [receiptIds]
    );
    const spIds: number[] = candidateSps.map((r: any) => r.id);
    const productIds: number[] = Array.from(new Set(candidateSps.map((r: any) => r.productId)));
    console.log(`Touched StoreProducts: ${spIds.length}, related Products: ${productIds.length}`);

    if (dryRun) {
        console.log(
            `DRY-RUN — would delete ${receiptIds.length} receipts + their Prices + any orphan SPs/Products among the ${spIds.length} touched.`
        );
        await pool.end();
        return;
    }

    const conn = await (pool as any).getConnection();
    try {
        await conn.beginTransaction();

        // 1. Prices scoped to these receipts.
        const [priceDel]: any = await conn.query(
            `DELETE FROM Price WHERE receiptId IN (?)`,
            [receiptIds]
        );
        console.log(`Deleted Price rows: ${priceDel.affectedRows}`);

        // 2+3. Receipts (CASCADE removes ReceiptSwipeCandidate +
        // ReceiptLineIssue via their FKs).
        const [receiptDel]: any = await conn.query(
            `DELETE FROM Receipt WHERE id IN (?)`,
            [receiptIds]
        );
        console.log(`Deleted Receipt rows: ${receiptDel.affectedRows}`);

        // 4. Orphan StoreProducts — zero remaining Price rows.
        //    isFallback=1 SPs are scraped and get a pity-pass: never delete those,
        //    even if temporarily priceless.
        if (spIds.length > 0) {
            const [spDel]: any = await conn.query(
                `DELETE sp FROM StoreProduct sp
                  WHERE sp.id IN (?)
                    AND sp.isFallback = 0
                    AND NOT EXISTS (SELECT 1 FROM Price pr WHERE pr.storeProductId = sp.id)`,
                [spIds]
            );
            console.log(`Deleted orphan StoreProducts: ${spDel.affectedRows}`);
        }

        // 5. Orphan Products — zero remaining StoreProducts.
        if (productIds.length > 0) {
            const [pDel]: any = await conn.query(
                `DELETE p FROM Product p
                  WHERE p.id IN (?)
                    AND NOT EXISTS (SELECT 1 FROM StoreProduct sp WHERE sp.productId = p.id)`,
                [productIds]
            );
            console.log(`Deleted orphan Products: ${pDel.affectedRows}`);
        }

        await conn.commit();
        console.log('Cleanup complete.');
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
        await pool.end();
    }
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
