/**
 * One-shot migration: cluster existing Products by name similarity within the
 * same category and set `baseProductId` on non-canonical variants so they
 * point at the canonical (shortest-name) Product in their cluster.
 *
 * Run:
 *   # Dry-run — prints clusters, rolls back, no DB changes.
 *   npx node --loader ts-node/esm src/scripts/seedBaseProducts.ts
 *
 *   # Commit the changes:
 *   npx node --loader ts-node/esm src/scripts/seedBaseProducts.ts --commit
 *
 *   # Tune the similarity threshold (default 0.75):
 *   npx node --loader ts-node/esm src/scripts/seedBaseProducts.ts --threshold=0.80
 *
 * Clustering scope: same `categoryId`. Cross-category clustering is rejected
 * — different categories almost always mean different Products even with
 * similar names (e.g. "Alyvuogių aliejus" in oils vs "Alyvuogės" in
 * preserves).
 *
 * Invariants checked before commit:
 *   - No Product has `baseProductId = id` (no self-loop).
 *   - No Product chains through another variant (every `baseProductId`
 *     points at a Product whose own `baseProductId IS NULL`).
 */

import '../config/env.js';
import pool from '../config/db.js';
import { nameSimilarity } from '../utils/productNameNormalize.js';

interface ProductRow {
  id: number;
  categoryId: number;
  name: string;
  baseProductId: number | null;
}

const DEFAULT_THRESHOLD = 0.85;
const NEPRISKIRTA_ID = 688;

function parseArgs() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const thresholdArg = args.find((a) => a.startsWith('--threshold='));
  const threshold = thresholdArg
    ? Number(thresholdArg.split('=')[1])
    : DEFAULT_THRESHOLD;
  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `Invalid threshold '${thresholdArg}'. Use --threshold=0.XX (0–1).`,
    );
  }
  return { commit, threshold };
}

async function main() {
  const { commit, threshold } = parseArgs();

  console.log(
    `seedBaseProducts | threshold=${threshold} | mode=${commit ? 'COMMIT' : 'DRY-RUN'}`,
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query<any>(
      'SELECT id, categoryId, name, baseProductId FROM Product ORDER BY categoryId, id',
    );
    const products = rows as ProductRow[];
    console.log(`Loaded ${products.length} Products`);

    // Reset baseProductId on all Products before reclustering. Makes the
    // script idempotent: a previously-clustered variant can now be promoted
    // to canonical (or reassigned to a different cluster) without leaving
    // a stale link that would violate the "no chains deeper than 1"
    // invariant.
    const [resetRes]: any = await conn.query(
      'UPDATE Product SET baseProductId = NULL WHERE baseProductId IS NOT NULL',
    );
    console.log(`Cleared baseProductId on ${resetRes.affectedRows} Products`);

    const byCategory = new Map<number, ProductRow[]>();
    for (const p of products) {
      const list = byCategory.get(p.categoryId);
      if (list) list.push(p);
      else byCategory.set(p.categoryId, [p]);
    }

    let clusterCount = 0;
    let variantCount = 0;

    for (const [categoryId, group] of byCategory) {
      // Skip the Nepriskirta orphan bucket: its members don't share a
      // coherent category, so clustering them by name similarity produces
      // meaningless BaseProducts ("Kibiras 10l" paired with "Knyga X").
      // These will be recategorized via the swipe-refinement flow, and
      // can be reclustered at that point.
      if (categoryId === NEPRISKIRTA_ID) continue;
      if (group.length < 2) continue; // singletons remain roots (baseProductId=NULL)

      const assigned = new Set<number>();
      const clusters: ProductRow[][] = [];

      for (const p of group) {
        if (assigned.has(p.id)) continue;
        const cluster = [p];
        assigned.add(p.id);
        for (const q of group) {
          if (assigned.has(q.id)) continue;
          if (nameSimilarity(p.name, q.name) >= threshold) {
            cluster.push(q);
            assigned.add(q.id);
          }
        }
        if (cluster.length > 1) clusters.push(cluster);
      }

      if (clusters.length === 0) continue;

      for (const cluster of clusters) {
        // Canonical = shortest name (break ties by smallest id for determinism).
        const canonical = cluster.reduce((a, b) => {
          if (a.name.length !== b.name.length) {
            return a.name.length < b.name.length ? a : b;
          }
          return a.id < b.id ? a : b;
        });
        const variants = cluster.filter((p) => p.id !== canonical.id);
        clusterCount++;

        console.log(
          `\n[cat ${categoryId}] canonical #${canonical.id}: "${canonical.name}"`,
        );
        for (const v of variants) {
          console.log(`    ← #${v.id}: "${v.name}"`);
          variantCount++;
          await conn.query(
            'UPDATE Product SET baseProductId = ? WHERE id = ?',
            [canonical.id, v.id],
          );
        }
      }
    }

    console.log(
      `\nSummary: ${clusterCount} clusters formed, ${variantCount} variants linked`,
    );

    // Invariant: no self-loops.
    const [[selfRow]]: any = await conn.query(
      'SELECT COUNT(*) AS c FROM Product WHERE baseProductId = id',
    );
    if (selfRow.c > 0) {
      throw new Error(`Invariant violated: ${selfRow.c} Products self-reference`);
    }

    // Invariant: variants point only at roots (no chains deeper than 1).
    const [[chainRow]]: any = await conn.query(`
      SELECT COUNT(*) AS c
      FROM Product child
      JOIN Product parent ON parent.id = child.baseProductId
      WHERE parent.baseProductId IS NOT NULL
    `);
    if (chainRow.c > 0) {
      throw new Error(
        `Invariant violated: ${chainRow.c} Products chain through another variant`,
      );
    }

    if (commit) {
      await conn.commit();
      console.log('\nCOMMITTED.');
    } else {
      await conn.rollback();
      console.log('\nROLLED BACK (dry-run). Re-run with --commit to apply.');
    }
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('\nMigration failed:', e);
  process.exit(1);
});
