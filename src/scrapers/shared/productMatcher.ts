// In-memory trigram + Levenshtein matching for Products and StoreProducts.
// Ported from importRimi.ts — shared across all scrapers.
// Indexes are loaded once per scraper run and updated as new rows are created.

import pool from '../../config/db.js';
import { unitFamily } from '../../services/canonicalUnit.js';
import { sharesRequiredAnchor } from '../../utils/nameMatchGate.js';

export interface ProductEntry { id: number; categoryId: number; normName: string; }
export interface SpEntry     { id: number; productId: number; normName: string; amount: number | null; unit: string | null; }

export interface ProductIndex { byId: Map<number, ProductEntry>; trigrams: Map<string, Set<number>>; }
export interface SpIndex      { byId: Map<number, SpEntry>;      trigrams: Map<string, Set<number>>; }

export function normalizeName(s: string): string {
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
    if (!a.length || !b.length) return 0;
    const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const temp = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j - 1], dp[j]);
            prev = temp;
        }
    }
    return 1 - dp[b.length] / Math.max(a.length, b.length);
}

function addToIndex<T extends { id: number; normName: string }>(
    index: { byId: Map<number, T>; trigrams: Map<string, Set<number>> },
    entry: T,
) {
    index.byId.set(entry.id, entry);
    for (const tg of trigramSet(entry.normName)) {
        let s = index.trigrams.get(tg);
        if (!s) { s = new Set(); index.trigrams.set(tg, s); }
        s.add(entry.id);
    }
}

