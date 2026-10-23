/**
 * Smart Basket — "Generate basket with AI" (shared/SMART_BASKET_SPEC.md).
 *
 * Three modes over ONE scoring foundation:
 *   popular   — globally popular this week × the user's own habits
 *   discounts — the same, restricted to products with a live discount
 *   personal  — the user's typical trip, combo-aware (co-occurrence refined)
 *
 * Scoring (research-backed, see spec §3):
 *   • Personal and global scores share PER-TRIP PROBABILITY semantics —
 *     P(item ∈ trip) — so they are directly comparable (no rank hacks).
 *   • Personal: recency-decayed (45d half-life) share of the user's trips.
 *   • Global "this week": 14d window, 7d half-life, across ALL users' trips;
 *     auto-widens to 90d when the in-window corpus is too thin.
 *   • Blend: Jelinek-Mercer  λ·personal + (1−λ)·global,  λ = n/(n+τ).
 *   • Combos: shrunk-lift pair graph (add-k + n/(n+λ) damping), personal
 *     interpolated toward global; greedy marginal-gain slot filling seeded by
 *     the top personal item (frequency drives, co-occurrence refines).
 *   • Slots: decayed median of distinct products per calendar-day trip,
 *     clamped to [5, 25]. Same-day receipts count as ONE trip (multi-store
 *     future-proofing).
 *
 * Pure decision functions are side-effect-free (unit-tested); the orchestrator
 * at the bottom is the DB glue. Trips come from ReceiptItem (S1/S2 resolved
 * lines); the receipt_buy backfill (scripts/backfillReceiptBuy.ts) guarantees
 * the interaction-based ranks agree with the receipt history.
 */

import pool from '../config/db.js';
import { localizedProductNameSql, type Locale } from '../middleware/locale.js';
import { qualifiesForAutoTemplate, roundQuantity, median, decayWeight } from './defaultTemplateService.js';

// ── Tunables ───────────────────────────────────────────────────────────────

export const SLOT_MIN = 5;
export const SLOT_MAX = 25;
/** Personal habit half-life (days) — matches the smart template. */
export const PERSONAL_HALF_LIFE = 45;
/** "This week" global window + decay. */
export const GLOBAL_WINDOW_DAYS = 14;
export const GLOBAL_HALF_LIFE = 7;
/** Widen the global window when it holds fewer trips than this. */
export const MIN_GLOBAL_TRIPS = 5;
export const GLOBAL_FALLBACK_WINDOW_DAYS = 90;
/** Personal trip history window. */
export const PERSONAL_WINDOW_DAYS = 90;
/** Jelinek-Mercer pseudo-count for personal↔global blends. */
export const BLEND_TAU = 5;
/** Pair-graph tunables (spec §4c). */
export const PAIR_ADD_K = 0.5;
export const PAIR_DAMP = 5;          // n/(n+λ) support damping
export const PAIR_MIN_CO_PERSONAL = 2;
export const PAIR_MIN_CO_GLOBAL = 3;
/** Diversity cap for never-bought (pure-global) suggestions. */
export const GLOBAL_CAP_PER_CATEGORY = 2;

// ── Pure decision logic ───────────────────────────────────────────────────

/** One shopping trip: all receipts of one user on one calendar day. */
export interface Trip {
    /** Age of the trip in days (0 = today). */
    ageDays: number;
    /** Distinct productIds bought on the trip. */
    productIds: number[];
}

/** Decayed median of distinct-products-per-trip, clamped to [SLOT_MIN, SLOT_MAX].
 *  Decay = drop trips older than the personal window; weight recent trips by
 *  repeating them in the median pool proportional to their decay weight. */
export function estimateSlots(trips: Trip[], halfLife: number = PERSONAL_HALF_LIFE): number {
    const sizes: number[] = [];
    for (const t of trips) {
        const w = decayWeight(t.ageDays, halfLife);
        // Weighted median via repetition at 0.25 granularity (bounded: ≤4 reps).
        const reps = Math.max(1, Math.round(w * 4));
        for (let i = 0; i < reps; i++) sizes.push(t.productIds.length);
    }
    const m = Math.round(median(sizes));
    if (!Number.isFinite(m) || m <= 0) return SLOT_MIN;
    return Math.min(Math.max(m, SLOT_MIN), SLOT_MAX);
}

