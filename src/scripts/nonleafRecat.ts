/**
 * Re-home the ~7.7k products sitting in NON-LEAF categories (legacy import).
 * DRY-RUN by default (CSV only). `--apply` mutates. Idempotent & env-agnostic
 * (name-keyed, recomputes per environment) — same script runs dev/staging/prod.
 *
 *   npx tsx src/scripts/nonleafRecat.ts [--apply] [--limit N]
 *
 * Tiers (per non-leaf product, best across its SPs, vs the LEAF catalog):
 *   T1 SP-DEDUP   same-chain token-set-IDENTICAL name → physical SP merge
 *                 (same listing twice; histories interleave), then soft-merge
 *                 the emptied product into the twin's product.
 *   T2 SOFT-MERGE score ≥0.80 → promoteMergeByProductIds (reversible, SPs keep
 *                 own price history, equivalence reverification fires). If the
 *                 surviving winner sits non-leaf, it adopts the target's leaf cat.
 *   T3 MOVE      0.75–0.80 → keep product, move to matched LEAF cat, review flag.
 *   T4a CONSENSUS best <0.75 but ≥3 weak hits (≥0.45) whose TOP-3 all share one
 *                 leaf category → inherit it (measured ~95% precision, no flag).
 *   T4b LEAF-VOTE vote a DESCENDANT leaf of the CURRENT parent by category-name
 *                 stems (head-noun gate), no flag (measured ~100% precision).
 *   T5 UNCAT     rest → 688.
 * T2/T3 iterate until fixpoint (moved products enlarge the leaf candidate pool).
 */
import 'dotenv/config';
import fs from 'fs';
import pool from '../config/db.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../utils/productMatcher.js';
import { stemQuery } from '../utils/searchStem.js';
import { JOIN_MIN, MINT_MIN } from '../scrapers/shared/scraperProductMatch.js';
import { dedupStoreProduct } from '../services/storeProductDedupService.js';
import { promoteMergeByProductIds } from '../services/storeProductMergeService.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : null;
const NEPRISKIRTA = 688;
const OUT = '/home/mantas/Documents/Projects/nonleaf_recat.csv';
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const tokenKey = (name: string, chainId: number) =>
    `${chainId}|${normalizeProductName(name).split(/\s+/).filter(Boolean).sort().join(' ')}`;
