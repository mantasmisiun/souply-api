/**
 * One-off backfill: `receipt_buy` ProductInteractions from historical receipts.
 *
 * The live receipt_buy wiring (receiptSaveService, 2026-07-16) only fires on
 * NEW initial saves — every receipt uploaded before it produced zero purchase
 * signals, so UserProductScore / Product.globalScore rank on basket_add and
 * list_check alone (see shared/SMART_BASKET_SPEC.md §3).
 *
 * This script inserts one receipt_buy interaction per historical S1/S2
 * resolved ReceiptItem, with `createdAt = Receipt.receiptDate` (falling back
 * to NOW() for the rare dateless receipt) so the 90-day decay treats old purchases honestly, then
 * recalculates the affected UserProductScore rows and the global scores.
 *
 * Idempotent: refuses to double-insert by checking for ANY existing
 * receipt_buy rows for the (user, product, day) triple.
 *
 * Usage: npm run scores:backfillbuys   (add --dry to preview counts only)
 */

import '../config/env.js'; // MUST be first — loads .env so the pool gets DB creds.
import pool from '../config/db.js';
import { recalcUserProductScore, recalcGlobalScores } from '../models/productInteractionModel.js';

const dry = process.argv.includes('--dry');

async function main(): Promise<void> {
    // One row per S1/S2 resolved line with a product binding. DISTINCT per
    // (receipt, product): a receipt with two lines of the same product still
    // proves one purchase event of that product on that trip.
    const [rows]: any = await pool.query(
        `SELECT DISTINCT r.userId, sp.productId, r.id AS receiptId,
                COALESCE(r.receiptDate, NOW()) AS boughtAt
         FROM ReceiptItem ri
         JOIN Receipt r      ON r.id = ri.receiptId
         JOIN StoreProduct sp ON sp.id = ri.matchedSpId
         WHERE ri.matchedSpId IS NOT NULL
           AND ri.band IN ('S1','S2')
           AND sp.productId IS NOT NULL`,
    );
    console.log(`[backfill] candidate purchase events: ${rows.length}`);

    let inserted = 0, skipped = 0;
    for (const row of rows) {
        const { userId, productId, boughtAt } = row;
        // Skip if a receipt_buy for this user+product on the same DAY already
        // exists (covers re-runs AND events the live path already logged).
        const [existing]: any = await pool.query(
            `SELECT 1 FROM ProductInteraction
             WHERE userId = ? AND productId = ? AND type = 'receipt_buy'
               AND DATE(createdAt) = DATE(?)
             LIMIT 1`,
            [userId, productId, boughtAt],
        );
        if (existing.length > 0) { skipped++; continue; }
        if (!dry) {
            await pool.query(
                `INSERT INTO ProductInteraction (userId, productId, type, createdAt)
                 VALUES (?, ?, 'receipt_buy', ?)`,
                [userId, productId, boughtAt],
            );
        }
        inserted++;
    }
    console.log(`[backfill] inserted=${inserted} skipped=${skipped}${dry ? ' (dry run — nothing written)' : ''}`);

    if (!dry && inserted > 0) {
        // Recalc per-user scores for every touched pair, then the globals.
        const pairs = new Map<string, { userId: string; productId: number }>();
        for (const r of rows) pairs.set(`${r.userId}:${r.productId}`, r);
        for (const { userId, productId } of pairs.values()) {
            await recalcUserProductScore(userId, productId);
        }
        await recalcGlobalScores();
        console.log(`[backfill] recalculated ${pairs.size} user-product scores + global scores`);
    }
    await pool.end();
}

main().catch((e) => { console.error('[backfill] failed:', e); process.exit(1); });
