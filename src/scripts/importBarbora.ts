/**
 * One-shot import of scraped Barbora data into Product + StoreProduct + Price.
 *
 * Usage:
 *   npx node --loader ts-node/esm src/scripts/importBarbora.ts
 *
 * Expects the spreadsheet at `receipts/barbora_products_v3.xlsx` with at
 * least these columns (any others are ignored):
 *   categoryId, name,
 *   chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl,
 *   storeId, price, promoPrice, promoEnd, isFallback, date, priceVerified
 *
 * Dedup rules:
 *   - Product reused when (categoryId, lower(name)) already seen in this run.
 *   - StoreProduct reused when (chainId, lower(storeProductName), amount, unit)
 *     already seen in this run.
 *   - Price is inserted for every row (append-only time series).
 *
 * After the import completes, run `seedBaseProducts.ts --commit` to cluster
 * the freshly-loaded Products into baseProduct groups.
 */

import '../config/env.js';
// xlsx is CommonJS only — default import then destructure under ts-node/esm.
import xlsx from 'xlsx';
const { readFile, utils } = xlsx;
import path from 'node:path';
import url from 'node:url';
import pool from '../config/db.js';

const SPREADSHEET_PATH = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '../../receipts/barbora_products_v3.xlsx'
);

const CHUNK_SIZE = 500;

interface Row {
    categoryId?: any;
    name?: any;
    chainId?: any;
    storeProductName?: any;
    brandName?: any;
    isWeighable?: any;
    amount?: any;
    unit?: any;
    imageUrl?: any;
    storeId?: any;
    price?: any;
    promoPrice?: any;
    promoEnd?: any;
    isFallback?: any;
    date?: any;
    priceVerified?: any;
}

// ── coercion helpers (xlsx cell values land as number/string/boolean/Date) ──

const toIntOrNull = (v: any): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toFloatOrNull = (v: any): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const toStringOrNull = (v: any): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
};
const toBool = (v: any): boolean => {
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = String(v).toLowerCase().trim();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
};
const toDateOrNow = (v: any): Date => {
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    if (typeof v === 'string' && v.trim()) {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d;
    }
    return new Date();
};
const toDateOrNull = (v: any): Date | null => {
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    if (typeof v === 'string' && v.trim()) {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
};

async function main() {
    console.log(`Reading ${SPREADSHEET_PATH}`);
    // cellDates: true so date-formatted cells come through as JS Dates.
    const wb = readFile(SPREADSHEET_PATH, { cellDates: true });
    const firstSheet = wb.SheetNames[0];
    const rows: Row[] = utils.sheet_to_json(wb.Sheets[firstSheet], { defval: null });
    console.log(`Loaded ${rows.length} rows from sheet "${firstSheet}"`);

    const productCache = new Map<string, number>();
    const spCache = new Map<string, number>();

    let pricesInserted = 0;
    let pricesDuplicate = 0;
    let productsCreated = 0;
    let spCreated = 0;
    let skipped = 0;
    let skippedReasons: Record<string, number> = {};
    const bump = (why: string) => {
        skipped++;
        skippedReasons[why] = (skippedReasons[why] || 0) + 1;
    };

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        const conn = await (pool as any).getConnection();
        try {
            await conn.beginTransaction();
            for (const row of chunk) {
                const categoryId = toIntOrNull(row.categoryId);
                const name = toStringOrNull(row.name);
                const chainId = toIntOrNull(row.chainId);
                const spName = toStringOrNull(row.storeProductName);
                const storeId = toIntOrNull(row.storeId);
                const price = toFloatOrNull(row.price);

                if (categoryId === null || !name) { bump('no-product-identity'); continue; }
                if (chainId === null || !spName) { bump('no-sp-identity'); continue; }
                if (storeId === null || price === null || price <= 0) { bump('no-price'); continue; }

                // ── Product ──────────────────────────────────────────────
                const productKey = `${categoryId}|${name.toLowerCase()}`;
                let productId = productCache.get(productKey);
                if (!productId) {
                    const [res]: any = await conn.query(
                        'INSERT INTO Product (categoryId, baseProductId, name) VALUES (?, NULL, ?)',
                        [categoryId, name]
                    );
                    productId = res.insertId as number;
                    productCache.set(productKey, productId);
                    productsCreated++;
                }

                // ── StoreProduct ─────────────────────────────────────────
                const amount = toFloatOrNull(row.amount);
                const unit = toStringOrNull(row.unit);
                const spKey = `${chainId}|${spName.toLowerCase()}|${amount ?? ''}|${unit ?? ''}`;
                let spId = spCache.get(spKey);
                if (!spId) {
                    const [res]: any = await conn.query(
                        `INSERT INTO StoreProduct
                           (productId, chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            productId,
                            chainId,
                            spName,
                            toStringOrNull(row.brandName),
                            toBool(row.isWeighable),
                            amount,
                            unit,
                            toStringOrNull(row.imageUrl),
                        ]
                    );
                    spId = res.insertId as number;
                    spCache.set(spKey, spId);
                    spCreated++;
                }

                // ── Price ────────────────────────────────────────────────
                // INSERT IGNORE because the Price table has a unique index on
                // (storeProductId, storeId, date). Spreadsheet rows that
                // resolve to the same SP (via dedup) + same store + same second
                // timestamp would otherwise fail. Duplicates are tallied and
                // reported in the final summary.
                const [res]: any = await conn.query(
                    `INSERT IGNORE INTO Price
                       (storeProductId, storeId, price, promoPrice, promoEnd,
                        isFallback, date, priceVerified, receiptId)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
                    [
                        spId,
                        storeId,
                        price,
                        toFloatOrNull(row.promoPrice),
                        toDateOrNull(row.promoEnd),
                        toBool(row.isFallback),
                        toDateOrNow(row.date),
                        toBool(row.priceVerified),
                    ]
                );
                if (res.affectedRows === 0) pricesDuplicate++;
                else pricesInserted++;
            }
            await conn.commit();
            console.log(
                `  chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(rows.length / CHUNK_SIZE)}: ` +
                    `products=${productsCreated}, SPs=${spCreated}, prices=${pricesInserted}, skipped=${skipped}`
            );
        } catch (e) {
            await conn.rollback();
            console.error(`Chunk starting at row ${i} failed; rolled back:`, e);
            throw e;
        } finally {
            conn.release();
        }
    }

    console.log('\n=== Summary ===');
    console.log(`Products created:       ${productsCreated}`);
    console.log(`StoreProducts created:  ${spCreated}`);
    console.log(`Prices inserted:        ${pricesInserted}`);
    console.log(`Prices skipped as dup:  ${pricesDuplicate}`);
    console.log(`Rows skipped:           ${skipped}`);
    if (skipped > 0) console.log('Skip reasons:', skippedReasons);

    await pool.end();
}

main().catch((e) => {
    console.error('\nImport failed:', e);
    process.exit(1);
});
