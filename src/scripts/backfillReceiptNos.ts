/**
 * Backfill Receipt.receiptNos from existing data.
 *
 * The receiptNos column (the functional set of receipt identifiers, kept independent of the raw
 * parsedData blob) is added by sql/receipt_receiptnos.sql. This script populates it for the rows
 * that already exist, with the SAME normalization the live save path uses (Kasa-strip, canonical
 * FIRST, dedupe) — so backfilled values are identical to freshly-saved ones.
 *
 * Source per row, in order of preference:
 *   1. parsedData.footer.receiptNos — the array the multi-id parser wrote (newer receipts).
 *   2. [receiptNo] — the canonical scalar (older receipts, predating the array).
 *
 * Idempotent: only touches rows where receiptNos IS NULL, in id batches. Safe to re-run.
 *
 *   Run AFTER applying sql/receipt_receiptnos.sql:  tsx src/scripts/backfillReceiptNos.ts
 *   Dry run (no writes, just counts):               tsx src/scripts/backfillReceiptNos.ts --dry
 */
import pool from '../config/db.js';
import { normalizeReceiptNos } from '../utils/receiptMetadata.js';

const BATCH = 500;
const DRY = process.argv.includes('--dry');

function parsedFooter(parsedData: unknown): { receiptNos: string[]; receiptNo: string | null } {
    if (typeof parsedData !== 'string') return { receiptNos: [], receiptNo: null };
    try {
        const f = JSON.parse(parsedData)?.footer ?? {};
        const arr = Array.isArray(f.receiptNos) ? f.receiptNos.filter((v: unknown): v is string => typeof v === 'string') : [];
        const canonical = typeof f.receiptNo === 'string' && f.receiptNo.trim() ? f.receiptNo : null;
        return { receiptNos: arr, receiptNo: canonical };
    } catch {
        return { receiptNos: [], receiptNo: null };
    }
}

async function main() {
    let lastId = 0;
    let scanned = 0;
    let updated = 0;
    let empty = 0; // rows with neither a parsed array nor a canonical receiptNo → left NULL

    for (;;) {
        // Read the canonical from parsedData.footer (the blob), NOT a `receiptNo` column — so this
        // script works whether it runs BEFORE or AFTER the column is dropped (the blob's
        // footer.receiptNo === the old column value). Schema-agnostic + idempotent.
        const [rows]: any = await pool.query(
            `SELECT id, parsedData
               FROM Receipt
              WHERE receiptNos IS NULL AND id > ?
              ORDER BY id ASC
              LIMIT ?`,
            [lastId, BATCH],
        );
        if (!rows.length) break;

        for (const r of rows as Array<{ id: number; parsedData: unknown }>) {
            lastId = r.id;
            scanned++;
            const f = parsedFooter(r.parsedData);
            const receiptNos = normalizeReceiptNos(f.receiptNos, f.receiptNo);
            if (receiptNos.length === 0) { empty++; continue; }
            if (!DRY) {
                await pool.query(`UPDATE Receipt SET receiptNos = ? WHERE id = ? AND receiptNos IS NULL`, [
                    JSON.stringify(receiptNos),
                    r.id,
                ]);
            }
            updated++;
        }
        console.log(`[backfillReceiptNos] …id<=${lastId}: scanned=${scanned} updated=${updated} empty=${empty}`);
    }

    console.log(`[backfillReceiptNos] DONE${DRY ? ' (DRY RUN — no writes)' : ''}: scanned=${scanned} updated=${updated} left-null=${empty}`);
}

main()
    .then(async () => { await pool.end(); process.exit(0); })
    .catch(async (e) => {
        console.error('[backfillReceiptNos] FAILED', e);
        try { await pool.end(); } catch { /* ignore */ }
        process.exit(1);
    });
