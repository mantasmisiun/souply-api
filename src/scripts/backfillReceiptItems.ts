/**
 * Backfill ReceiptItem rows from existing Receipt.parsedData.products[] (P1 of the
 * ReceiptItem migration — see shared/RECEIPT_ITEM_MIGRATION.md).
 *
 * For every receipt that has no ReceiptItem rows yet, parse its blob and write one row per
 * line via the SAME canonical mapping (lineToItem) the live save path uses — so backfilled
 * rows are identical to freshly-saved ones. The blob is left untouched (rollback net until
 * the hard cutover). Idempotent: only touches receipts with zero ReceiptItem rows.
 *
 *   Run AFTER applying sql/receipt_item.sql:   tsx src/scripts/backfillReceiptItems.ts
 *   Dry run (parse + count, no writes):        tsx src/scripts/backfillReceiptItems.ts --dry
 */
import '../config/env.js'; // MUST be first — loads .env so the pool below gets DB_HOST/etc.
import pool from '../config/db.js';
import { replaceReceiptItems } from '../models/receiptItemModel.js';

const BATCH = 300;
const DRY = process.argv.includes('--dry');

function parseProducts(parsedData: unknown): any[] | null {
    let obj: any = parsedData;
    if (typeof parsedData === 'string') {
        try { obj = JSON.parse(parsedData); } catch { return null; }
    }
    if (!obj || !Array.isArray(obj.products)) return null;
    return obj.products;
}

async function main() {
    let lastId = 0;
    let scanned = 0, backfilled = 0, noProducts = 0, mismatched = 0, lines = 0;

    for (;;) {
        // Only receipts WITHOUT ReceiptItem rows yet (idempotent, re-runnable).
        const [rows]: any = await pool.query(
            `SELECT r.id, r.parsedData
               FROM Receipt r
              WHERE r.id > ?
                AND NOT EXISTS (SELECT 1 FROM ReceiptItem ri WHERE ri.receiptId = r.id)
              ORDER BY r.id ASC
              LIMIT ?`,
            [lastId, BATCH],
        );
        if (!rows.length) break;

        for (const r of rows as Array<{ id: number; parsedData: unknown }>) {
            lastId = r.id;
            scanned++;
            const products = parseProducts(r.parsedData);
            if (products === null) { noProducts++; continue; } // no parsable products[] → nothing to backfill
            if (DRY) { backfilled++; lines += products.length; continue; }
            const idMap = await replaceReceiptItems(r.id, products);
            lines += products.length;
            backfilled++;
            if (idMap.size !== products.length) {
                mismatched++;
                console.warn(`[backfillReceiptItems] receipt ${r.id}: inserted ${idMap.size} rows for ${products.length} products (MISMATCH)`);
            }
        }
        console.log(`[backfillReceiptItems] …id<=${lastId}: scanned=${scanned} backfilled=${backfilled} lines=${lines} no-products=${noProducts}`);
    }

    console.log(`[backfillReceiptItems] DONE${DRY ? ' (DRY RUN — no writes)' : ''}: scanned=${scanned} backfilled=${backfilled} lines=${lines} no-products=${noProducts} mismatched=${mismatched}`);
}

main()
    .then(async () => { await pool.end(); process.exit(0); })
    .catch(async (e) => {
        console.error('[backfillReceiptItems] FAILED', e);
        try { await pool.end(); } catch { /* ignore */ }
        process.exit(1);
    });
