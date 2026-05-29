/**
 * Auto-generated default template — Pass A.3 of the šablonai roadmap.
 *
 * Per Documentation/roadmap/sablonai.md Part 2:
 *
 *   • Triggered once the user uploads their 3rd receipt across ≥ 2 distinct
 *     chains (same threshold as account recovery, so onboarding doubles as
 *     recovery without ever mentioning it).
 *   • Picks products the user actually engages with (basket adds / list
 *     adds / list checks) using the existing `UserProductScore` table.
 *   • For users with limited history, falls back to globally popular
 *     products to avoid an empty template.
 *   • Re-runs on every subsequent receipt upload for templates with
 *     `autoUpdate = 1`.
 *
 * The pure decision functions are kept side-effect-free so they can be
 * unit-tested without touching the DB. The orchestrator at the bottom
 * is the integration glue.
 */

import pool from '../config/db.js';
import {
    createTemplate,
    insertTemplateItemsBatch,
    type TemplateItemInput,
} from '../models/basketTemplateModel.js';

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

export interface UserProductSignal {
    productId: number;
    score: number;
    interactionCount: number;
}

/**
 * Pick the products for the default template.
 *
 * Inclusion rules (Pass A.3 v1 — simplified vs. spec's "≥2 receipt sessions"
 * because ProductInteraction events don't carry receipt IDs; we approximate
 * with interactionCount):
 *
 *   • interactionCount ≥ 2 → always include (user engaged with this product
 *     more than once → habitual)
 *   • interactionCount = 1 AND product is in the global top-10% popular set
 *     → include (one-off engagement with a universally bought item, e.g.
 *     monthly toilet paper — covers the spec's bulk-buyer carve-out)
 *
 * Capped at MAX_ITEMS to keep the template usable as a quick-shop list
 * rather than a dump of everything the user ever bought.
 */
export const MAX_ITEMS = 25;

export function selectDefaultTemplateProducts(
    signals: UserProductSignal[],
    globalTopSet: Set<number>,
): number[] {
    const eligible = signals
        .filter(s => {
            if (s.score <= 0) return false;
            if (s.interactionCount >= 2) return true;
            if (s.interactionCount === 1 && globalTopSet.has(s.productId)) return true;
            return false;
        })
        // Highest user-engagement score first. Ties broken by interactionCount
        // (more touches = more confident inclusion).
        .sort((a, b) => (b.score - a.score) || (b.interactionCount - a.interactionCount));

    return eligible.slice(0, MAX_ITEMS).map(s => s.productId);
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

/**
 * Run the qualification check, pick products, and either create a new
 * default template or refresh the existing one's items wholesale. Wholesale
 * replace (vs. diff) is acceptable for v1 because the only "edits" between
 * runs are user-driven manual additions/removals, and the spec defines
 * `autoUpdate=1` as "trust the algorithm" anyway. Diff-based merging
 * with pinned items lands in a future pass.
 */
export async function generateDefaultTemplate(userId: string): Promise<GenerateResult> {
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
    if (existing && existing.autoUpdate === 0) {
        return { action: 'skipped', reason: 'autoupdate-off' };
    }

    // 3. Read the user's per-product engagement signal
    const [signalRows]: any = await pool.query(
        `SELECT productId, score, interactionCount
           FROM UserProductScore
          WHERE userId = ? AND score > 0`,
        [userId],
    );
    const signals: UserProductSignal[] = signalRows.map((r: any) => ({
        productId: Number(r.productId),
        score: Number(r.score),
        interactionCount: Number(r.interactionCount),
    }));

    // 4. Compute the global top-10% set for the bulk-buyer carve-out
    const globalTopSet = await loadGlobalTop10PercentSet();

    // 5. Pick the products
    const productIds = selectDefaultTemplateProducts(signals, globalTopSet);
    if (productIds.length === 0) {
        return { action: 'skipped', reason: 'no-eligible-products' };
    }

    const items: TemplateItemInput[] = productIds.map((productId, i) => ({
        productId,
        quantity: 1,
        sortOrder: i,
    }));

    // 6. Write
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
            'Pirkinių sąrašas',
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
 * Returns the set of productIds in the global top 10% by `Product.globalScore`.
 * `globalScore` is already the same decayed-sum-of-interaction-events the
 * šablonai spec calls `popularityScore`, so we can reuse it directly
 * instead of computing a parallel ranking.
 */
async function loadGlobalTop10PercentSet(): Promise<Set<number>> {
    const [rows]: any = await pool.query(
        `SELECT id FROM Product
          WHERE globalScore > 0
          ORDER BY globalScore DESC
          LIMIT 10000`,
    );
    // Strict top-10% within the universe of products that have any score
    // at all. For the bulk-buyer carve-out we want the universally-bought
    // staples — top 10% over scored products is the right denominator.
    const [[countRow]]: any = await pool.query(
        `SELECT COUNT(*) AS n FROM Product WHERE globalScore > 0`,
    );
    const total = Number(countRow?.n ?? 0);
    const cutoff = Math.max(1, Math.floor(total * 0.10));
    return new Set(rows.slice(0, cutoff).map((r: any) => Number(r.id)));
}
