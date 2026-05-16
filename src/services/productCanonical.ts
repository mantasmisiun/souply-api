import pool from '../config/db.js';
import { canonicalize, type CanonicalMeta } from './canonicalUnit.js';

/**
 * SP metadata used by the canonical-unit calculation and by tier-4
 * cross-chain averaging in the basket calc service. Also the input to
 * `computeCanonicalByProduct`, which derives a Product's canonical unit
 * (display unit + smallest pack size + outlier list) for the amount
 * picker UI and the per-total cheapest math.
 *
 * Stored separately from the basket calc service so the productModel
 * browse / detail endpoints can attach canonical fields to Product
 * responses without pulling in calc-specific code.
 */
export interface SpMetaRow {
    id: number;
    productId: number;
    amount: number | string | null;
    unit: string | null;
    isWeighable: number | boolean;
}

/**
 * One batched query for every SP across all chains belonging to the given
 * Products. Used to derive canonical-unit metadata; the canonical
 * decision must see every SP of the Product (not just the ones at nearby
 * stores) so the same Product always resolves the same canonical unit
 * regardless of the user's location.
 */
export async function fetchAllSpMetadata(productIds: number[]): Promise<Map<number, SpMetaRow[]>> {
    const result = new Map<number, SpMetaRow[]>();
    if (!productIds.length) return result;
    const [rows]: any = await pool.query(
        `SELECT id, productId, amount, unit, isWeighable
           FROM StoreProduct
          WHERE productId IN (?)`,
        [productIds],
    );
    for (const row of rows as any[]) {
        const pid = Number(row.productId);
        const list = result.get(pid) ?? [];
        list.push({
            id: Number(row.id),
            productId: pid,
            amount: row.amount,
            unit: row.unit,
            isWeighable: row.isWeighable,
        });
        result.set(pid, list);
    }
    return result;
}

export function computeCanonicalByProduct(
    spDataByProduct: Map<number, SpMetaRow[]>,
): Map<number, CanonicalMeta | null> {
    const result = new Map<number, CanonicalMeta | null>();
    for (const [pid, sps] of spDataByProduct.entries()) {
        result.set(pid, canonicalize(sps));
    }
    return result;
}

/**
 * Convenience: load + compute in one call. Use this when you just need
 * the canonical map and don't care about the raw SP rows.
 */
export async function loadCanonicalsForProducts(
    productIds: number[],
): Promise<Map<number, CanonicalMeta | null>> {
    const spData = await fetchAllSpMetadata(productIds);
    return computeCanonicalByProduct(spData);
}

/**
 * Attach canonical fields (`canonicalUnit`, `canonicalStep`,
 * `canonicalFamily`) to each Product-like row in-place. Rows with no
 * matched canonical (no SPs at all) get null fields — the client must
 * treat null canonicals as "fall back to legacy behaviour".
 *
 * Returns the same array for chaining.
 */
export function attachCanonicalFields<T extends { id: number | string }>(
    rows: T[],
    canonicals: Map<number, CanonicalMeta | null>,
): (T & { canonicalUnit: string | null; canonicalStep: number | null; canonicalFamily: string | null })[] {
    return rows.map(r => {
        const meta = canonicals.get(Number(r.id)) ?? null;
        return {
            ...r,
            canonicalUnit: meta?.unit ?? null,
            canonicalStep: meta?.step ?? null,
            canonicalFamily: meta?.family ?? null,
        };
    });
}
