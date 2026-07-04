import pool from '../config/db.js';
import { getReceiptRelatednessScope } from './receiptRelatednessService.js';
import { fetchVotedPairKeys } from '../models/votedPairsModel.js';
import { buildSlot2Queue, type RawSlot2Row, type Slot2QueueItem } from './slot2QueueBuilder.js';
import type { Locale } from '../middleware/locale.js';

/**
 * Slot 2c — RECEIPT-SCOPED ORPHAN BACKFILL for the mandatory swipe session.
 *
 * Fires ONLY when the receipt's own pool (Card-B + slot 2a/2b/1/3) leaves free
 * mandatory slots (< 3 cards). Instead of padding with unrelated global cards —
 * or serving nothing — it rescues GLOBAL orphans (Nepriskirta/688 Products the
 * scrapers minted without latching onto an existing Product) that are RELATED
 * to this receipt:
 *
 *   anchor set  = the receipt's category family (matched lines' leaf categories
 *                 + sibling leaves, via getReceiptRelatednessScope) + its chain;
 *   candidates  = one representative SP per CATEGORISED Product in that family;
 *   orphan pool = 688 Products with an SP, freshest first, receipt-chain first;
 *   scoring     = trigram-blocked Levenshtein name lane (floor SLOT2C_MIN_NAME)
 *                 + a price-corroboration bonus when the two sides' latest
 *                 prices agree — the "different algorithms, highest match wins"
 *                 composite. The TOP-k pairs become ordinary slot-2 cards.
 *
 * Reuses the whole existing slot-2 pipeline downstream: buildSlot2Queue dedup/
 * conflict/sort, the canonical `${min}-${max}` cardId (so the client's seen-set
 * dedups against a 2a/2b card of the same pair), the slot2 vote endpoint, and
 * the voted-pairs no-repeat ledger. Serves NOTHING when no pair clears the
 * floor — an honest short session beats junk cards.
 */

const SLOT2C_MIN_NAME = 0.55;          // name floor — global-unsupervised pairs need a real signal
const SLOT2C_TRIGRAM_BLOCK = 0.2;      // cheap jaccard pre-filter before Levenshtein
const SLOT2C_PRICE_BONUS = 0.15;       // both sides' latest prices agree → corroboration
const SLOT2C_ORPHAN_POOL = 250;        // freshest orphans considered
const SLOT2C_CANDIDATE_POOL = 250;     // categorised products in the receipt's category family

// ── name normalization + similarity (the seeder's shape: trigram block → Levenshtein) ──

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

function trigramJaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

function levenshteinRatio(a: string, b: string): number {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    if (la === 0 || lb === 0) return 0;
    const dp = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) dp[j] = j;
    for (let i = 1; i <= la; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= lb; j++) {
            const tmp = dp[j];
            dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return 1 - dp[lb] / Math.max(la, lb);
}

interface PoolRow {
    spId: number;
    productId: number;
    name: string;
    brandName: string | null;
    imageUrl: string | null;
    unit: string | null;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    categoryId: number;
    categoryName: string;
    latestPrice: number | null;
    norm: string;
    tris: Set<string>;
}

const rowFields = `
    sp.id                                   AS spId,
    p.id                                    AS productId,
    COALESCE(sp.storeProductName, p.name)   AS name,
    sp.brandName                            AS brandName,
    sp.imageUrl                             AS imageUrl,
    sp.unit                                 AS unit,
    sp.chainId                              AS chainId,
    sc.name                                 AS chainName,
    sc.logoUrl                              AS chainLogoUrl,
    p.categoryId                            AS categoryId,
    COALESCE(ct.name, c.name)               AS categoryName`;

const rowJoins = `
    JOIN StoreChain sc ON sc.id = sp.chainId
    JOIN Category   c  ON c.id = p.categoryId
    LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?`;

/** Latest price per SP for the POOLED ids only — a window over the whole Price
 *  table (~17M rows) is minutes; PARTITIONed over an IN-list of ≤500 ids is ms. */
