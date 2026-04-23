/**
 * Seed OrphanSwipeCandidate with tier-1 candidates: for every Nepriskirta
 * (categoryId=688) Product that has at least one StoreProduct, pick the
 * top-K categorized Products (same shape, different chain) by trigram-
 * blocked Levenshtein similarity and persist as candidate rows.
 *
 * Usage:
 *   npx node --loader ts-node/esm src/scripts/seedOrphanSwipeCandidates.ts
 *
 * Re-runnable: uses ON DUPLICATE KEY UPDATE on (orphanProductId,
 * candidateProductId) so running again refreshes ranks/scores in place.
 *
 * This module also exports `refillForOrphan(productId)` which the extra-
 * queue endpoint calls when a specific orphan's unresolved top-K runs out;
 * that path runs the same similarity pass for a single orphan.
 */

import '../config/env.js';
import pool from '../config/db.js';
import { upsertCandidates } from '../models/orphanSwipeCandidateModel.js';

const TOP_K = 5;
const SIMILARITY_FLOOR = 0.4;
const NEPRISKIRTA_ID = 688;
const TIER_ORPHAN = 1;
const TOP_K_LEVENSHTEIN_POOL = 50;

// ── name normalization + similarity (same shape as import scripts) ──

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

// ── in-memory snapshots ─────────────────────────────────────────────

interface ProductEntry {
    id: number;
    categoryId: number;
    normName: string;
}

interface SpEntry {
    spId: number;
    productId: number;
    chainId: number;
    latestPriceAt: number; // ms epoch; 0 if no price rows
}

interface Snapshot {
    productById: Map<number, ProductEntry>;
    trigramIndex: Map<string, Set<number>>;
    spsByProduct: Map<number, SpEntry[]>; // sorted DESC by latestPriceAt
    chainsByProduct: Map<number, Set<number>>;
}

async function loadSnapshot(): Promise<Snapshot> {
    // Products — exclude merged ones (they're no longer valid targets).
    const [products]: any = await pool.query(
        `SELECT id, categoryId, name
           FROM Product
          WHERE mergedIntoId IS NULL`
    );
    const productById = new Map<number, ProductEntry>();
    const trigramIndex = new Map<string, Set<number>>();
    for (const r of products as any[]) {
        const norm = normalizeName(String(r.name ?? ''));
        if (!norm) continue;
        const entry: ProductEntry = {
            id: Number(r.id),
            categoryId: Number(r.categoryId),
            normName: norm,
        };
        productById.set(entry.id, entry);
        for (const tg of trigramSet(norm)) {
            let s = trigramIndex.get(tg);
            if (!s) { s = new Set(); trigramIndex.set(tg, s); }
            s.add(entry.id);
        }
    }

    // StoreProducts with the latest price timestamp per SP.
    const [sps]: any = await pool.query(
        `SELECT sp.id        AS spId,
                sp.productId AS productId,
                sp.chainId   AS chainId,
                MAX(p.date)  AS latestPriceAt
           FROM StoreProduct sp
      LEFT JOIN Price       p  ON p.storeProductId = sp.id
          GROUP BY sp.id`
    );
    const spsByProduct = new Map<number, SpEntry[]>();
    const chainsByProduct = new Map<number, Set<number>>();
    for (const r of sps as any[]) {
        const productId = Number(r.productId);
        const entry: SpEntry = {
            spId: Number(r.spId),
            productId,
            chainId: Number(r.chainId),
            latestPriceAt: r.latestPriceAt ? new Date(r.latestPriceAt).getTime() : 0,
        };
        if (!spsByProduct.has(productId)) spsByProduct.set(productId, []);
        spsByProduct.get(productId)!.push(entry);

        if (!chainsByProduct.has(productId)) chainsByProduct.set(productId, new Set());
        chainsByProduct.get(productId)!.add(entry.chainId);
    }
    // Sort each Product's SPs by latestPriceAt DESC so [0] is the freshest.
    for (const arr of spsByProduct.values()) {
        arr.sort((a, b) => b.latestPriceAt - a.latestPriceAt);
    }
    return { productById, trigramIndex, spsByProduct, chainsByProduct };
}

/**
 * Compute top-K cross-chain candidates for a single orphan.
 * Returns upsert-ready rows (omits `tier` — caller sets it).
 */