function findTopKResults<T extends { id: number; normName: string }>(
    normTarget: string,
    index: { byId: Map<number, T>; trigrams: Map<string, Set<number>> },
    threshold: number,
    maxResults: number,
): { entry: T; score: number }[] {
    const tset = trigramSet(normTarget);
    const counts = new Map<number, number>();
    for (const tg of tset) {
        const bucket = index.trigrams.get(tg);
        if (!bucket) continue;
        for (const id of bucket) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (!counts.size) return [];
    const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxResults * 3);
    const scored: { entry: T; score: number }[] = [];
    for (const [id] of candidates) {
        const entry = index.byId.get(id)!;
        const score = levenshteinRatio(normTarget, entry.normName);
        if (score >= threshold) scored.push({ entry, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function findBest<T extends { id: number; normName: string }>(
    normTarget: string,
    index: { byId: Map<number, T>; trigrams: Map<string, Set<number>> },
    threshold: number,
    topK = 20,
): { entry: T; score: number } | null {
    const tset = trigramSet(normTarget);
    const counts = new Map<number, number>();
    for (const tg of tset) {
        const bucket = index.trigrams.get(tg);
        if (!bucket) continue;
        for (const id of bucket) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (!counts.size) return null;

    const topKIds = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    let bestEntry: T | null = null;
    let bestScore = 0;
    for (const [id] of topKIds) {
        const entry = index.byId.get(id)!;
        const score = levenshteinRatio(normTarget, entry.normName);
        if (score > bestScore) { bestScore = score; bestEntry = entry; }
    }
    return bestEntry && bestScore >= threshold ? { entry: bestEntry, score: bestScore } : null;
}

// ── Product index ────────────────────────────────────────────────────────────

let _productIndex: ProductIndex | null = null;

export async function getProductIndex(): Promise<ProductIndex> {
    if (_productIndex) return _productIndex;
    const [rows]: any = await pool.query(
        'SELECT id, categoryId, name FROM Product WHERE mergedIntoId IS NULL',
    );
    const index: ProductIndex = { byId: new Map(), trigrams: new Map() };
    for (const r of rows as any[]) {
        const normName = normalizeName(String(r.name ?? ''));
        if (normName) addToIndex(index, { id: r.id, categoryId: r.categoryId, normName });
    }
    _productIndex = index;
    return index;
}

export function addProductToIndex(entry: ProductEntry) {
    if (_productIndex) addToIndex(_productIndex, entry);
}

/** Returns productId if similarity >= threshold (0.85 cross-chain). */
export async function fuzzyMatchProduct(
    name: string,
    threshold = 0.85,
): Promise<ProductEntry | null> {
    const index = await getProductIndex();
    const norm = normalizeName(name);
    const result = findBest(norm, index, threshold);
    if (!result) return null;
    // Anchor-token gate: never cluster a single-significant-word name into a
    // Product unless they share that exact word. Catalog names are clean (no
    // OCR), so no char-similarity escape is needed here. Stops short-name,
    // similar-ending mis-clusters like "Airanas" ↔ "Šafranas KOTANYI".
    if (!sharesRequiredAnchor(norm, result.entry.normName)) return null;
    return result.entry;
}

// ── StoreProduct index (per-chain) ───────────────────────────────────────────

const _spIndexes = new Map<number, SpIndex>();

export async function getSpIndex(chainId: number): Promise<SpIndex> {
    if (_spIndexes.has(chainId)) return _spIndexes.get(chainId)!;
    const [rows]: any = await pool.query(
        'SELECT id, productId, storeProductName, amount, unit FROM StoreProduct WHERE chainId = ?',
        [chainId],
    );
    const index: SpIndex = { byId: new Map(), trigrams: new Map() };
    for (const r of rows as any[]) {
        const normName = normalizeName(String(r.storeProductName ?? ''));
        if (normName) addToIndex(index, {
            id: r.id,
            productId: r.productId,
            normName,
            amount: r.amount !== null ? parseFloat(r.amount) : null,
            unit: r.unit ?? null,
        });
    }
    _spIndexes.set(chainId, index);
    return index;
}

export function addSpToIndex(chainId: number, entry: SpEntry) {
    const index = _spIndexes.get(chainId);
    if (index) addToIndex(index, entry);
}

/**
 * Family-compatibility gate. Returns true if two units can safely belong
 * to the same Product:
 *   - either side unknown → allow (don't block when info is missing)
 *   - same family (fluid vs count) → allow
 *   - different known families → block (refuse the merge)
 *
 * The transitional fluid-family simplification (kg ≈ l) means a milk SP in
 * 'l' and a yogurt SP in 'kg' are still considered compatible. The block
 * only kicks in for genuinely incompatible cases like a 1 vnt bag joining
 * an otherwise all-kg cluster — exactly the data-pollution path the
 * canonical-unit system was designed to prevent at calc time. Catching it
 * at match time stops the bad merge from happening in the first place;
 * the new SP then gets its own Product, and admin can resolve via the
 * amounts queue ("Kiekis").
 */
function unitFamiliesCompatible(a: string | null, b: string | null): boolean {
    const fa = unitFamily(a);
    const fb = unitFamily(b);
    if (fa === null || fb === null) return true;
    return fa === fb;
}

/**
 * Fuzzy match within chain. Threshold 0.80 (looser than cross-chain because
 * same-chain names are more similar). If amount+unit also match we lower the
 * name threshold further to 0.65 to catch "Žemaitijos pienas" vs full catalog name.
 *
 * After fuzzy-name matching, the match is rejected if the incoming SP's
 * unit family doesn't match the matched SP's family — see
 * unitFamiliesCompatible() for the rule.
 */
export async function fuzzyMatchSp(
    chainId: number,
    name: string,
    amount: number | null,
    unit: string | null,
    threshold = 0.80,
): Promise<SpEntry | null> {
    const index = await getSpIndex(chainId);
    const norm = normalizeName(name);

    // Try standard threshold first.
    const result = findBest(norm, index, threshold);
    if (result && unitFamiliesCompatible(result.entry.unit, unit)) {
        return result.entry;
    }

    // Lower threshold when amount+unit match exactly (e.g. promo short names).
    if (amount !== null && unit !== null) {
        const loose = findBest(norm, index, 0.65);
        if (loose) {
            const e = loose.entry;
            if (e.unit === unit && e.amount !== null && Math.abs(e.amount - amount) < 0.01) {
                // exact unit+amount match already implies same family
                return e;
            }
        }
    }
    return null;
}

/**
 * Returns up to maxK SP matches within the chain sorted by score descending.
 * Used for "N rūšių" aggregated products where one promo price covers N variants.
 *
 * Family gate: only keeps matches whose unit family is compatible with the
 * incoming unit (see unitFamiliesCompatible).
 */
export async function fuzzyMatchSpMulti(
    chainId: number,
    name: string,
    amount: number | null,
    unit: string | null,
    maxK: number,
    threshold = 0.80,
): Promise<SpEntry[]> {
    const index = await getSpIndex(chainId);
    const norm = normalizeName(name);
    const results = findTopKResults(norm, index, threshold, maxK);
    if (results.length) {
        return results
            .map(r => r.entry)
            .filter(e => unitFamiliesCompatible(e.unit, unit));
    }

    if (amount !== null && unit !== null) {
        const loose = findTopKResults(norm, index, 0.65, maxK);
        return loose
            .filter(r => r.entry.unit === unit && r.entry.amount !== null && Math.abs(r.entry.amount - amount) < 0.01)
            .map(r => r.entry);
    }
    return [];
}