async function fetchLatestPrices(spIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (spIds.length === 0) return out;
    const [rows]: any = await pool.query(
        `SELECT storeProductId, price FROM (
            SELECT storeProductId, price,
                   ROW_NUMBER() OVER (PARTITION BY storeProductId ORDER BY date DESC) AS rn
              FROM Price WHERE storeProductId IN (?)
        ) ranked WHERE rn = 1`,
        [spIds],
    );
    for (const r of rows as any[]) out.set(Number(r.storeProductId), parseFloat(r.price));
    return out;
}

function mapPool(rows: any[], prices: Map<number, number>): PoolRow[] {
    return rows.map((r) => {
        const name = String(r.name ?? '');
        const norm = normalizeName(name);
        const spId = Number(r.spId);
        return {
            spId,
            productId: Number(r.productId),
            name,
            brandName: r.brandName ?? null,
            imageUrl: r.imageUrl ?? null,
            unit: r.unit ?? null,
            chainId: Number(r.chainId),
            chainName: String(r.chainName ?? ''),
            chainLogoUrl: r.chainLogoUrl ?? null,
            categoryId: Number(r.categoryId),
            categoryName: String(r.categoryName ?? ''),
            latestPrice: prices.get(spId) ?? null,
            norm,
            tris: trigramSet(norm),
        };
    }).filter((r) => r.norm.length >= 4);
}

const side = (r: PoolRow) => ({
    productId: r.productId,
    name: r.name,
    brandName: r.brandName,
    imageUrl: r.imageUrl,
    unit: r.unit,
    chainId: r.chainId,
    chainName: r.chainName,
    chainLogoUrl: r.chainLogoUrl,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
});

/**
 * FAST PATH — read the NIGHTLY-PRECOMPUTED pairs instead of scoring live. The OSC
 * seeder (runs nightly + on-demand refill) already stores every 688 orphan's top-K
 * categorised candidates with a similarity score — exactly the pairing 2c computes,
 * minus the receipt scoping. So: filter the precomputed rows by the receipt's
 * category family, keep the score floor, prefer the receipt's chain, and re-rank
 * with the price-agreement bonus. Falls back to the live fishing pass when the
 * precomputed rows can't fill k (fresh orphans the seeder hasn't reached yet).
 */