/** Per-trip probability: decayed share of trips containing each product. */
export function tripProbabilities(trips: Trip[], halfLife: number): Map<number, number> {
    const out = new Map<number, number>();
    let totalW = 0;
    for (const t of trips) {
        const w = decayWeight(t.ageDays, halfLife);
        totalW += w;
        for (const pid of new Set(t.productIds)) {
            out.set(pid, (out.get(pid) ?? 0) + w);
        }
    }
    if (totalW <= 0) return new Map();
    for (const [pid, v] of out) out.set(pid, v / totalW);
    return out;
}

/** Jelinek-Mercer blend of two same-scale scores. λ grows with evidence. */
export function blendScore(personal: number, global: number, nTrips: number, tau: number = BLEND_TAU): number {
    const lambda = nTrips / (nTrips + tau);
    return lambda * personal + (1 - lambda) * global;
}

/** Canonical unordered pair key. */
const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Shrunk-lift pair scores from a trip list.
 *   lift = P(ij) / (P(i)·P(j)) with add-k smoothing on counts,
 *   damped by n/(n+λ) so single co-occurrences can't explode (research: raw
 *   lift on tiny counts is noise ranking).
 * Scores are offset by -1 (independence → 0) and clamped at ≥0 so "no signal"
 * and "anti-correlated" both contribute nothing to combo gains.
 */
export function pairScores(
    trips: Trip[],
    opts: { minCo?: number; addK?: number; damp?: number } = {},
): Map<string, number> {
    const minCo = opts.minCo ?? PAIR_MIN_CO_PERSONAL;
    const addK = opts.addK ?? PAIR_ADD_K;
    const damp = opts.damp ?? PAIR_DAMP;
    const n = trips.length;
    if (n === 0) return new Map();

    const c = new Map<number, number>();
    const co = new Map<string, number>();
    for (const t of trips) {
        const ids = [...new Set(t.productIds)];
        for (const id of ids) c.set(id, (c.get(id) ?? 0) + 1);
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const k = pairKey(ids[i], ids[j]);
                co.set(k, (co.get(k) ?? 0) + 1);
            }
        }
    }
    const out = new Map<string, number>();
    for (const [k, cij] of co) {
        if (cij < minCo) continue;
        const [a, b] = k.split(':').map(Number);
        const pi = ((c.get(a) ?? 0) + addK) / (n + addK);
        const pj = ((c.get(b) ?? 0) + addK) / (n + addK);
        const pij = (cij + addK) / (n + addK);
        const lift = pij / (pi * pj);
        const damped = (cij / (cij + damp)) * Math.max(lift - 1, 0);
        if (damped > 0) out.set(k, damped);
    }
    return out;
}

/** Interpolate personal pair scores toward global ones (per-pair λ by personal
 *  evidence; pairs present only globally pass through at (1−λ₀) weight). */
export function interpolatePairs(
    personal: Map<string, number>,
    personalCo: Map<string, number>,
    global_: Map<string, number>,
    tau: number = BLEND_TAU,
): Map<string, number> {
    const out = new Map<string, number>();
    const keys = new Set([...personal.keys(), ...global_.keys()]);
    for (const k of keys) {
        const cu = personalCo.get(k) ?? 0;
        const lambda = cu / (cu + tau);
        const p = personal.get(k) ?? 0;
        const g = global_.get(k) ?? 0;
        const v = lambda * p + (1 - lambda) * g;
        if (v > 0) out.set(k, v);
    }
    return out;
}

/** Raw personal co-occurrence counts (for interpolation weights). */
export function pairCounts(trips: Trip[]): Map<string, number> {
    const co = new Map<string, number>();
    for (const t of trips) {
        const ids = [...new Set(t.productIds)];
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const k = pairKey(ids[i], ids[j]);
                co.set(k, (co.get(k) ?? 0) + 1);
            }
        }
    }
    return co;
}

/**
 * Greedy combo slot filling (spec §4c): seed with the top personal item, then
 * repeatedly add the candidate maximising personal(j) × (1 + Σ pair(i,j)) —
 * frequency drives, co-occurrence refines.
 */
