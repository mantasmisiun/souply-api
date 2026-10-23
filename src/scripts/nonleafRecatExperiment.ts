/**
 * EXPERIMENT (read-only): what happens if the 7.7k products sitting in NON-LEAF
 * categories are pushed through the advanced matcher against the LEAF catalog?
 *
 *   npx tsx src/scripts/nonleafRecatExperiment.ts [sampleSize=800]
 *
 * Per non-leaf product: query with EACH of its SP names (best wins) against SPs
 * of leaf-categorised products (excluding itself). Buckets:
 *   JOIN  ≥0.80 → would MERGE into the matched product (productMergeService, directed)
 *   MOVE  0.75–0.80 → keep product, move to the matched LEAF category + review flag
 *   UNCAT rest → dump to 688 (per decision) — matcher found nothing solid
 * Writes /home/mantas/Documents/Projects/nonleaf_recat_sample.csv
 */
import 'dotenv/config';
import fs from 'fs';
import pool from '../config/db.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../utils/productMatcher.js';
import { stemQuery } from '../utils/searchStem.js';
import { JOIN_MIN, MINT_MIN } from '../scrapers/shared/scraperProductMatch.js';

const SAMPLE = Number(process.argv[2] ?? 800);
const OUT = '/home/mantas/Documents/Projects/nonleaf_recat_sample.csv';
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
    // Non-leaf products, deterministic sample (RAND(42)), with their SPs.
    const [nlProducts]: any = await pool.query(
        `SELECT p.id AS productId, p.name AS productName, c.id AS catId, c.name AS catName
           FROM Product p JOIN Category c ON c.id = p.categoryId
          WHERE p.mergedIntoId IS NULL AND c.id <> 688
            AND EXISTS (SELECT 1 FROM Category ch WHERE ch.parentCategoryId = c.id)
          ORDER BY RAND(42) LIMIT ?`, [SAMPLE]);
    const ids = (nlProducts as any[]).map(r => Number(r.productId));
    const [spRows]: any = await pool.query(
        `SELECT productId, storeProductName, amount, unit, isWeighable, chainId
           FROM StoreProduct WHERE productId IN (?)`, [ids]);
    const spsByProduct = new Map<number, any[]>();
    for (const r of spRows as any[]) {
        const arr = spsByProduct.get(Number(r.productId)) ?? [];
        arr.push(r); spsByProduct.set(Number(r.productId), arr);
    }

    // Candidates: SPs of LEAF-categorised products only.
    const [cat]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.amount, sp.unit, sp.isWeighable,
                p.categoryId, c.name AS categoryName
           FROM StoreProduct sp JOIN Product p ON p.id = sp.productId JOIN Category c ON c.id = p.categoryId
          WHERE p.categoryId <> 688 AND p.mergedIntoId IS NULL
            AND NOT EXISTS (SELECT 1 FROM Category ch WHERE ch.parentCategoryId = p.categoryId)`);
    const candidates = (cat as any[]).map(c => ({
        ...c, isWeighable: !!c.isWeighable, amount: c.amount != null ? Number(c.amount) : null,
    }));
    const normed = candidates.map(c => ({ c, hay: normalizeProductName(c.storeProductName) }));
    console.log(`sample: ${nlProducts.length} non-leaf products | leaf candidates: ${candidates.length} SPs`);

    const rows: string[] = [['product', 'current_cat', 'action', 'target', 'target_cat', 'score'].join(',')];
    const counts = { join: 0, move: 0, uncat: 0 };
    let done = 0;
    for (const pr of nlProducts as any[]) {
        const sps = spsByProduct.get(Number(pr.productId)) ?? [{ storeProductName: pr.productName, amount: null, unit: null, isWeighable: 0 }];
        let best: any = null, bestCand: any = null;
        for (const sp of sps.slice(0, 3)) {
            const name = String(sp.storeProductName);
            const stems = stemQuery(name).map(s => normalizeProductName(s)).filter(s => s.length >= 4);
            if (!stems.length) continue;
            const pool2 = normed.filter(n => Number(n.c.productId) !== Number(pr.productId) && stems.some(st => n.hay.includes(st))).map(n => n.c);
            if (!pool2.length) continue;
            const m = findBestProductMatches(name, sp.amount != null ? Number(sp.amount) : null, sp.unit ?? null,
                pool2 as unknown as MatchCandidate[], MINT_MIN, 1, !!sp.isWeighable, { typed: true })[0];
            if (m && (!best || m.confidence > best.confidence)) {
                best = m;
                bestCand = pool2.find((c: any) => Number(c.id) === Number(m.storeProductId));
            }
        }
        const score = best ? best.confidence : 0;
        const action = score >= JOIN_MIN ? 'JOIN' : score >= MINT_MIN ? 'MOVE' : 'UNCAT';
        counts[action.toLowerCase() as 'join' | 'move' | 'uncat']++;
        rows.push([pr.productName, pr.catName, action, best?.name ?? '', bestCand?.categoryName ?? '', score ? score.toFixed(3) : ''].map(cell).join(','));
        if (++done % 100 === 0) console.log(`  ${done}/${nlProducts.length}…`);
    }
    fs.writeFileSync(OUT, rows.join('\n'), 'utf8');
    const pct = (n: number) => `${n} (${Math.round(n / (nlProducts as any[]).length * 100)}%)`;
    console.log(`JOIN(merge): ${pct(counts.join)} | MOVE(cat+review): ${pct(counts.move)} | UNCAT(688): ${pct(counts.uncat)}`);
    console.log(`→ ${OUT}`);
    await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
