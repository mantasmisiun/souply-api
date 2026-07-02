/**
 * Auto-generated default ("Smart template") — Pass A.3 of the šablonai roadmap.
 *
 * The Smart template IS the user's real shopping list, reconstructed from the
 * products they actually buy on their receipts. Design notes:
 *
 *   • Triggered once the user uploads their 3rd receipt across ≥ 2 distinct
 *     chains (same threshold as account recovery, so onboarding doubles as
 *     recovery without ever mentioning it).
 *   • Ranking is RECENCY-WEIGHTED frequency, not raw frequency: each purchase
 *     contributes an exponentially-decaying weight by age (half-life
 *     DECAY_HALF_LIFE_DAYS). A staple bought twice last week beats one bought
 *     ten times a year ago — the list tracks current habits, not history.
 *   • Item amounts are the MEDIAN quantity the user buys per trip (from each
 *     receipt's parsedData — Price has no quantity column), unit-rounded.
 *   • Only products that are still buyable are included: a recent scraped
 *     price OR a recent purchase within AVAILABILITY_WINDOW_DAYS (a thing you
 *     bought last week is obviously still sold). Discontinued items drop off.
 *   • One-off impulse buys (seen on a single receipt) are held back unless we
 *     need them to reach MIN_ITEMS, so the list isn't polluted by noise but a
 *     light user still gets a usable template.
 *   • Among similar scores, products sold in MORE chains rank higher so the
 *     resulting basket is actually price-comparable across stores.
 *   • Re-runs on every subsequent receipt upload for templates with
 *     autoUpdate = 1 (the "learn from receipts" switch).
 *
 * The pure decision functions are kept side-effect-free so they can be
 * unit-tested without touching the DB. The orchestrator at the bottom is the
 * integration glue.
 */

import pool from '../config/db.js';
import {
    createTemplate,
    insertTemplateItemsBatch,
    type TemplateItemInput,
} from '../models/basketTemplateModel.js';

// ── Tunables ───────────────────────────────────────────────────────────────

/** Hard cap on template size — a quick-shop list, not a dump of everything. */
export const MAX_ITEMS = 25;
/** Backfill target so light users still get a usable list (see one-off rule). */
export const MIN_ITEMS = 8;
/** Below this purchase frequency a product is a "one-off" (backfill only). */
export const MIN_FREQUENCY = 2;
/** Recency half-life: a purchase this many days old counts for half as much. */
export const DECAY_HALF_LIFE_DAYS = 45;
/** A product is "still buyable" if scraped OR purchased within this window. */
export const AVAILABILITY_WINDOW_DAYS = 45;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Pure decision logic ───────────────────────────────────────────────────

export interface ReceiptSummary {
    chainId: number | null;
}

/**
 * Whether the user has enough receipt history to warrant generating a
 * default template. Mirrors the 3-receipt / 2-chain threshold used by
 * account recovery so uploading-for-templates silently makes the account
 * recoverable too — the user never has to think about it.
 */
export function qualifiesForAutoTemplate(receipts: ReceiptSummary[]): boolean {
    if (receipts.length < 3) return false;
    const distinctChains = new Set(receipts.map(r => r.chainId).filter(c => c != null));
    return distinctChains.size >= 2;
}

/**
 * Exponential recency weight for a single purchase. age 0 → 1.0; age ==
 * half-life → 0.5; older → tends to 0. Future-dated / today purchases get
 * full weight.
 */