export function greedyComboFill(
    personalScores: Map<number, number>,
    pairs: Map<string, number>,
    slots: number,
): number[] {
    const candidates = [...personalScores.entries()]
        .filter(([, s]) => s > 0)
        .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
    if (candidates.length === 0) return [];

    const picked: number[] = [candidates[0][0]];
    const pool = new Set(candidates.slice(1).map(([id]) => id));
    while (picked.length < slots && pool.size > 0) {
        let bestId = -1;
        let bestGain = -1;
        for (const id of pool) {
            const base = personalScores.get(id) ?? 0;
            let comboBoost = 0;
            for (const p of picked) comboBoost += pairs.get(pairKey(id, p)) ?? 0;
            const gain = base * (1 + comboBoost);
            if (gain > bestGain || (gain === bestGain && id < bestId)) {
                bestGain = gain;
                bestId = id;
            }
        }
        if (bestId < 0) break;
        picked.push(bestId);
        pool.delete(bestId);
    }
    return picked;
}

export interface RankedCandidate {
    productId: number;
    score: number;
    source: 'personal' | 'both' | 'global';
}

/**
 * Popular/discount slot filling (spec §4a): items known to BOTH the user and
 * the crowd first (blended score), then best-of-either. Pure-global entries
 * (user never bought) obey the per-category diversity cap and must belong to
 * a category the user has bought from.
 */
export function rankPopular(
    personal: Map<number, number>,
    global_: Map<number, number>,
    nTrips: number,
    slots: number,
    categoryOf: Map<number, number | null>,
    userCategories: Set<number>,
    opts: { capPerCategory?: number; tau?: number } = {},
): RankedCandidate[] {
    const cap = opts.capPerCategory ?? GLOBAL_CAP_PER_CATEGORY;
    const tau = opts.tau ?? BLEND_TAU;

    const all = new Set([...personal.keys(), ...global_.keys()]);
    const both: RankedCandidate[] = [];
    const rest: RankedCandidate[] = [];
    for (const pid of all) {
        const p = personal.get(pid) ?? 0;
        const g = global_.get(pid) ?? 0;
        if (p > 0 && g > 0) {
            both.push({ productId: pid, score: blendScore(p, g, nTrips, tau), source: 'both' });
        } else if (p > 0) {
            rest.push({ productId: pid, score: p, source: 'personal' });
        } else if (g > 0) {
            rest.push({ productId: pid, score: g, source: 'global' });
        }
    }
    const byScore = (a: RankedCandidate, b: RankedCandidate) =>
        (b.score - a.score) || (a.productId - b.productId);
    both.sort(byScore);
    rest.sort(byScore);

    const out: RankedCandidate[] = [];
    const catUsed = new Map<number, number>();
    const take = (c: RankedCandidate): void => {
        if (out.length >= slots) return;
        if (c.source === 'global') {
            const cat = categoryOf.get(c.productId) ?? null;
            // Never-bought items: only from categories the user shops, max N per category.
            if (cat == null || !userCategories.has(cat)) return;
            const used = catUsed.get(cat) ?? 0;
            if (used >= cap) return;
            catUsed.set(cat, used + 1);
        }
        out.push(c);
    };
    for (const c of both) take(c);
    for (const c of rest) take(c);
    return out;
}

// ── DB orchestrator ───────────────────────────────────────────────────────

export type SmartBasketMode = 'popular' | 'discounts' | 'personal';

export interface SmartBasketItem {
    productId: number;
    name: string;
    imageUrls: unknown;
    quantity: number;
    isWeighable: boolean;
    source: RankedCandidate['source'];
    discountPct: number | null;
}

export interface SmartBasketPreview {
    qualified: boolean;
    progress: { receipts: number; chains: number; needReceipts: number; needChains: number };
    slots: number;
    mode: SmartBasketMode;
    items: SmartBasketItem[];
}

interface TripRow {
    userId: string;
    day: string;
    productId: number;
    qty: number | null;
    ageDays: number;
}

