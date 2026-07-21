import pool from '../../config/db.js';
import { getCachedChainCandidates, getCachedCrossChainCandidates } from '../../models/storeProductModel.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../../utils/productMatcher.js';
import { stemQuery } from '../../utils/searchStem.js';

const NEPRISKIRTA_ID = 688;

// Products must only ever sit in LEAF categories — a category with children is an
// L1/L2 grouping node. A borrowed category that is non-leaf (the matched product
// itself is misplaced — 7.7k catalog rows are) must NOT be propagated to a mint.
let nonLeafIds: Set<number> | null = null;
async function isLeafCategory(categoryId: number): Promise<boolean> {
    if (!nonLeafIds) {
        const [rows]: any = await pool.query(
            'SELECT DISTINCT parentCategoryId AS id FROM Category WHERE parentCategoryId IS NOT NULL');
        nonLeafIds = new Set((rows as any[]).map(r => Number(r.id)));
    }
    return !nonLeafIds.has(categoryId);
}
// Bands (confirmed with real data — see lidlRecatExperiment):
export const JOIN_MIN = 0.8;   // link the SP to this existing Product
export const MINT_MIN = 0.75;  // mint a NEW Product in the matched Product's category, flag for review

export interface ScrapedMatch {
    /** Existing SP to reuse (same-chain match) — reuse it, just add the price. */
    spId: number | null;
    /** Existing Product to JOIN (create the SP under it). */
    productId: number | null;
    /** Category for a fresh mint: a BORROWED category (weak match) or 688. */
    categoryId: number;
    /** True when minted into a borrowed category → queue for admin confirm. */
    reviewPending: boolean;
    /** Diagnostics. */
    via: 'chain_sp' | 'join' | 'mint_borrowed' | 'mint_consensus' | 'uncategorised';
    matchedName?: string;
    score?: number;
}

// Normalized candidate names, memoised on the candidate-array identity (the cached
// getters return a stable ref within their TTL → normalised once per scrape run).
const normedMemo = new WeakMap<any[], Array<{ c: MatchCandidate & { categoryId?: number; categoryName?: string }; hay: string }>>();
function normed(cands: any[]) {
    let n = normedMemo.get(cands);
    if (!n) {
        n = cands.map(c => ({ c, hay: normalizeProductName(c.storeProductName) }));
        normedMemo.set(cands, n);
    }
    return n;
}
function prefilter(cands: any[], name: string): any[] {
    // Normalize stems the same way the haystack is normalized — stemQuery keeps
    // trailing dots ("tarkuot.") which normalizeProductName strips from the hay,
    // so raw stems silently zero the pool for abbreviated names.
    const stems = stemQuery(name).map(s => normalizeProductName(s)).filter(s => s.length >= 4);
    if (!stems.length) return [];
    const out: any[] = [];
    for (const n of normed(cands)) if (stems.some(st => n.hay.includes(st))) out.push(n.c);
    if (out.length) return out;
    // Empty pool → typo tolerance: retry on 4-char stem PREFIXES (a chain's own
    // flyer typo — "Šilaguogės" — must still see "Šilauogės" as a candidate).
    // This only WIDENS the candidate pool; the scoring lanes still gate joins.
    const prefixes = [...new Set(stems.map(s => s.slice(0, 4)))];
    for (const n of normed(cands)) if (prefixes.some(p => n.hay.includes(p))) out.push(n.c);
    return out;
}

/**
 * Resolve a scraped product name to an existing SP / Product, or a mint target,
 * using the ADVANCED matcher (token lanes + LT stem + size/form gates), typed
 * mode (clean catalog input). Order: same-chain SP → cross-chain Product (JOIN
 * ≥0.80, else MINT-in-borrowed-category ≥0.75) → uncategorised. Brand is already
 * folded into `name` by the scraper, so it rides in as a discriminator.
 */
export async function matchScrapedProduct(
    chainId: number,
    name: string,
    amount: number | null,
    unit: string | null,
    isWeighable: boolean,
): Promise<ScrapedMatch> {
    // 1. Same-chain SP — reuse the existing listing.
    const chainPool = prefilter(await getCachedChainCandidates(chainId), name);
    if (chainPool.length) {
        const m = findBestProductMatches(name, amount, unit, chainPool, JOIN_MIN, 1, isWeighable, { typed: true })[0];
        if (m) return { spId: Number(m.storeProductId), productId: null, categoryId: 0, reviewPending: false,
            via: 'chain_sp', matchedName: m.name, score: m.confidence };
    }

    // 2. Cross-chain CATEGORISED candidate. ONE matcher pass at the WEAK floor
    //    serves join/borrow (top hit) AND category consensus (top-3).
    const crossCands = (await getCachedCrossChainCandidates(chainId))
        .filter((c: any) => c.categoryId && Number(c.categoryId) !== NEPRISKIRTA_ID);
    const crossPool = prefilter(crossCands, name);
    if (crossPool.length) {
        const CONSENSUS_FLOOR = 0.45;
        const ms = findBestProductMatches(name, amount, unit, crossPool, CONSENSUS_FLOOR, 5, isWeighable, { typed: true });
        const m = ms[0];
        const candOf = (x: any) => crossPool.find((c: any) => Number(c.id) === Number(x.storeProductId));
        if (m && m.confidence >= JOIN_MIN) {
            return { spId: null, productId: Number(m.productId), categoryId: 0, reviewPending: false,
                via: 'join', matchedName: m.name, score: m.confidence };
        }
        if (m && m.confidence >= MINT_MIN) {
            // 0.75–0.80 → mint a separate Product in the matched product's category.
            // Leaf-guard: only borrow LEAF categories — if the matched product sits
            // in an L1/L2 grouping node, don't propagate the misplacement.
            let catId = Number(candOf(m)?.categoryId ?? m.categoryId ?? NEPRISKIRTA_ID);
            if (catId !== NEPRISKIRTA_ID && !(await isLeafCategory(catId))) catId = NEPRISKIRTA_ID;
            return { spId: null, productId: null, categoryId: catId, reviewPending: catId !== NEPRISKIRTA_ID,
                via: 'mint_borrowed', matchedName: m.name, score: m.confidence };
        }
        // Category CONSENSUS (recat T4a, measured ~95%): best hit too weak to
        // join, but ≥3 weak hits whose TOP-3 all sit in one LEAF category →
        // mint there (unflagged — triple agreement beats a single 0.75 hit).
        if (ms.length >= 3) {
            const topCat = Number(candOf(ms[0])?.categoryId ?? 0);
            if (topCat && topCat !== NEPRISKIRTA_ID
                && ms.slice(0, 3).every(x => Number(candOf(x)?.categoryId ?? 0) === topCat)
                && await isLeafCategory(topCat)) {
                return { spId: null, productId: null, categoryId: topCat, reviewPending: false,
                    via: 'mint_consensus', matchedName: ms[0].name, score: ms[0].confidence };
            }
        }
    }

    // 3. Nothing solid → uncategorised.
    return { spId: null, productId: null, categoryId: NEPRISKIRTA_ID, reviewPending: false, via: 'uncategorised' };
}