// Brand-ish tokens = fully-UPPERCASE words (≥4 chars) in the RAW name. When BOTH
// sides carry them and the sets are disjoint, the products are different brands —
// a 0.8+ name match must then NOT merge identities (BAUER≠BONDUELLE), only move category.
const brandTokens = (raw: string): Set<string> => new Set(
    (raw.match(/[A-ZĄČĘĖĮŠŲŪŽ'&.-]{4,}/g) ?? [])
        .map(t => t.replace(/[^A-ZĄČĘĖĮŠŲŪŽ]/g, ''))
        .filter(t => t.length >= 4));
const brandsDisjoint = (a: string, b: string): boolean => {
    const ba = brandTokens(a), bb = brandTokens(b);
    if (!ba.size || !bb.size) return false;
    return ![...ba].some(t => bb.has(t));
};
const stemWord = (w: string) =>
    w.replace(/(iams|omis|ėmis|iais|uose|ose|ams|ais|ius|iai|ios|ies|iui|io|ia|is|ys|as|us|os|es|ės|ai|ą|ę|į|ų|ū|ė|a|e|i|o|u|y)$/, '');

async function loadCategories() {
    const [cats]: any = await pool.query('SELECT id, parentCategoryId, name FROM Category');
    const children = new Map<number, any[]>();
    for (const c of cats as any[]) {
        if (c.parentCategoryId == null) continue;
        const arr = children.get(Number(c.parentCategoryId)) ?? [];
        arr.push(c); children.set(Number(c.parentCategoryId), arr);
    }
    const nonLeaf = new Set([...children.keys()]);
    const descendantLeaves = (id: number): any[] => {
        const out: any[] = []; const stack = [...(children.get(id) ?? [])];
        while (stack.length) {
            const c = stack.pop()!;
            const ch = children.get(Number(c.id)) ?? [];
            if (ch.length) stack.push(...ch); else out.push(c);
        }
        return out;
    };
    return { nonLeaf, descendantLeaves };
}

async function fetchNonLeafProducts(nonLeaf: Set<number>) {
    const [prods]: any = await pool.query(
        `SELECT p.id AS productId, p.name AS productName, p.categoryId, c.name AS catName
           FROM Product p JOIN Category c ON c.id = p.categoryId
          WHERE p.mergedIntoId IS NULL AND p.categoryId <> ${NEPRISKIRTA}`);
    const filtered = (prods as any[]).filter(p => nonLeaf.has(Number(p.categoryId)));
    return LIMIT ? filtered.slice(0, LIMIT) : filtered;
}

async function fetchLeafCandidates(nonLeaf: Set<number>) {
    const [cat]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.chainId, sp.storeProductName, sp.amount, sp.unit, sp.isWeighable,
                p.categoryId, c.name AS categoryName
           FROM StoreProduct sp JOIN Product p ON p.id = sp.productId JOIN Category c ON c.id = p.categoryId
          WHERE p.categoryId <> ${NEPRISKIRTA} AND p.mergedIntoId IS NULL`);
    return (cat as any[])
        .filter(c => !nonLeaf.has(Number(c.categoryId)))
        .map(c => ({ ...c, isWeighable: !!c.isWeighable, amount: c.amount != null ? Number(c.amount) : null }));
}

async function main() {
    const { nonLeaf, descendantLeaves } = await loadCategories();
    let products = await fetchNonLeafProducts(nonLeaf);
    console.log(`non-leaf products: ${products.length} | mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${LIMIT ? ` | limit=${LIMIT}` : ''}`);

    const rows: string[] = [['product', 'current_cat', 'action', 'target', 'target_cat', 'score'].join(',')];
    const counts: Record<string, number> = { T1_SPDEDUP: 0, T2_MERGE: 0, T3_MOVE: 0, T4A_CONSENSUS: 0, T4B_VOTE: 0, T5_UNCAT: 0 };
    // Weak top-5 hits per still-undecided product (fed to T4a after the loop).
    const weakHits = new Map<number, Array<{ name: string; confidence: number; categoryId: number; categoryName: string }>>();
    const decided = new Set<number>();
    const record = (p: any, action: string, target: string, targetCat: string, score: number | null) => {
        counts[action]++; decided.add(Number(p.productId));
        rows.push([p.productName, p.catName, action, target, targetCat, score != null ? score.toFixed(3) : ''].map(cell).join(','));
    };

    // ── T2/T3 fixpoint loop (T1 folded into round 1) ─────────────────────────
    for (let round = 1; round <= 3; round++) {
        const remaining = products.filter(p => !decided.has(Number(p.productId)));
        if (!remaining.length) break;
        const ids = remaining.map(p => Number(p.productId));
        const [spRows]: any = await pool.query(
            `SELECT id, productId, chainId, storeProductName, amount, unit, isWeighable
               FROM StoreProduct WHERE productId IN (?)`, [ids]);
        const spsByProduct = new Map<number, any[]>();
        for (const r of spRows as any[]) {
            const arr = spsByProduct.get(Number(r.productId)) ?? [];
            arr.push(r); spsByProduct.set(Number(r.productId), arr);
        }
        const leafCands = await fetchLeafCandidates(nonLeaf);
        const normed = leafCands.map(c => ({ c, hay: normalizeProductName(c.storeProductName) }));
        const twinIndex = new Map<string, any[]>();
        for (const c of leafCands) {
            const k = tokenKey(String(c.storeProductName), Number(c.chainId));
            const arr = twinIndex.get(k) ?? []; arr.push(c); twinIndex.set(k, arr);
        }
        console.log(`round ${round}: ${remaining.length} remaining | leaf candidates ${leafCands.length}`);

        let changed = 0, done = 0;
        for (const pr of remaining) {
            const sps = spsByProduct.get(Number(pr.productId)) ?? [];
            if (++done % 500 === 0) console.log(`  round ${round}: ${done}/${remaining.length}…`);

            // T1: exact same-chain twin (round 1 only — set doesn't grow later).
            if (round === 1) {
                const twinSp = sps.map(sp => ({ sp, twins: twinIndex.get(tokenKey(String(sp.storeProductName), Number(sp.chainId))) ?? [] }))
                    .find(x => x.twins.length);
                if (twinSp) {
                    const twin = twinSp.twins[0];
                    record(pr, 'T1_SPDEDUP', twin.storeProductName, twin.categoryName, 1);
                    if (APPLY) {
                        await dedupStoreProduct(Number(twin.id), Number(twinSp.sp.id));
                        const [left]: any = await pool.query('SELECT COUNT(*) n FROM StoreProduct WHERE productId = ?', [pr.productId]);
                        if (Number(left[0].n) === 0) {
                            const dec = await promoteMergeByProductIds(Number(pr.productId), Number(twin.productId));
                            // Winner is name-length-picked: if the surviving root kept a
                            // NON-LEAF category, adopt the twin's leaf category.
                            if (dec.action === 'promoted' && dec.winnerProductId != null) {
                                const [w]: any = await pool.query('SELECT categoryId FROM Product WHERE id = ?', [dec.winnerProductId]);
                                if (w[0] && nonLeaf.has(Number(w[0].categoryId))) {
                                    await pool.query('UPDATE Product SET categoryId = ? WHERE id = ?',
                                        [Number(twin.categoryId), dec.winnerProductId]);
                                }
                            }
                        }
                    }
                    changed++;
                    continue;
                }
            }

            // T2/T3: advanced matcher vs leaf catalog, best across this product's SPs.
            // ONE matcher pass at the WEAK floor serves T2/T3 (top hit) and T4a
            // (top-5 category consensus) without a second sweep.
            let best: any = null, bestCand: any = null, bestQueryName = '';
            let bestHits: any[] = [];
            for (const sp of sps.slice(0, 3)) {
                const name = String(sp.storeProductName);
                const stems = stemQuery(name).map(s => normalizeProductName(s)).filter(s => s.length >= 4);
                if (!stems.length) continue;
                const pool2 = normed.filter(n => Number(n.c.productId) !== Number(pr.productId) && stems.some(st => n.hay.includes(st))).map(n => n.c);
                if (!pool2.length) continue;
                const ms = findBestProductMatches(name, sp.amount != null ? Number(sp.amount) : null, sp.unit ?? null,
                    pool2 as unknown as MatchCandidate[], 0.45, 5, !!sp.isWeighable, { typed: true });
                const m = ms[0];
                if (m && (!best || m.confidence > best.confidence)) {
                    best = m; bestQueryName = name;
                    bestCand = pool2.find((c: any) => Number(c.id) === Number(m.storeProductId));
                    bestHits = ms.map(x => {
                        const c = pool2.find((cc: any) => Number(cc.id) === Number(x.storeProductId));
                        return { name: x.name, confidence: x.confidence, categoryId: Number(c?.categoryId ?? 0), categoryName: String(c?.categoryName ?? '') };
                    });
                }
            }
            if (bestHits.length) weakHits.set(Number(pr.productId), bestHits);
            if (best && best.confidence < MINT_MIN) { best = null; bestCand = null; }
            // Brand gate: disjoint brand tokens demote a would-be merge to a category move.
            if (best && bestCand && best.confidence >= JOIN_MIN
                && brandsDisjoint(bestQueryName, String(bestCand.storeProductName))) {
                best = { ...best, confidence: Math.min(best.confidence, JOIN_MIN - 0.001) };
            }
            if (best && bestCand && best.confidence >= JOIN_MIN) {
                record(pr, 'T2_MERGE', best.name, bestCand.categoryName, best.confidence);
                if (APPLY) {
                    const dec = await promoteMergeByProductIds(Number(pr.productId), Number(bestCand.productId));
                    // Winner is picked by name length (category-blind): if the surviving
                    // root sits in a NON-LEAF cat, it adopts the target's leaf category.
                    if (dec.action === 'promoted' && dec.winnerProductId != null) {
                        const [w]: any = await pool.query('SELECT categoryId FROM Product WHERE id = ?', [dec.winnerProductId]);
                        if (w[0] && nonLeaf.has(Number(w[0].categoryId))) {
                            await pool.query('UPDATE Product SET categoryId = ? WHERE id = ?',
                                [Number(bestCand.categoryId), dec.winnerProductId]);
                        }
                    }
                }
                changed++;
            } else if (best && bestCand && best.confidence >= MINT_MIN && !nonLeaf.has(Number(bestCand.categoryId))) {
                record(pr, 'T3_MOVE', best.name, bestCand.categoryName, best.confidence);
                if (APPLY) await pool.query(
                    'UPDATE Product SET categoryId = ?, categoryReviewPending = 1 WHERE id = ?',
                    [Number(bestCand.categoryId), pr.productId]);
                changed++;
            }
        }
        console.log(`round ${round}: ${changed} decided`);
        if (!changed) break;
        if (!APPLY) break; // pool only grows when moves are actually applied
    }

    // ── T4a: category CONSENSUS from weak hits (top-3 unanimous) ─────────────
    for (const pr of products) {
        if (decided.has(Number(pr.productId))) continue;
        const hits = weakHits.get(Number(pr.productId)) ?? [];
        if (hits.length < 3) continue;
        const topCat = hits[0].categoryId;
        if (!topCat || nonLeaf.has(topCat)) continue;
        if (!hits.slice(0, 3).every(h => h.categoryId === topCat)) continue;
        record(pr, 'T4A_CONSENSUS', hits.map(h => `${h.name}=${h.confidence.toFixed(2)}`).join(' | '), hits[0].categoryName, hits[0].confidence);
        if (APPLY) await pool.query('UPDATE Product SET categoryId = ? WHERE id = ?', [topCat, pr.productId]);
    }

    // ── T4b: leaf-name vote inside the CURRENT parent's subtree ──────────────
    const [catNameRows]: any = await pool.query('SELECT id, name FROM Category');
    const catNameById = new Map((catNameRows as any[]).map(r => [Number(r.id), String(r.name)]));
    for (const pr of products) {
        if (decided.has(Number(pr.productId))) continue;
        const leaves = descendantLeaves(Number(pr.categoryId));
        const prodStems = normalizeProductName(String(pr.productName)).split(/\s+/).map(stemWord).filter(s => s.length >= 4);
        const scored = leaves.map(l => {
            const leafName = String(l.name);
            const conjuncts = leafName.split(/\s+ir\s+|,\s*/i);
            const headStems = conjuncts.map(c => {
                const ws = normalizeProductName(c).split(/\s+/).filter(Boolean);
                return stemWord(ws[ws.length - 1] ?? '');
            }).filter(s => s.length >= 3); // 3: short heads like "pica"→"pic" must survive
            const leafStems = normalizeProductName(leafName).split(/\s+/).map(stemWord).filter(s => s.length >= 4);
            const matched = leafStems.filter(ls => prodStems.some(ps => ps.startsWith(ls) || ls.startsWith(ps)));
            const headHit = headStems.some(hs => prodStems.some(ps => ps.startsWith(hs) || hs.startsWith(ps)));
            return { l, n: matched.length, headHit };
        }).filter(s => s.n > 0 && s.headHit).sort((a, b) => b.n - a.n);
        if (scored.length && (scored.length === 1 || scored[0].n > scored[1].n)) {
            const leaf = scored[0].l;
            record(pr, 'T4B_VOTE', '', String(leaf.name), null);
            // No review flag: T4 spot-checked at ~100% precision; only T3 flags.
            if (APPLY) await pool.query(
                'UPDATE Product SET categoryId = ? WHERE id = ?',
                [Number(leaf.id), pr.productId]);
        } else {
            // T5: dump to uncategorised.
            record(pr, 'T5_UNCAT', '', catNameById.get(NEPRISKIRTA) ?? 'Nepriskirta', null);
            if (APPLY) await pool.query('UPDATE Product SET categoryId = ? WHERE id = ?', [NEPRISKIRTA, pr.productId]);
        }
    }

    fs.writeFileSync(OUT, rows.join('\n'), 'utf8');
    const total = products.length || 1;
    console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v} (${Math.round(v / total * 100)}%)`).join(' | '));
    console.log(`${APPLY ? 'APPLIED.' : 'DRY-RUN.'} → ${OUT}`);
    await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