/** Load S1/S2-resolved purchases grouped later into calendar-day trips. */
async function loadTripRows(windowDays: number, userId?: string): Promise<TripRow[]> {
    const params: any[] = [windowDays];
    const userCond = userId ? 'AND r.userId = ?' : '';
    if (userId) params.push(userId);
    const [rows]: any = await pool.query(
        `SELECT r.userId,
                DATE(COALESCE(r.receiptDate, NOW())) AS day,
                sp.productId,
                SUM(COALESCE(ri.quantity, 1)) AS qty,
                DATEDIFF(NOW(), COALESCE(r.receiptDate, NOW())) AS ageDays
         FROM ReceiptItem ri
         JOIN Receipt r       ON r.id = ri.receiptId
         JOIN StoreProduct sp ON sp.id = ri.matchedSpId
         WHERE ri.matchedSpId IS NOT NULL
           AND ri.band IN ('S1','S2')
           AND sp.productId IS NOT NULL
           AND COALESCE(r.receiptDate, NOW()) >= DATE_SUB(NOW(), INTERVAL ? DAY)
           ${userCond}
         GROUP BY r.userId, day, sp.productId`,
        params,
    );
    return rows.map((r: any) => ({
        userId: String(r.userId),
        day: String(r.day),
        productId: Number(r.productId),
        qty: r.qty != null ? Number(r.qty) : null,
        ageDays: Math.max(0, Number(r.ageDays) || 0),
    }));
}

function rowsToTrips(rows: TripRow[]): Trip[] {
    const byTrip = new Map<string, { ageDays: number; productIds: number[] }>();
    for (const r of rows) {
        const key = `${r.userId}|${r.day}`;
        const t = byTrip.get(key) ?? { ageDays: r.ageDays, productIds: [] };
        t.ageDays = Math.min(t.ageDays, r.ageDays);
        t.productIds.push(r.productId);
        byTrip.set(key, t);
    }
    return [...byTrip.values()];
}

/** Median purchased qty per product from the user's trip rows. */
function typicalQuantities(rows: TripRow[]): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const r of rows) {
        if (r.qty == null || !(r.qty > 0)) continue;
        const list = out.get(r.productId) ?? [];
        list.push(r.qty);
        out.set(r.productId, list);
    }
    return out;
}

