/**
 * Post-hoc repair: re-resolve categories for IKI Products that landed in
 * Nepriskirta (688) because the initial import read the wrong column key
 * (`_category_` instead of `_category`).
 *
 * What it does, exactly:
 *   1. Re-read receipts/iki_products_v2.xlsx
 *   2. Build a map: lowercased product name → resolved Category id (via
 *      resolveCategoryByPath on the `_category` cell)
 *   3. Find every Product where categoryId = 688 AND at least one linked
 *      StoreProduct has chainId = 3
 *   4. Look up each such Product's name in the map; if we have a resolved
 *      category id, UPDATE it. Safe: touches only rows currently at 688.
 *
 * Usage:
 *   npx node --loader ts-node/esm src/scripts/repairIkiCategories.ts
 *
 * Dry-run (recommended first):
 *   npx node --loader ts-node/esm src/scripts/repairIkiCategories.ts --dry
 */

import '../config/env.js';
import xlsx from 'xlsx';
const { readFile, utils } = xlsx;
import path from 'node:path';
import url from 'node:url';
import pool from '../config/db.js';
import { resolveCategoryByPath } from '../models/categoryModel.js';

const SPREADSHEET_PATH = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '../../receipts/iki_products_v2.xlsx'
);

const NEPRISKIRTA_ID = 688;
const IKI_CHAIN_ID = 3;
const DRY_RUN = process.argv.includes('--dry');

const toStringOrNull = (v: any): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
};

function parseIkiCategoryCell(v: any): string[] {
    const s = toStringOrNull(v);
    if (!s) return [];
    const parts = s.split(/[\/>]/).map(p => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [s];
}

async function main() {
    console.log(`[${DRY_RUN ? 'DRY' : 'COMMIT'}] reading ${SPREADSHEET_PATH}`);
    const wb = readFile(SPREADSHEET_PATH, { cellDates: true });
    const rows: any[] = utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
    console.log(`Loaded ${rows.length} rows`);

    // ── Build name → categoryId map from xlsx ──────────────────────
    // Cache resolveCategoryByPath results per unique breadcrumb string
    // to keep DB queries reasonable.
    const pathCache = new Map<string, number | null>();
    const nameToCategory = new Map<string, number>();   // lowercased name → resolved cat id

    let xlsxRowsWithName = 0;
    let xlsxRowsResolved = 0;
    for (const row of rows) {
        const name = toStringOrNull(row.name);
        if (!name) continue;
        xlsxRowsWithName++;
        const key = name.toLowerCase();
        if (nameToCategory.has(key)) continue;

        const segs = parseIkiCategoryCell(row._category);
        if (segs.length === 0) continue;
        const pathKey = segs.map(s => s.toLowerCase()).join('|');
        let catId: number | null;
        if (pathCache.has(pathKey)) {
            catId = pathCache.get(pathKey)!;
        } else {
            catId = await resolveCategoryByPath(segs);
            pathCache.set(pathKey, catId);
        }
        if (catId !== null) {
            nameToCategory.set(key, catId);
            xlsxRowsResolved++;
        }
    }
    console.log(`xlsx: ${xlsxRowsWithName} rows with name, ${nameToCategory.size} unique names resolvable (${xlsxRowsResolved} first-sights resolved)`);

    // ── Pull stuck Products that have an IKI SP ────────────────────
    const [stuck]: any = await pool.query(
        `SELECT DISTINCT p.id, p.name
         FROM Product p
         JOIN StoreProduct sp ON sp.productId = p.id
         WHERE p.categoryId = ?
           AND sp.chainId = ?
           AND p.mergedIntoId IS NULL`,
        [NEPRISKIRTA_ID, IKI_CHAIN_ID]
    );
    console.log(`DB: ${stuck.length} Products currently at Nepriskirta with an IKI StoreProduct`);

    let updates = 0;
    let noResolution = 0;
    const categoryHistogram = new Map<number, number>();
    for (const p of stuck as any[]) {
        const key = String(p.name).toLowerCase();
        const resolved = nameToCategory.get(key);
        if (resolved === undefined) { noResolution++; continue; }
        categoryHistogram.set(resolved, (categoryHistogram.get(resolved) ?? 0) + 1);
        if (!DRY_RUN) {
            await pool.query(
                `UPDATE Product SET categoryId = ? WHERE id = ? AND categoryId = ?`,
                [resolved, p.id, NEPRISKIRTA_ID]
            );
        }
        updates++;
    }

    console.log(`\n=== Repair Summary ===`);
    console.log(`Would update:                ${updates}`);
    console.log(`Remaining at Nepriskirta:    ${noResolution}`);
    console.log(`Distinct target categories:  ${categoryHistogram.size}`);
    if (categoryHistogram.size > 0) {
        const top = [...categoryHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log(`Top 10 target categories (id → count):`);
        for (const [cid, n] of top) console.log(`  ${cid}: ${n}`);
    }
    if (DRY_RUN) console.log('\n(DRY run — no DB writes. Re-run without --dry to commit.)');

    await pool.end();
}

main().catch((e) => {
    console.error('\nRepair failed:', e);
    process.exit(1);
});
