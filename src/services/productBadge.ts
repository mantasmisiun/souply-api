import pool from '../config/db.js';

/**
 * Cheapest per-unit price badge for browse / search product cards.
 *
 * For every Product in a list, find the cheapest CURRENT per-unit price
 * across its StoreProducts and return one display-ready badge:
 *   { unitPrice, unit: 'kg' | 'l' | 'vnt', chainId, logoUrl, showLogo }
 *
 * Unit-family rules (agreed 2026-07-15):
 * - g/kg normalise to €/kg, ml/l to €/l, vnt to €/vnt.
 * - An SP with no unit (or an unrecognised one) counts as vnt; a missing/zero
 *   amount counts as 1 vnt. In weight/volume families a missing amount makes
 *   the SP incomputable → that SP is skipped (never guess a pack size).
 * - Weight or volume beats vnt: when a weight (or volume) option exists,
 *   vnt-only options are excluded from the comparison.
 * - Weight AND volume both present → NO badge (kg vs l is incomparable).
 * - A single-SP product always shows its own per-unit price (any family).
 * - The chain logo is shown only when the product has more than one SP.
 *
 * Price: the latest Price row per StoreProduct; a live promo (promoEnd null
 * or in the future) replaces the regular price. SPs without any price row
 * (or price <= 0) are excluded; a product with no priced SPs gets no badge.
 */

export interface UnitPriceBadge {
    unitPrice: number;
    unit: 'kg' | 'l' | 'vnt';
    chainId: number;
    logoUrl: string | null;
    showLogo: boolean;
}

type Family = 'w' | 'v' | 'u';

const familyOf = (unit: string | null): Family =>
    unit === 'g' || unit === 'kg' ? 'w'
    : unit === 'ml' || unit === 'l' ? 'v'
    : 'u';

/** Amount in the family's base unit (kg / l / vnt); null = incomputable. */
const baseAmountOf = (family: Family, unit: string | null, amount: number): number | null => {
    if (family === 'u') return amount > 0 ? amount : 1;
    if (!(amount > 0)) return null;
    return unit === 'g' || unit === 'ml' ? amount / 1000 : amount;
};

const FAMILY_LABEL: Record<Family, 'kg' | 'l' | 'vnt'> = { w: 'kg', v: 'l', u: 'vnt' };

export async function computeUnitPriceBadges(
    productIds: number[],
): Promise<Map<number, UnitPriceBadge>> {
    const badges = new Map<number, UnitPriceBadge>();
    if (!productIds.length) return badges;

    const [spRows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.chainId, sp.amount, sp.unit, sc.miniLogoUrl
           FROM StoreProduct sp
           JOIN StoreChain sc ON sc.id = sp.chainId
          WHERE sp.productId IN (?)`,
        [productIds],
    );
    if (!spRows.length) return badges;

    const spIds = (spRows as any[]).map(r => Number(r.id));
    const [priceRows]: any = await pool.query(
        `SELECT pr.storeProductId, pr.price, pr.promoPrice, pr.promoEnd
           FROM Price pr
          WHERE pr.storeProductId IN (?)
            AND pr.id = (SELECT MAX(pr2.id) FROM Price pr2
                          WHERE pr2.storeProductId = pr.storeProductId)`,
        [spIds],
    );
    const now = Date.now();
    const priceBySp = new Map<number, number>();
    for (const row of priceRows as any[]) {
        const promoActive = row.promoPrice != null &&
            (row.promoEnd == null || new Date(row.promoEnd).getTime() >= now);
        const eff = promoActive ? parseFloat(row.promoPrice) : parseFloat(row.price);
        if (Number.isFinite(eff) && eff > 0) priceBySp.set(Number(row.storeProductId), eff);
    }

    type Candidate = { family: Family; perUnit: number; chainId: number; logoUrl: string | null };
    const byProduct = new Map<number, { spCount: number; candidates: Candidate[] }>();
    for (const row of spRows as any[]) {
        const pid = Number(row.productId);
        const entry = byProduct.get(pid) ?? { spCount: 0, candidates: [] };
        entry.spCount += 1;
        const eff = priceBySp.get(Number(row.id));
        if (eff != null) {
            const family = familyOf(row.unit ?? null);
            const base = baseAmountOf(family, row.unit ?? null, parseFloat(row.amount));
            if (base != null) {
                entry.candidates.push({
                    family,
                    perUnit: eff / base,
                    chainId: Number(row.chainId),
                    logoUrl: row.miniLogoUrl ?? null,
                });
            }
        }
        byProduct.set(pid, entry);
    }

    for (const [pid, { spCount, candidates }] of byProduct.entries()) {
        if (!candidates.length) continue;
        const hasW = candidates.some(c => c.family === 'w');
        const hasV = candidates.some(c => c.family === 'v');
        if (hasW && hasV) continue; // kg vs l — incomparable, no badge
        const preferred: Family = hasW ? 'w' : hasV ? 'v' : 'u';
        const pool_ = candidates.filter(c => c.family === preferred);
        const best = pool_.reduce((a, b) => (b.perUnit < a.perUnit ? b : a));
        badges.set(pid, {
            unitPrice: Math.round(best.perUnit * 100) / 100,
            unit: FAMILY_LABEL[preferred],
            chainId: best.chainId,
            logoUrl: best.logoUrl,
            showLogo: spCount > 1,
        });
    }
    return badges;
}

/** Attach `badge` (or null) to each Product-like row in a list response. */
export async function attachUnitPriceBadges<T extends { id: number | string }>(
    rows: T[],
): Promise<(T & { badge: UnitPriceBadge | null })[]> {
    const badges = await computeUnitPriceBadges(rows.map(r => Number(r.id)));
    return rows.map(r => ({ ...r, badge: badges.get(Number(r.id)) ?? null }));
}