export function decayWeight(ageDays: number, halfLifeDays: number = DECAY_HALF_LIFE_DAYS): number {
    if (!(ageDays > 0) || !Number.isFinite(ageDays)) return 1;
    return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Plain median of a numeric list (0 for empty). */
export function median(values: number[]): number {
    const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Round a typical purchase amount to something sensible for a shopping list.
 * Weighable products → 0.1 step (kg); piece products → whole units. Clamped
 * to a sane band so a garbled OCR quantity can't produce an absurd amount.
 */
export function roundQuantity(qty: number, isWeighable: boolean): number {
    if (!(qty > 0) || !Number.isFinite(qty)) return 1;
    if (isWeighable) {
        const r = Math.round(qty * 10) / 10;
        return Math.min(Math.max(r, 0.1), 20);
    }
    const r = Math.round(qty);
    return Math.min(Math.max(r, 1), 50);
}

/** A product the user bought, aggregated across their receipts. */
export interface PurchaseSignal {
    productId: number;
    /** Sum of recency-decayed weights over the distinct receipts it appears on. */
    decayedScore: number;
    /** Distinct receipts this product appears on (raw purchase frequency). */
    freq: number;
    /** Typical amount bought per trip (median, unit-rounded). */
    quantity: number;
    /** How many chains sell this product (comparability tiebreak). */
    chainCount: number;
    /** Still buyable — recent scraped price OR recent purchase. */
    available: boolean;
}

export interface RankedTemplateItem {
    productId: number;
    quantity: number;
}

/**
 * Rank purchase signals into the final template item list.
 *
 *   • Drop unavailable / zero-score products.
 *   • Primary order: recency-weighted score (decayedScore) descending.
 *   • Ties: more chains first (more price-comparable), then raw frequency.
 *   • Habitual products (freq ≥ MIN_FREQUENCY) fill the list first; one-off
 *     buys only backfill up to MIN_ITEMS so a light user isn't left empty.
 *   • Capped at MAX_ITEMS.
 */
export function rankDefaultTemplateItems(
    signals: PurchaseSignal[],
    opts: { maxItems?: number; minItems?: number; minFrequency?: number } = {},
): RankedTemplateItem[] {
    const maxItems = opts.maxItems ?? MAX_ITEMS;
    const minItems = opts.minItems ?? MIN_ITEMS;
    const minFrequency = opts.minFrequency ?? MIN_FREQUENCY;

    const eligible = signals.filter(
        s => Number.isFinite(s.productId) && s.available && s.decayedScore > 0,
    );
    const cmp = (a: PurchaseSignal, b: PurchaseSignal) =>
        (b.decayedScore - a.decayedScore) ||
        (b.chainCount - a.chainCount) ||
        (b.freq - a.freq) ||
        (a.productId - b.productId);

    const strong = eligible.filter(s => s.freq >= minFrequency).sort(cmp);
    const weak = eligible.filter(s => s.freq < minFrequency).sort(cmp);

    let picked = strong.slice(0, maxItems);
    if (picked.length < minItems) {
        picked = picked.concat(weak.slice(0, minItems - picked.length));
    }
    return picked
        .slice(0, maxItems)
        .map(s => ({ productId: s.productId, quantity: s.quantity }));
}

// ── DB-touching orchestrator ──────────────────────────────────────────────

export type GenerateResult =
    | { action: 'created'; templateId: number; itemCount: number }
    | { action: 'updated'; templateId: number; itemCount: number; delta: number }
    | { action: 'skipped'; reason: string };

/**
 * Pure delta calculator — items added + items removed between two sets.
 * Quantity changes are not counted as deltas for v1 (the spec only
 * mentions item membership in the nudge threshold).
 */
export function computeItemDelta(oldIds: number[], newIds: number[]): number {
    const oldSet = new Set(oldIds);
    const newSet = new Set(newIds);
    let delta = 0;
    for (const id of newIds) if (!oldSet.has(id)) delta++;
    for (const id of oldIds) if (!newSet.has(id)) delta++;
    return delta;
}

/** A single product line read off one receipt's parsedData. */
interface PurchaseEvent {
    spId: number;
    receiptId: number;
    receiptMs: number;
    quantity: number;
}

/**
 * Gather the user's receipt purchases into ranked template items. Pulls the
 * raw lines from parsedData (quantity lives there, not in Price), resolves
 * each storeProductId → productId + isWeighable, then computes the
 * recency-weighted score, median amount and availability per product.
 */
async function buildSignalsFromReceipts(userId: string, now: number): Promise<PurchaseSignal[]> {
    // Purchase events live in the ReceiptItem rows since the ReceiptItem cutover —
    // the stored blob keeps products: [], so a blob-only read would contribute ZERO
    // events for every post-cutover receipt (the same silent-exclusion class the
    // getUserStats migration fixed). The blob remains ONLY as the legacy fallback
    // for receipts that predate the migration (no rows).
    const [receiptRows]: any = await pool.query(
        `SELECT id, receiptDate, parsedData
           FROM Receipt
          WHERE userId = ? AND parsedData IS NOT NULL`,
        [userId],
    );

    const events: PurchaseEvent[] = [];
    const spIds = new Set<number>();
    if ((receiptRows as any[]).length > 0) {
        const [itemRows]: any = await pool.query(
            `SELECT receiptId, matchedSpId AS storeProductId, quantity
               FROM ReceiptItem
              WHERE receiptId IN (?)`,
            [(receiptRows as any[]).map((r: any) => Number(r.id))],
        );
        const itemsByReceipt = new Map<number, any[]>();
        for (const it of itemRows as any[]) {
            const list = itemsByReceipt.get(Number(it.receiptId)) ?? [];
            list.push(it);
            itemsByReceipt.set(Number(it.receiptId), list);
        }

        for (const row of receiptRows as any[]) {
            let products: any[] = itemsByReceipt.get(Number(row.id)) ?? [];
            if (products.length === 0) {
                // Legacy fallback: pre-migration receipt with no rows.
                try {
                    const parsed = typeof row.parsedData === 'string' ? JSON.parse(row.parsedData) : row.parsedData;
                    products = Array.isArray(parsed?.products) ? parsed.products : [];
                } catch {
                    continue;
                }
            }
            const receiptMs = row.receiptDate ? new Date(row.receiptDate).getTime() : now;
            for (const line of products) {
                const spId = Number(line?.storeProductId);
                if (!Number.isFinite(spId) || spId <= 0) continue;
                const q = Number(line?.quantity);
                events.push({
                    spId,
                    receiptId: Number(row.id),
                    receiptMs: Number.isFinite(receiptMs) ? receiptMs : now,
                    quantity: Number.isFinite(q) && q > 0 ? q : 1,
                });
                spIds.add(spId);
            }
        }
    }
    if (spIds.size === 0) return [];

    // storeProductId → productId + isWeighable
    const spIdArr = [...spIds];
    const spPlaceholders = spIdArr.map(() => '?').join(',');
    const [spRows]: any = await pool.query(
        `SELECT id, productId, isWeighable FROM StoreProduct WHERE id IN (${spPlaceholders})`,
        spIdArr,
    );
    const spMeta = new Map<number, { productId: number; isWeighable: boolean }>();
    for (const r of spRows as any[]) {
        const productId = Number(r.productId);
        if (Number.isFinite(productId)) {
            spMeta.set(Number(r.id), { productId, isWeighable: !!r.isWeighable });
        }
    }

    // Aggregate per product: distinct receipts (with dates) + per-trip amount.
    interface Agg {
        productId: number;
        isWeighable: boolean;
        receiptDates: Map<number, number>; // receiptId → receiptMs (dedupes lines)
        qtyByReceipt: Map<number, number>; // receiptId → summed qty that trip
    }
    const byProduct = new Map<number, Agg>();
    for (const ev of events) {
        const meta = spMeta.get(ev.spId);
        if (!meta) continue;
        let agg = byProduct.get(meta.productId);
        if (!agg) {
            agg = {
                productId: meta.productId,
                isWeighable: meta.isWeighable,
                receiptDates: new Map(),
                qtyByReceipt: new Map(),
            };
            byProduct.set(meta.productId, agg);
        }
        agg.isWeighable = agg.isWeighable || meta.isWeighable;
        agg.receiptDates.set(ev.receiptId, ev.receiptMs);
        agg.qtyByReceipt.set(ev.receiptId, (agg.qtyByReceipt.get(ev.receiptId) ?? 0) + ev.quantity);
    }
    if (byProduct.size === 0) return [];

    // Availability + chain count per candidate product.
    const prodIdArr = [...byProduct.keys()];
    const prodPlaceholders = prodIdArr.map(() => '?').join(',');
    const [availRows]: any = await pool.query(
        `SELECT sp.productId AS productId,
                COUNT(DISTINCT sp.chainId) AS chainCount,
                MAX(CASE WHEN pr.receiptId IS NULL THEN pr.date END) AS lastScraped
           FROM StoreProduct sp
           LEFT JOIN Price pr ON pr.storeProductId = sp.id
          WHERE sp.productId IN (${prodPlaceholders})
          GROUP BY sp.productId`,
        prodIdArr,
    );
    const availMeta = new Map<number, { chainCount: number; lastScrapedMs: number }>();
    for (const r of availRows as any[]) {
        availMeta.set(Number(r.productId), {
            chainCount: Number(r.chainCount) || 0,
            lastScrapedMs: r.lastScraped ? new Date(r.lastScraped).getTime() : 0,
        });
    }

    const windowMs = AVAILABILITY_WINDOW_DAYS * DAY_MS;
    const signals: PurchaseSignal[] = [];
    for (const agg of byProduct.values()) {
        let decayedScore = 0;
        let lastBoughtMs = 0;
        for (const ms of agg.receiptDates.values()) {
            const ageDays = Math.max(0, (now - ms) / DAY_MS);
            decayedScore += decayWeight(ageDays);
            if (ms > lastBoughtMs) lastBoughtMs = ms;
        }
        const meta = availMeta.get(agg.productId);
        const lastScrapedMs = meta?.lastScrapedMs ?? 0;
        const available =
            (now - lastScrapedMs) <= windowMs || (now - lastBoughtMs) <= windowMs;
        signals.push({
            productId: agg.productId,
            decayedScore,
            freq: agg.receiptDates.size,
            quantity: roundQuantity(median([...agg.qtyByReceipt.values()]), agg.isWeighable),
            chainCount: meta?.chainCount ?? 0,
            available,
        });
    }
    return signals;
}

/**
 * Run the qualification check, pick products, and either create a new
 * default template or refresh the existing one's items wholesale. Wholesale
 * replace (vs. diff) is acceptable for v1 because the only "edits" between
 * runs are user-driven manual additions/removals, and the spec defines
 * `autoUpdate=1` as "trust the algorithm" anyway. Diff-based merging
 * with pinned items lands in a future pass.
 */
export async function generateDefaultTemplate(
    userId: string,
    opts: { allowCreate?: boolean } = {},
): Promise<GenerateResult> {
    // 1. Qualification check
    const [receipts]: any = await pool.query(
        `SELECT s.chainId
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
          WHERE r.userId = ?`,
        [userId],
    );
    const summary: ReceiptSummary[] = receipts.map((r: any) => ({ chainId: r.chainId }));
    if (!qualifiesForAutoTemplate(summary)) {
        return { action: 'skipped', reason: 'not-qualified' };
    }

    // 2. Read the existing default template, if any
    const [existingRows]: any = await pool.query(
        `SELECT id, autoUpdate FROM BasketTemplate
          WHERE userId = ? AND isDefault = 1
          LIMIT 1`,
        [userId],
    );
    const existing = existingRows[0] ?? null;
    // Learning switched off → leave the frozen snapshot untouched.
    if (existing && existing.autoUpdate === 0) {
        return { action: 'skipped', reason: 'autoupdate-off' };
    }
    // Creation is user-initiated (the "Build it" button → allowCreate). The
    // receipt-save trigger only REFRESHES an already-built template.
    if (!existing && !opts.allowCreate) {
        return { action: 'skipped', reason: 'not-built' };
    }

    // 3. Build the ranked item list from what the user actually buys.
    const signals = await buildSignalsFromReceipts(userId, Date.now());
    const ranked = rankDefaultTemplateItems(signals);
    if (ranked.length === 0) {
        return { action: 'skipped', reason: 'no-eligible-products' };
    }
    const productIds = ranked.map(r => r.productId);
    const items: TemplateItemInput[] = ranked.map((it, i) => ({
        productId: it.productId,
        quantity: it.quantity,
        sortOrder: i,
    }));

    // 4. Write
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (existing) {
            // Read the previous item set so we can compute the delta.
            const [prevRows]: any = await (conn as any).query(
                `SELECT productId FROM BasketTemplateItem WHERE templateId = ?`,
                [existing.id],
            );
            const oldIds: number[] = prevRows.map((r: any) => Number(r.productId));
            const delta = computeItemDelta(oldIds, productIds);

            await (conn as any).query(
                `DELETE FROM BasketTemplateItem WHERE templateId = ?`,
                [existing.id],
            );
            await insertTemplateItemsBatch(existing.id, items, conn as any);
            // Persist the delta — the client surfaces the "šablonas
            // atnaujintas" nudge once when delta > 3 and acks it via
            // PATCH, which clears the counter back to NULL.
            await (conn as any).query(
                `UPDATE BasketTemplate
                    SET updatedAt = NOW(),
                        lastAutoUpdateDelta = ?,
                        lastAutoUpdateAt = NOW()
                  WHERE id = ?`,
                [delta, existing.id],
            );
            await conn.commit();
            return { action: 'updated', templateId: existing.id, itemCount: items.length, delta };
        }

        const templateId = await createTemplate(
            userId,
            'Smart template',
            { isDefault: true, autoUpdate: true },
            conn as any,
        );
        await insertTemplateItemsBatch(templateId, items, conn as any);
        await conn.commit();
        return { action: 'created', templateId, itemCount: items.length };
    } catch (e) {
        try { await conn.rollback(); } catch {}
        throw e;
    } finally {
        conn.release();
    }
}

/**
 * The "Build it" action — explicitly creates (or rebuilds) the user's default
 * template from their receipts. Distinct from the receipt-save trigger, which
 * only refreshes an already-built template when learning is on.
 */
export const buildDefaultTemplate = (userId: string): Promise<GenerateResult> =>
    generateDefaultTemplate(userId, { allowCreate: true });
