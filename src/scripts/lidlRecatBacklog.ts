/**
 * Re-categorise the EXISTING uncategorised Lidl backlog with the advanced matcher.
 * DRY-RUN by default (writes a CSV, no writes). `--apply` performs the mutations.
 *
 *   npx tsx src/scripts/lidlRecatBacklog.ts            # dry-run → CSV
 *   npx tsx src/scripts/lidlRecatBacklog.ts --apply    # mutate (needs both migrations)
 *
 * Per uncategorised Lidl SP, match its name against the CATEGORISED catalog:
 *   JOIN  ≥0.80 → re-point the SP to the matched Product (leaves its lone
 *                 uncategorised Product orphaned for a later empty-Product sweep).
 *   MINT  ≥0.75 → move the SP's own uncategorised Product into the BORROWED
 *                 category + set categoryReviewPending = 1 (admin confirms).
 *   else        → leave uncategorised.
 */
import 'dotenv/config';
import fs from 'fs';
import pool from '../config/db.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../utils/productMatcher.js';
import { stemQuery } from '../utils/searchStem.js';
import { JOIN_MIN, MINT_MIN } from '../scrapers/shared/scraperProductMatch.js';

const APPLY = process.argv.includes('--apply');
const OUT = '/home/mantas/Documents/Projects/lidl_recat_backlog.csv';

// Human-reviewed rows (2026-07): the matcher's join was vetoed (different product)
// but the CATEGORY is human-certain, or the matcher undershoots a human-obvious
// category. These MINT a separate Product directly in the given LEAF category —
// no review flag (this map IS the review).
const MANUAL_MINT = new Map<string, number>([
    ['Švieži kopūstai', 5],                          // Bulvės, morkos ir kopūstai
    ['Šviežia kiaulienos sprandinė', 99],            // Kiauliena
    ['Šviežia kiaulienos nugarinė be kaulo', 99],    // Kiauliena
    ['Pienas 2% rieb. PET', 24],                     // Pasterizuotas pienas
    ['Apelsinų sulčių gėrimas', 329],                // Nektarai ir sulčių gėrimai
    ['Bulv. trašk.su drusk', 173],                   // Bulvių traškučiai
    ['ROKIŠKIO Pusriebė „Naminė“ varškė, 9 %', 63],  // Varškė (join target was OCR junk)
    ['ALESTO Džiovintos slyvos', 222],               // Džiovinti vaisiai ir uogos
    ['Geriamas jogurtas', 39],                       // Geriamieji jogurtai
    ['W5 Valymo šepetėlis', 542],                    // Šluostės, kempinėlės ir šepečiai
    ['Virtas kiaulienos kumpis riek.', 137],         // Virtos dešros ir kumpiai (borrow was L1)
    ['Braškių dėže', 17],                            // Vynuogės ir uogos (0.59 undershoot)
    ['Lenkiški obuoliai', 16],                       // Bananai, obuoliai ir kriaušės (0.35)
    ['Kiaušinių makaronų virtinukai', 134],          // Greitai paruošiami virtiniai ir kepsneliai
]);
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
    const [lidl]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.amount, sp.unit, sp.isWeighable
           FROM StoreProduct sp JOIN Product p ON p.id = sp.productId
          WHERE sp.chainId = 5 AND p.categoryId = 688`);
    const [cat]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.amount, sp.unit, sp.isWeighable,
                p.categoryId, c.name AS categoryName
           FROM StoreProduct sp JOIN Product p ON p.id = sp.productId JOIN Category c ON c.id = p.categoryId
          WHERE p.categoryId <> 688 AND p.mergedIntoId IS NULL`);
    console.log(`backlog: ${lidl.length} uncategorised Lidl SPs | ${cat.length} catalog candidates | mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

    // Cast to the matcher's candidate shape — the weighable gate compares STRICTLY
    // (cand.isWeighable !== ocrIsWeighable), so raw SQL 0/1 vs boolean false silently
    // hard-gates every fixed-pack SP. Mirror the !!cast the cached getters do.
    const candidates = (cat as any[]).map(c => ({
        ...c,
        isWeighable: !!c.isWeighable,
        amount: c.amount != null ? Number(c.amount) : null,
    }));
    const normed = candidates.map(c => ({ c, hay: normalizeProductName(c.storeProductName) }));
    // Leaf-guard: a MINT must never place a Product in an L1/L2 grouping node.
    const [nl]: any = await pool.query(
        'SELECT DISTINCT parentCategoryId AS id FROM Category WHERE parentCategoryId IS NOT NULL');
    const nonLeaf = new Set((nl as any[]).map(r => Number(r.id)));
    const [catNames]: any = await pool.query('SELECT id, name FROM Category');
    const catName = new Map((catNames as any[]).map(r => [Number(r.id), String(r.name)]));
    const rows: string[] = [['lidl_sp', 'action', 'target', 'category', 'score'].join(',')];
    const counts = { join: 0, mint: 0, manual: 0, uncat: 0 };

    for (const l of lidl as any[]) {
        const name = String(l.storeProductName);
        const manualCat = MANUAL_MINT.get(name);
        if (manualCat != null) {
            if (nonLeaf.has(manualCat)) throw new Error(`MANUAL_MINT ${manualCat} for "${name}" is non-leaf`);
            counts.manual++;
            rows.push([name, 'MINT-MANUAL', '', catName.get(manualCat) ?? String(manualCat), ''].map(cell).join(','));
            if (APPLY) await pool.query('UPDATE Product SET categoryId = ? WHERE id = ?', [manualCat, l.productId]);
            continue;
        }
        const stems = stemQuery(name).map(s => normalizeProductName(s)).filter(s => s.length >= 4);
        let top: any = null, cand: any = null;
        if (stems.length) {
            const pool2 = normed.filter(n => stems.some(st => n.hay.includes(st))).map(n => n.c) as (MatchCandidate & { categoryId: number; categoryName: string })[];
            if (pool2.length) {
                top = findBestProductMatches(name, l.amount != null ? Number(l.amount) : null, l.unit ?? null,
                    pool2, MINT_MIN, 1, l.isWeighable ? true : false, { typed: true })[0] ?? null;
                if (top) cand = pool2.find((c: any) => Number(c.id) === Number(top.storeProductId));
            }
        }
        const score = top ? top.confidence : 0;
        if (score >= JOIN_MIN) {
            counts.join++;
            rows.push([name, 'JOIN', top.name, cand?.categoryName ?? '', score.toFixed(3)].map(cell).join(','));
            if (APPLY) await pool.query('UPDATE StoreProduct SET productId = ? WHERE id = ?', [Number(top.productId), l.id]);
        } else if (score >= MINT_MIN && cand?.categoryId && !nonLeaf.has(Number(cand.categoryId))) {
            counts.mint++;
            rows.push([name, 'MINT', top.name, cand.categoryName, score.toFixed(3)].map(cell).join(','));
            if (APPLY) await pool.query(
                'UPDATE Product SET categoryId = ?, categoryReviewPending = 1 WHERE id = ?',
                [Number(cand.categoryId), l.productId]);
        } else {
            counts.uncat++;
            rows.push([name, 'UNCAT', '', '', score.toFixed(3)].map(cell).join(','));
        }
    }
    fs.writeFileSync(OUT, rows.join('\n'), 'utf8');
    console.log(`JOIN: ${counts.join} | MINT(borrowed+review): ${counts.mint} | MINT-MANUAL: ${counts.manual} | UNCAT: ${counts.uncat}`);
    console.log(`${APPLY ? 'APPLIED. ' : 'DRY-RUN. '}→ ${OUT}`);
    await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
