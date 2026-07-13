/**
 * Recompute & (optionally) update Receipt.savedAmount for specific receipts.
 *
 * Use after a product re-cluster changes an item's market-average basis — e.g.
 * "Airanas" moved out of the saffran Product 5125 into Product 346. Savings is
 * recomputed with the same logic the save path uses (computeReceiptSavings),
 * which resolves storeProductId → productId LIVE, so it picks up the corrected
 * cluster. NO API deploy needed — this just reads the live DB and rewrites one
 * column.
 *
 *   npx tsx src/scripts/recomputeReceiptSavings.ts 81 75           # dry run (prints old → new)
 *   npx tsx src/scripts/recomputeReceiptSavings.ts --write 81 75   # actually update
 *
 * Point it at the target DB with the usual env (e.g. via the DBeaver tunnel):
 *   DB_HOST=127.0.0.1 DB_PORT=<tunnel> DB_USER=souply_app DB_PASSWORD=… DB_NAME=souply_production
 */
import pool from '../config/db.js';
import { getReceiptById, updateReceiptSavedAmount } from '../models/receiptModel.js';
import { comboDiscountOf, computeReceiptSavings } from '../services/statsService.js';

async function main() {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const ids = args.filter(a => /^\d+$/.test(a)).map(Number);
    if (!ids.length) {
        console.error('usage: recomputeReceiptSavings [--write] <receiptId...>');
        process.exit(1);
    }

    for (const id of ids) {
        const r: any = await getReceiptById(id);
        if (!r) { console.log(`receipt ${id}: not found`); continue; }
        const parsed = typeof r.parsedData === 'string' ? JSON.parse(r.parsedData) : r.parsedData;
        const items = (parsed?.products ?? [])
            .filter((p: any) => p.matchConfirmed && p.storeProductId && p.price > 0)
            .map((p: any) => ({
                storeProductId: Number(p.storeProductId),
                price: Number(p.price),
                quantity: Number(p.quantity) || 1,
            }));
        // Same combo/set-deal adjustment as the save paths (footer.comboDiscount).
        const lineSum = (parsed?.products ?? []).reduce(
            (s: number, p: any) => s + (Number(p.price) > 0 ? Number(p.price) * (Number(p.quantity) || 1) : 0), 0);
        const combo = comboDiscountOf(parsed, lineSum);
        const next = Math.round((await computeReceiptSavings(items) + combo) * 100) / 100;
        console.log(`receipt ${id}: savedAmount ${r.savedAmount} → ${next}${combo ? ` (incl. combo +${combo})` : ''}${write ? '  (updated)' : '  (dry-run)'}`);
        if (write) await updateReceiptSavedAmount(id, next);
    }

    await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
