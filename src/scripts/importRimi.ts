/**
 * One-shot import of scraped Rimi data into Product + StoreProduct + Price.
 *
 * Usage:
 *   npx node --loader ts-node/esm src/scripts/importRimi.ts
 *
 * Expects the spreadsheet at `receipts/rimi_products_v2.xlsx`. Rimi's sheet
 * layout differs from Barbora's: no explicit categoryId, instead breadcrumb
 * columns `_l1`, `_l2`, `_l3` that we resolve via categoryModel. Columns
 * prefixed with `_` are scraper metadata and are ignored except for the L
 * breadcrumb.
 *
 * Category strategy, in order:
 *   1. resolveCategoryByPath([_l1, _l2, _l3]) → deepest matching Category id
 *   2. Nepriskirta (id = 688) fallback when the path resolves to nothing
 *
 * Product strategy (cross-chain reuse):
 *   1. Trigram-blocked candidate lookup against all existing Products
 *   2. Levenshtein ratio on top-K candidates; score >= 0.85 → reuse Product
 *      (Rimi StoreProduct inherits that Product's categoryId)
 *   3. Miss → create new Product under the resolved category (or 688)
 *
 * Price strategy:
 *   - Insert at Rimi's canonical store (id=241) as isFallback=1
 *   - After main loop, fan out to every other Rimi store (chainId=2)
 *
 * After this completes, run `seedBaseProducts.ts --commit` to (re)cluster.
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
    '../../receipts/rimi_products_v2.xlsx'
);

const CHUNK_SIZE = 500;
const SIMILARITY_THRESHOLD = 0.85;
const NEPRISKIRTA_ID = 688;
const RIMI_CHAIN_ID = 2;
const RIMI_SOURCE_STORE_ID = 241;
const TOP_K_CANDIDATES = 20;

interface Row {
    baseProductId?: any;
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
    receiptId?: any;
    _l1?: any;
    _l2?: any;
    _l3?: any;
    _productUrl?: any;
    _productCode?: any;
    _originalName?: any;
    _gtmBrand?: any;
}

// ── coercion helpers ────────────────────────────────────────────────

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

// ── name normalization + similarity ─────────────────────────────────

function normalizeName(s: string): string {
    if (!s) return '';
    return s
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function trigramSet(s: string): Set<string> {
    const padded = '  ' + s + '  ';
    const out = new Set<string>();
    for (let i = 0; i <= padded.length - 3; i++) out.add(padded.slice(i, i + 3));
    return out;
}

function levenshteinRatio(a: string, b: string): number {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    if (la === 0 || lb === 0) return 0;
    const dp: number[] = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) dp[j] = j;
    for (let i = 1; i <= la; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= lb; j++) {
            const temp = dp[j];
            dp[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
                ? prev
                : 1 + Math.min(prev, dp[j - 1], dp[j]);
            prev = temp;
        }
    }
    return 1 - dp[lb] / Math.max(la, lb);
}

interface ProductIndexEntry {
    id: number;
    categoryId: number;
    normName: string;
}

interface ProductIndex {
    byId: Map<number, ProductIndexEntry>;
    trigramIndex: Map<string, Set<number>>;
}

async function loadProductIndex(): Promise<ProductIndex> {
    const [rows]: any = await pool.query(
        `SELECT id, categoryId, name FROM Product WHERE mergedIntoId IS NULL`
    );
    const byId = new Map<number, ProductIndexEntry>();
    const trigramIndex = new Map<string, Set<number>>();
    for (const r of rows as any[]) {
        const norm = normalizeName(String(r.name ?? ''));
        if (!norm) continue;
        byId.set(r.id, { id: r.id, categoryId: r.categoryId, normName: norm });
        for (const tg of trigramSet(norm)) {
            let s = trigramIndex.get(tg);
            if (!s) { s = new Set(); trigramIndex.set(tg, s); }
            s.add(r.id);
        }
    }
    return { byId, trigramIndex };
}

function indexAdd(index: ProductIndex, entry: ProductIndexEntry): void {
    index.byId.set(entry.id, entry);
    for (const tg of trigramSet(entry.normName)) {
        let s = index.trigramIndex.get(tg);
        if (!s) { s = new Set(); index.trigramIndex.set(tg, s); }
        s.add(entry.id);
    }
}

function findBestMatch(
    targetName: string,
    index: ProductIndex
): { productId: number, score: number } | null {
    const norm = normalizeName(targetName);
    if (!norm) return null;
    const tset = trigramSet(norm);

    const counts = new Map<number, number>();
    for (const tg of tset) {
        const bucket = index.trigramIndex.get(tg);
        if (!bucket) continue;
        for (const pid of bucket) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    if (counts.size === 0) return null;

    const topK = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_K_CANDIDATES);

    let bestId = -1, bestScore = 0;
    for (const [pid] of topK) {
        const entry = index.byId.get(pid)!;
        const score = levenshteinRatio(norm, entry.normName);
        if (score > bestScore) { bestScore = score; bestId = pid; }
    }
    return bestId === -1 ? null : { productId: bestId, score: bestScore };
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
    console.log(`Reading ${SPREADSHEET_PATH}`);
    const wb = readFile(SPREADSHEET_PATH, { cellDates: true });
    const firstSheet = wb.SheetNames[0];
    const rows: Row[] = utils.sheet_to_json(wb.Sheets[firstSheet], { defval: null });
    console.log(`Loaded ${rows.length} rows from sheet "${firstSheet}"`);

    console.log('Building similarity index over existing Products...');
    const index = await loadProductIndex();
    console.log(`  indexed ${index.byId.size} Products, ${index.trigramIndex.size} trigrams`);

    const productCache = new Map<string, number>();     // name (lower) → productId
    const spCache      = new Map<string, number>();     // chain|spName|amt|unit → spId
    const pathCache    = new Map<string, number | null>(); // l1|l2|l3 → categoryId | null

    let pricesInserted = 0, pricesDuplicate = 0;
    let productsCreated = 0, productsReused = 0;
    let categoryResolved = 0, categoryFallback = 0;
    let spCreated = 0, skipped = 0;
    const skippedReasons: Record<string, number> = {};
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
                const name    = toStringOrNull(row.name);
                const chainId = toIntOrNull(row.chainId);
                const spName  = toStringOrNull(row.storeProductName);
                const storeId = toIntOrNull(row.storeId);
                const price   = toFloatOrNull(row.price);

                if (!name) { bump('no-product-name'); continue; }
                if (chainId === null || !spName) { bump('no-sp-identity'); continue; }
                if (storeId === null || price === null || price <= 0) { bump('no-price'); continue; }

                // ── Resolve category via breadcrumb ──────────────────
                const rawSegs = [row._l1, row._l2, row._l3]
                    .map(toStringOrNull)
                    .filter((s): s is string => !!s);
                // dedupe consecutive equal segments (scraper sometimes repeats)
                const segs: string[] = [];
                for (const s of rawSegs) {
                    if (segs.length === 0 || segs[segs.length - 1].toLowerCase() !== s.toLowerCase()) {
                        segs.push(s);
                    }
                }
                const pathKey = segs.map(s => s.toLowerCase()).join('|');
                let resolvedCategoryId: number | null = null;
                if (segs.length > 0) {
                    if (pathCache.has(pathKey)) {
                        resolvedCategoryId = pathCache.get(pathKey)!;
                    } else {
                        resolvedCategoryId = await resolveCategoryByPath(segs);
                        pathCache.set(pathKey, resolvedCategoryId);
                    }
                }

                // ── Product: similarity-reuse or create ──────────────
                const productKey = name.toLowerCase();
                let productId = productCache.get(productKey);
                if (!productId) {
                    const match = findBestMatch(name, index);
                    if (match && match.score >= SIMILARITY_THRESHOLD) {
                        productId = match.productId;
                        productsReused++;
                    } else {
                        const categoryId = resolvedCategoryId ?? NEPRISKIRTA_ID;
                        const [res]: any = await conn.query(
                            'INSERT INTO Product (categoryId, baseProductId, name) VALUES (?, NULL, ?)',
                            [categoryId, name]
                        );
                        productId = res.insertId as number;
                        productsCreated++;
                        if (resolvedCategoryId !== null) categoryResolved++;
                        else categoryFallback++;
                        // Register in the similarity index so later rows can reuse
                        indexAdd(index, {
                            id: productId,
                            categoryId,
                            normName: normalizeName(name),
                        });
                    }
                    productCache.set(productKey, productId);
                }

                // ── StoreProduct ─────────────────────────────────────
                const amount = toFloatOrNull(row.amount);
                const unit   = toStringOrNull(row.unit);
                const spKey  = `${chainId}|${spName.toLowerCase()}|${amount ?? ''}|${unit ?? ''}`;
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

                // ── Price ────────────────────────────────────────────
                // All scraped prices land as isFallback=1. Physical
                // receipts (isFallback=0) outrank scraped rows.
                const [res]: any = await conn.query(
                    `INSERT IGNORE INTO Price
                       (storeProductId, storeId, price, promoPrice, promoEnd,
                        isFallback, date, priceVerified, receiptId)
                     VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
                    [
                        spId,
                        storeId,
                        price,
                        toFloatOrNull(row.promoPrice),
                        toDateOrNull(row.promoEnd),
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
                    `newProducts=${productsCreated}, reused=${productsReused}, SPs=${spCreated}, prices=${pricesInserted}, skipped=${skipped}`
            );
        } catch (e) {
            await conn.rollback();
            console.error(`Chunk starting at row ${i} failed; rolled back:`, e);
            throw e;
        } finally {
            conn.release();
        }
    }

    // ── Fanout scraped prices to every other Rimi store ────────────
    console.log('\nFanning out scraped prices to other Rimi stores...');
    const [fanoutRes]: any = await pool.query(
        `INSERT IGNORE INTO Price
           (storeProductId, storeId, price, promoPrice, promoEnd,
            isFallback, date, priceVerified, receiptId)
         SELECT p.storeProductId, s.id, p.price, p.promoPrice, p.promoEnd,
                1, p.date, p.priceVerified, NULL
         FROM Price p
         JOIN Store s ON s.chainId = ? AND s.id <> p.storeId
         WHERE p.storeId = ? AND p.receiptId IS NULL`,
        [RIMI_CHAIN_ID, RIMI_SOURCE_STORE_ID]
    );

    console.log('\n=== Summary ===');
    console.log(`Products created:            ${productsCreated}`);
    console.log(`  via resolved category:     ${categoryResolved}`);
    console.log(`  via Nepriskirta (688):     ${categoryFallback}`);
    console.log(`Products reused (sim≥${SIMILARITY_THRESHOLD}):  ${productsReused}`);
    console.log(`StoreProducts created:       ${spCreated}`);
    console.log(`Prices inserted at src:      ${pricesInserted}`);
    console.log(`Prices skipped as dup:       ${pricesDuplicate}`);
    console.log(`Fanout rows inserted:        ${fanoutRes.affectedRows}`);
    console.log(`Rows skipped:                ${skipped}`);
    if (skipped > 0) console.log('Skip reasons:', skippedReasons);

    await pool.end();
}

main().catch((e) => {
    console.error('\nImport failed:', e);
    process.exit(1);
});