async function fetchPrecomputedPairs(
    catIds: number[],
    receiptChainId: number,
    limit: number,
    locale: Locale,
): Promise<Array<RawSlot2Row & { composite: number }>> {
    const [rows]: any = await pool.query(
        `SELECT osc.similarityScore AS score,
                osp.id AS oSpId, op.id AS oProductId, COALESCE(osp.storeProductName, op.name) AS oName,
                osp.brandName AS oBrand, osp.imageUrl AS oImage, osp.unit AS oUnit, osp.chainId AS oChainId,
                ochain.name AS oChainName, ochain.logoUrl AS oChainLogo,
                op.categoryId AS oCatId, COALESCE(oct.name, oc.name) AS oCatName,
                csp.id AS cSpId, cp.id AS cProductId, COALESCE(csp.storeProductName, cp.name) AS cName,
                csp.brandName AS cBrand, csp.imageUrl AS cImage, csp.unit AS cUnit, csp.chainId AS cChainId,
                cchain.name AS cChainName, cchain.logoUrl AS cChainLogo,
                cp.categoryId AS cCatId, COALESCE(cct.name, cc.name) AS cCatName
           FROM OrphanSwipeCandidate osc
           JOIN Product op  ON op.id = osc.orphanProductId AND op.mergedIntoId IS NULL AND op.categoryId = 688
           JOIN StoreProduct osp ON osp.id = osc.orphanSpId
           JOIN Product cp  ON cp.id = osc.candidateProductId AND cp.mergedIntoId IS NULL AND cp.categoryId IN (?)
           JOIN StoreProduct csp ON csp.id = osc.candidateSpId
           JOIN StoreChain ochain ON ochain.id = osp.chainId
           JOIN StoreChain cchain ON cchain.id = csp.chainId
           JOIN Category oc ON oc.id = op.categoryId
           JOIN Category cc ON cc.id = cp.categoryId
           LEFT JOIN CategoryTranslation oct ON oct.categoryId = oc.id AND oct.locale = ?
           LEFT JOIN CategoryTranslation cct ON cct.categoryId = cc.id AND cct.locale = ?
          WHERE osc.resolved = 0
            AND osc.similarityScore >= ?
          ORDER BY (osp.chainId = ?) DESC, osc.similarityScore DESC
          LIMIT ?`,
        [catIds, locale, locale, SLOT2C_MIN_NAME, receiptChainId, limit],
    );
    if (!(rows as any[]).length) return [];
    // Price-agreement re-rank (the composite's second lane).
    const prices = await fetchLatestPrices((rows as any[]).flatMap((r) => [Number(r.oSpId), Number(r.cSpId)]));
    return (rows as any[]).map((r) => {
        const oP = prices.get(Number(r.oSpId)) ?? null;
        const cP = prices.get(Number(r.cSpId)) ?? null;
        const priceAgrees = oP != null && cP != null && Math.abs(oP - cP) <= Math.max(0.05, 0.03 * Math.max(oP, cP));
        const composite = Number(r.score) + (priceAgrees ? SLOT2C_PRICE_BONUS : 0);
        return {
            source: '2c' as const,
            orphanSpId: Number(r.oSpId),
            candidateSpId: Number(r.cSpId),
            score: Math.min(1, composite),
            sameChain: Number(r.oChainId) === Number(r.cChainId),
            orphan: {
                productId: Number(r.oProductId), name: String(r.oName), brandName: r.oBrand ?? null,
                imageUrl: r.oImage ?? null, unit: r.oUnit ?? null, chainId: Number(r.oChainId),
                chainName: String(r.oChainName), chainLogoUrl: r.oChainLogo ?? null,
                categoryId: Number(r.oCatId), categoryName: String(r.oCatName ?? ''),
            },
            candidate: {
                productId: Number(r.cProductId), name: String(r.cName), brandName: r.cBrand ?? null,
                imageUrl: r.cImage ?? null, unit: r.cUnit ?? null, chainId: Number(r.cChainId),
                chainName: String(r.cChainName), chainLogoUrl: r.cChainLogo ?? null,
                categoryId: Number(r.cCatId), categoryName: String(r.cCatName ?? ''),
            },
            composite,
        };
    });
}