export async function buildSmartBasketPreview(
    userId: string,
    mode: SmartBasketMode,
    locale: Locale,
): Promise<SmartBasketPreview> {
    // Gate: 3 receipts across 2 chains (same rule as the smart template).
    const [receiptRows]: any = await pool.query(
        `SELECT DISTINCT r.id, s.chainId
         FROM Receipt r
         LEFT JOIN Store s ON s.id = r.storeId
         WHERE r.userId = ? AND r.processingStatus = 'completed'`,
        [userId],
    );
    const chains = new Set(receiptRows.map((r: any) => r.chainId).filter((c: any) => c != null));
    const qualified = qualifiesForAutoTemplate(receiptRows.map((r: any) => ({ chainId: r.chainId })));
    const progress = {
        receipts: receiptRows.length,
        chains: chains.size,
        needReceipts: 3,
        needChains: 2,
    };
    if (!qualified) {
        return { qualified, progress, slots: 0, mode, items: [] };
    }

    // Trips.
    const userRows = await loadTripRows(PERSONAL_WINDOW_DAYS, userId);
    const userTrips = rowsToTrips(userRows);
    let globalRows = await loadTripRows(GLOBAL_WINDOW_DAYS);
    if (rowsToTrips(globalRows).length < MIN_GLOBAL_TRIPS) {
        globalRows = await loadTripRows(GLOBAL_FALLBACK_WINDOW_DAYS);
    }
    const globalTrips = rowsToTrips(globalRows);

    const slots = estimateSlots(userTrips);
    const personal = tripProbabilities(userTrips, PERSONAL_HALF_LIFE);
    const global_ = tripProbabilities(globalTrips, GLOBAL_HALF_LIFE);

    // Category metadata for every product we might rank.
    const allIds = [...new Set([...personal.keys(), ...global_.keys()])];
    const categoryOf = new Map<number, number | null>();
    if (allIds.length > 0) {
        const [catRows]: any = await pool.query(
            'SELECT id, categoryId FROM Product WHERE id IN (?)', [allIds],
        );
        for (const r of catRows) categoryOf.set(Number(r.id), r.categoryId != null ? Number(r.categoryId) : null);
    }
    const userCategories = new Set<number>();
    for (const pid of personal.keys()) {
        const c = categoryOf.get(pid);
        if (c != null) userCategories.add(c);
    }

    // Mode ranking.
    let ranked: RankedCandidate[];
    const discountPctById = new Map<number, number>();
    if (mode === 'personal') {
        const personalPairs = pairScores(userTrips, { minCo: PAIR_MIN_CO_PERSONAL });
        const globalPairs = pairScores(globalTrips, { minCo: PAIR_MIN_CO_GLOBAL });
        const pairs = interpolatePairs(personalPairs, pairCounts(userTrips), globalPairs);
        const picked = greedyComboFill(personal, pairs, slots);
        ranked = picked.map(pid => ({ productId: pid, score: personal.get(pid) ?? 0, source: 'personal' as const }));
        // Backfill leftover slots with the blended popular ranking.
        if (ranked.length < slots) {
            const pad = rankPopular(personal, global_, userTrips.length, slots, categoryOf, userCategories)
                .filter(c => !picked.includes(c.productId));
            ranked = ranked.concat(pad.slice(0, slots - ranked.length));
        }
    } else {
        let personalPool = personal;
        let globalPool = global_;
        if (mode === 'discounts') {
            // Restrict candidates to products carrying a live discount.
            const [dRows]: any = await pool.query(
                `SELECT productId, COALESCE(realDiscountPct, bestDiscountPct) AS pct
                 FROM DiscountedProductSummary
                 WHERE COALESCE(realDiscountPct, bestDiscountPct) > 0`,
            );
            const discounted = new Set<number>();
            for (const r of dRows) {
                discounted.add(Number(r.productId));
                discountPctById.set(Number(r.productId), Number(r.pct));
            }
            personalPool = new Map([...personal].filter(([pid]) => discounted.has(pid)));
            globalPool = new Map([...global_].filter(([pid]) => discounted.has(pid)));
        }
        ranked = rankPopular(personalPool, globalPool, userTrips.length, slots, categoryOf, userCategories);
    }
    ranked = ranked.slice(0, slots);

    if (ranked.length === 0) {
        return { qualified, progress, slots, mode, items: [] };
    }

    // Availability + display metadata (locale-aware names, images, weighable).
    const ids = ranked.map(r => r.productId);
    const loc = localizedProductNameSql(locale, { productAlias: 'p' });
    const [metaRows]: any = await pool.query(
        `SELECT p.id, ${loc.nameSql} AS name, ${loc.imageUrlsSql} AS imageUrls,
                COALESCE((SELECT MAX(spw.isWeighable) FROM StoreProduct spw
                          WHERE spw.productId = p.id AND spw.provisional = 0), 0) AS isWeighable
         FROM Product p
         WHERE p.id IN (?)
           AND (
             EXISTS (SELECT 1 FROM Price pr JOIN StoreProduct spx ON spx.id = pr.storeProductId
                     WHERE spx.productId = p.id
                       AND pr.date >= DATE_SUB(NOW(), INTERVAL 45 DAY))
             OR EXISTS (SELECT 1 FROM ReceiptItem rix JOIN Receipt rx ON rx.id = rix.receiptId
                        JOIN StoreProduct spy ON spy.id = rix.matchedSpId
                        WHERE spy.productId = p.id
                          AND COALESCE(rx.receiptDate, NOW()) >= DATE_SUB(NOW(), INTERVAL 45 DAY))
           )`,
        [ids],
    );
    const metaById = new Map<number, any>(metaRows.map((r: any) => [Number(r.id), r]));

    // Amounts: user's median per product; fall back to global median; else 1.
    const userQty = typicalQuantities(userRows);
    const globalQty = typicalQuantities(globalRows);

    const items: SmartBasketItem[] = [];
    for (const c of ranked) {
        const meta = metaById.get(c.productId);
        if (!meta) continue; // dropped by availability
        const isWeighable = !!Number(meta.isWeighable);
        const qtyList = userQty.get(c.productId) ?? globalQty.get(c.productId) ?? [];
        const qty = roundQuantity(median(qtyList) || 1, isWeighable);
        items.push({
            productId: c.productId,
            name: String(meta.name ?? ''),
            imageUrls: meta.imageUrls ?? null,
            quantity: qty,
            isWeighable,
            source: c.source,
            discountPct: discountPctById.get(c.productId) ?? null,
        });
    }
    return { qualified, progress, slots, mode, items };
}
