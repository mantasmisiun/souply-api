/**
 * EXPERIMENT (read-only): match every uncategorised Lidl SP against the whole
 * categorised catalog with the advanced matcher, and bucket by confidence:
 *   ≥ STRONG → would JOIN that Product (link, no new Product)
 *   ≥ WEAK   → would MINT a new Product in the matched Product's CATEGORY
 *   else     → stays uncategorised
 * Writes a CSV for review: lidl name | matched catalog name | category | score | bucket.
 *
 *   npx tsx src/scripts/lidlRecatExperiment.ts
 */
import 'dotenv/config';
import fs from 'fs';
import pool from '../config/db.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../utils/productMatcher.js';
import { stemQuery } from '../utils/searchStem.js';

const STRONG = 0.8;   // join
const WEAK = 0.6;     // mint-with-category
const CAPTURE = 0.4;  // matcher floor (bucket at analysis time)
const OUT = '/home/mantas/Documents/Projects/lidl_recat.csv';
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
    const [lidlRows]: any = await pool.query(
        `SELECT sp.id, sp.storeProductName, sp.amount, sp.unit, sp.isWeighable
           FROM StoreProduct sp JOIN Product p ON p.id = sp.productId
          WHERE sp.chainId = 5 AND p.categoryId = 688`);
    const [catRows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.amount, sp.unit, sp.isWeighable, c.name AS categoryName
           FROM StoreProduct sp JOIN Product p ON p.id = sp.productId JOIN Category c ON c.id = p.categoryId
          WHERE p.categoryId <> 688 AND p.mergedIntoId IS NULL`);
    console.log(`uncategorised Lidl: ${lidlRows.length} | catalog candidates: ${catRows.length}`);

    // Normalise candidate names once for the stem prefilter.
    const normed = (catRows as any[]).map(c => ({
        c: { id: Number(c.id), productId: Number(c.productId), storeProductName: c.storeProductName,
             amount: c.amount, unit: c.unit, isWeighable: !!c.isWeighable, aliases: [],
             categoryName: c.categoryName } as unknown as MatchCandidate & { categoryName: string },
        hay: normalizeProductName(c.storeProductName),
    }));

    const rows: string[] = [['lidl_sp', 'matched_catalog_sp', 'category', 'score', 'bucket'].join(',')];
    const counts = { join: 0, mint: 0, uncat: 0 };
    for (const l of lidlRows as any[]) {
        const name = String(l.storeProductName);
        const stems = stemQuery(name).filter(s => s.length >= 4);
        let top: any = null, topCand: any = null;
        if (stems.length) {
            const pool2 = normed.filter(n => stems.some(st => n.hay.includes(st))).map(n => n.c);
            if (pool2.length) {
                const matches = findBestProductMatches(name, l.amount != null ? Number(l.amount) : null,
                    l.unit ?? null, pool2, CAPTURE, 1, l.isWeighable ? true : l.isWeighable === 0 ? false : null, { typed: true });
                top = matches[0] ?? null;
                if (top) topCand = pool2.find((c: any) => c.id === top.storeProductId);
            }
        }
        const score = top ? top.confidence : 0;
        const bucket = score >= STRONG ? 'JOIN' : score >= WEAK ? 'MINT' : 'UNCAT';
        counts[bucket === 'JOIN' ? 'join' : bucket === 'MINT' ? 'mint' : 'uncat']++;
        rows.push([name, topCand?.storeProductName ?? '', topCand?.categoryName ?? '', score.toFixed(3), bucket].map(cell).join(','));
    }
    fs.writeFileSync(OUT, rows.join('\n'), 'utf8');
    console.log(`\nJOIN (≥${STRONG}): ${counts.join} | MINT-with-cat (≥${WEAK}): ${counts.mint} | UNCAT (<${WEAK}): ${counts.uncat}`);
    console.log(`→ ${OUT}`);
    await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