export async function buildSlot2cBackfill(
    userId: string,
    receiptId: number,
    k: number,
    locale: Locale = 'lt',
): Promise<Slot2QueueItem[]> {
    if (!(k > 0)) return [];
    const scope = await getReceiptRelatednessScope(receiptId, pool);
    if (scope.categoryIds.size === 0) {
        console.log(`[Slot2c] r${receiptId}: no matched categories on the receipt → no backfill`);
        return [];
    }
    const catIds = [...scope.categoryIds].filter((id) => Number.isFinite(id) && id > 0 && id !== 688);
    if (catIds.length === 0) return [];
    const receiptChainId = [...scope.chainIds][0] ?? 0;

    // FAST PATH: nightly-precomputed OSC pairs filtered by the receipt's category
    // family. Only when they can't fill k does the live fishing pass below run.
    try {
        const pre = await fetchPrecomputedPairs(catIds, receiptChainId, Math.max(20, k * 5), locale);
        if (pre.length > 0) {
            const votedPre = await fetchVotedPairKeys(userId);
            const bestPerOrphanPre = new Map<number, RawSlot2Row & { composite: number }>();
            for (const row of pre) {
                const prev = bestPerOrphanPre.get(row.orphanSpId);
                if (!prev || row.composite > prev.composite) bestPerOrphanPre.set(row.orphanSpId, row);
            }
            const items = buildSlot2Queue([...bestPerOrphanPre.values()], votedPre).slice(0, Math.max(0, k));
            if (items.length >= k) {
                console.log(`[Slot2c] r${receiptId}: PRECOMPUTED path served ${items.length}/${k} (pool ${pre.length})`);
                return items;
            }
        }
    } catch (e) {
        console.warn('[Slot2c] precomputed path failed (falling back to live):', (e as Error)?.message ?? e);
    }

    // CANDIDATE side: one representative SP per categorised Product in the receipt's
    // category family (lowest spId — arbitrary but stable, the cross-chain fetcher's rule).
    const [candRows]: any = await pool.query(
        `SELECT ${rowFields}
           FROM Product p
           JOIN StoreProduct sp ON sp.id = (
               SELECT MIN(sp2.id) FROM StoreProduct sp2 WHERE sp2.productId = p.id
           )
           ${rowJoins}
          WHERE p.categoryId IN (?)
            AND p.mergedIntoId IS NULL
          LIMIT ?`,
        [locale, catIds, SLOT2C_CANDIDATE_POOL],
    );
    // ORPHAN side: freshest Nepriskirta Products with an SP, receipt-chain first (the
    // scan context makes same-chain orphans the most relevant rescue work).
    const [orphRows]: any = await pool.query(
        `SELECT ${rowFields}
           FROM Product p
           JOIN StoreProduct sp ON sp.id = (
               SELECT MIN(sp2.id) FROM StoreProduct sp2 WHERE sp2.productId = p.id
           )
           ${rowJoins}
          WHERE p.categoryId = 688
            AND p.mergedIntoId IS NULL
          ORDER BY (sp.chainId = ?) DESC, p.id DESC
          LIMIT ?`,
        [locale, receiptChainId, SLOT2C_ORPHAN_POOL],
    );
    const allIds = [...(candRows as any[]), ...(orphRows as any[])].map((r) => Number(r.spId));
    const prices = await fetchLatestPrices(allIds);
    const candidates = mapPool(candRows as any[], prices);
    const orphans = mapPool(orphRows as any[], prices);
    if (candidates.length === 0 || orphans.length === 0) {
        console.log(`[Slot2c] r${receiptId}: empty pool (candidates=${candidates.length}, orphans=${orphans.length})`);
        return [];
    }

    // Composite scoring: trigram block → Levenshtein name lane → price corroboration.
    const votedPairKeys = await fetchVotedPairKeys(userId);
    const best = new Map<string, RawSlot2Row & { composite: number }>();
    for (const o of orphans) {
        for (const c of candidates) {
            if (o.productId === c.productId || o.spId === c.spId) continue;
            if (trigramJaccard(o.tris, c.tris) < SLOT2C_TRIGRAM_BLOCK) continue;
            const nameScore = levenshteinRatio(o.norm, c.norm);
            if (nameScore < SLOT2C_MIN_NAME) continue;
            const priceAgrees = o.latestPrice != null && c.latestPrice != null
                && Math.abs(o.latestPrice - c.latestPrice) <= Math.max(0.05, 0.03 * Math.max(o.latestPrice, c.latestPrice));
            const composite = nameScore + (priceAgrees ? SLOT2C_PRICE_BONUS : 0);
            const key = `${Math.min(o.spId, c.spId)}-${Math.max(o.spId, c.spId)}`;
            const prev = best.get(key);
            if (!prev || composite > prev.composite) {
                best.set(key, {
                    source: '2c',
                    orphanSpId: o.spId,
                    candidateSpId: c.spId,
                    score: Math.min(1, composite),
                    sameChain: o.chainId === c.chainId,
                    orphan: side(o),
                    candidate: side(c),
                    composite,
                });
            }
        }
    }

    // One card per ORPHAN (an orphan's best candidate — not five cards about one
    // product), then the standard slot-2 pipeline: voted-pair no-repeat, unit
    // conflict, sort by score.
    const bestPerOrphan = new Map<number, RawSlot2Row & { composite: number }>();
    for (const row of best.values()) {
        const prev = bestPerOrphan.get(row.orphanSpId);
        if (!prev || row.composite > prev.composite) bestPerOrphan.set(row.orphanSpId, row);
    }
    const items = buildSlot2Queue([...bestPerOrphan.values()], votedPairKeys).slice(0, Math.max(0, k));
    console.log(
        `[Slot2c] r${receiptId}: cats=${catIds.length} orphans=${orphans.length} candidates=${candidates.length} `
        + `pairs=${best.size} → served ${items.length}/${k}`
        + (items.length ? ` :: ${items.map((i) => `${i.cardId} "${i.orphan.name}"⇄"${i.candidate.name}" s=${i.score.toFixed(2)}`).join(' | ')}` : ''),
    );
    return items;
}