function computeCandidatesFor(
    orphanId: number,
    snap: Snapshot
): Array<{
    orphanProductId: number;
    candidateProductId: number;
    orphanSpId: number;
    candidateSpId: number;
    similarityScore: number;
    rankPos: number;
}> {
    const orphan = snap.productById.get(orphanId);
    if (!orphan) return [];

    const orphanSps = snap.spsByProduct.get(orphanId);
    if (!orphanSps || orphanSps.length === 0) return [];
    const orphanChains = snap.chainsByProduct.get(orphanId) ?? new Set<number>();
    const orphanSpId = orphanSps[0].spId; // freshest

    // Trigram block: count shared trigrams per candidate productId.
    const orphanTris = trigramSet(orphan.normName);
    const counts = new Map<number, number>();
    for (const tg of orphanTris) {
        const bucket = snap.trigramIndex.get(tg);
        if (!bucket) continue;
        for (const pid of bucket) {
            if (pid === orphanId) continue;
            counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
    }
    if (counts.size === 0) return [];

    // Cheap pre-filter: take the top-N by trigram overlap, then Levenshtein
    // only those. Prevents pathological O(n) Levenshtein blow-up.
    const pool = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_K_LEVENSHTEIN_POOL);

    const scored: Array<{
        candidateProductId: number;
        candidateSpId: number;
        similarityScore: number;
    }> = [];
    for (const [pid] of pool) {
        const cand = snap.productById.get(pid);
        if (!cand) continue;
        if (cand.categoryId === NEPRISKIRTA_ID) continue; // orphan → orphan, no gain
        const candSps = snap.spsByProduct.get(pid);
        if (!candSps || candSps.length === 0) continue;
        // Candidate must have at least one SP in a chain the orphan doesn't own.
        const candSp = candSps.find(sp => !orphanChains.has(sp.chainId));
        if (!candSp) continue;

        const score = levenshteinRatio(orphan.normName, cand.normName);
        if (score < SIMILARITY_FLOOR) continue;

        scored.push({
            candidateProductId: pid,
            candidateSpId: candSp.spId,
            similarityScore: score,
        });
    }

    scored.sort((a, b) => b.similarityScore - a.similarityScore);
    const top = scored.slice(0, TOP_K);
    return top.map((s, i) => ({
        orphanProductId: orphanId,
        candidateProductId: s.candidateProductId,
        orphanSpId,
        candidateSpId: s.candidateSpId,
        similarityScore: Math.round(s.similarityScore * 1000) / 1000,
        rankPos: i + 1,
    }));
}

/**
 * Exported: compute and persist a fresh top-K for a single orphan.
 * Called from the extra-queue endpoint on the refill path.
 */
export async function refillForOrphan(orphanProductId: number): Promise<number> {
    const snap = await loadSnapshot();
    const rows = computeCandidatesFor(orphanProductId, snap);
    if (rows.length === 0) return 0;
    return upsertCandidates(rows.map(r => ({ ...r, tier: TIER_ORPHAN })));
}

/**
 * Exported: batch refill for a list of orphans using one snapshot load.
 * Use this when more than ~3 orphans need refilling; snapshot load is the
 * expensive step and loading it once amortizes across the group.
 */
export async function refillForOrphans(orphanIds: number[]): Promise<number> {
    if (orphanIds.length === 0) return 0;
    const snap = await loadSnapshot();
    const all = orphanIds.flatMap(id =>
        computeCandidatesFor(id, snap).map(r => ({ ...r, tier: TIER_ORPHAN }))
    );
    if (all.length === 0) return 0;
    return upsertCandidates(all);
}

// ── entry point (batch seed everything) ─────────────────────────────

async function main() {
    console.log('Loading snapshot...');
    const snap = await loadSnapshot();
    console.log(
        `  ${snap.productById.size} Products, ` +
        `${snap.trigramIndex.size} trigrams, ` +
        `${snap.spsByProduct.size} Products have SPs`
    );

    // Pick tier-1 orphans: categoryId=688, mergedIntoId IS NULL, has ≥1 SP.
    const [orphanRows]: any = await pool.query(
        `SELECT DISTINCT p.id
           FROM Product p
           JOIN StoreProduct sp ON sp.productId = p.id
          WHERE p.categoryId = ? AND p.mergedIntoId IS NULL`,
        [NEPRISKIRTA_ID]
    );
    const orphanIds = (orphanRows as any[]).map(r => Number(r.id));
    console.log(`Seeding candidates for ${orphanIds.length} tier-1 orphans...`);

    const BATCH = 2000;
    let totalRows = 0;
    let orphansWithHits = 0;
    let orphansEmpty = 0;

    for (let i = 0; i < orphanIds.length; i += BATCH) {
        const chunk = orphanIds.slice(i, i + BATCH);
        const rows = chunk.flatMap(id => {
            const out = computeCandidatesFor(id, snap);
            if (out.length === 0) orphansEmpty++;
            else orphansWithHits++;
            return out.map(r => ({ ...r, tier: TIER_ORPHAN }));
        });
        if (rows.length > 0) {
            const inserted = await upsertCandidates(rows);
            totalRows += inserted;
        }
        console.log(
            `  chunk ${Math.floor(i / BATCH) + 1}/${Math.ceil(orphanIds.length / BATCH)}: ` +
            `orphansWithHits=${orphansWithHits}, emptyHits=${orphansEmpty}, rowsUpserted=${totalRows}`
        );
    }

    console.log('\n=== Summary ===');
    console.log(`Orphans processed:     ${orphanIds.length}`);
    console.log(`Orphans with ≥1 hit:   ${orphansWithHits}`);
    console.log(`Orphans with 0 hits:   ${orphansEmpty}`);
    console.log(`Candidate rows upsert: ${totalRows}`);

    await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((e) => {
        console.error('\nSeed failed:', e);
        process.exit(1);
    });
}
