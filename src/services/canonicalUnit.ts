/**
 * Canonical-unit resolution for a Product.
 *
 * A Product clusters one or more StoreProducts (SPs). Different chains may
 * record the same product in different units (e.g. milk listed as `l` at
 * one chain, `ml` at another), and occasionally an SP slips in with a
 * fundamentally different unit family (a `vnt` row in a Product whose
 * other SPs are all weighable kg). We need:
 *
 *   1. A single canonical display unit per Product (kg, l, vnt, pak, rit)
 *      so the amount picker UI and the basket math agree. We never show
 *      g or ml to the user — those are normalised to kg / l (÷1000).
 *   2. A canonical step size — the smallest in-family pack — so the
 *      amount picker increments without producing un-buyable values.
 *   3. A list of "outlier" SP ids (those whose unit family doesn't match
 *      the canonical) so the admin amounts queue can prioritise them
 *      for cleanup.
 *
 * Transitional simplification (documented + approved): kg and l are
 * treated as equivalent (and likewise g and ml). The vast majority of
 * grocery items where this matters are water-based (milk, juice, yogurt,
 * cleaning liquids, etc.) where density ≈ 1, so a 1L SP can substitute
 * for a 1kg SP without meaningful price distortion. Where this is wrong
 * (e.g. flour: 1L bag ≠ 1kg bag), the admin queue / data cleanup is the
 * correct fix; we do NOT silently apply per-product densities.
 *
 * Within the `count` family (vnt, pak, rit), sub-units are NOT
 * exchangeable: a Product with both `vnt` and `pak` rows is genuinely
 * mis-clustered. Majority wins, minority becomes an outlier.
 */

export type UnitFamily = 'fluid' | 'count';
export type CanonicalUnit = 'kg' | 'l' | 'vnt' | 'pak' | 'rit';

const FLUID_UNITS = new Set(['kg', 'g', 'l', 'ml']);
const COUNT_UNITS = new Set(['vnt', 'pak', 'rit']);

/** Tie-break order within the count family — vnt is the most granular and
 *  most common in the LT grocery catalogue. */
const COUNT_PRIORITY: CanonicalUnit[] = ['vnt', 'pak', 'rit'];

export interface SpUnitInput {
    id: number;
    amount: number | string | null;
    unit: string | null;
}

export interface CanonicalMeta {
    /** Dominant family across the Product's SPs. */
    family: UnitFamily;
    /** Display unit shown to the user. Never `g` or `ml`. */
    unit: CanonicalUnit;
    /** Smallest in-family SP amount in canonical units (e.g. 0.5 for a
     *  Product whose smallest SP is 500ml when canonical is `l`). Falls
     *  back to 1 when no in-family SP has a positive amount. */
    step: number;
    /** SP ids in the dominant family (and dominant sub-unit for count). */
    inFamilySpIds: Set<number>;
    /** SP ids in a different family or different count sub-unit — should
     *  be surfaced to the admin amounts queue. */
    outlierSpIds: number[];
}

export function unitFamily(unit: string | null | undefined): UnitFamily | null {
    if (!unit) return null;
    const u = unit.toLowerCase();
    if (FLUID_UNITS.has(u)) return 'fluid';
    if (COUNT_UNITS.has(u)) return 'count';
    return null;
}

/**
 * Convert an SP's amount into the fluid-family base scale where 1 kg
 * = 1 l = 1 base unit. g and ml are ÷1000.
 *
 * Caller is responsible for ensuring `unit` is in the fluid family.
 */
export function toFluidBase(amount: number, unit: string): number {
    const u = unit.toLowerCase();
    if (u === 'g' || u === 'ml') return amount / 1000;
    return amount; // kg, l — already in base scale
}

/**
 * Normalise an SP's amount to the canonical unit. Returns null if the SP
 * is incompatible with the canonical (different family, or different
 * count sub-unit) — caller should treat as an outlier.
 */
export function toCanonicalAmount(
    spAmount: number,
    spUnit: string,
    canonical: CanonicalMeta,
): number | null {
    const fam = unitFamily(spUnit);
    if (fam !== canonical.family) return null;
    if (canonical.family === 'fluid') return toFluidBase(spAmount, spUnit);
    // count: sub-unit must match exactly (no vnt → pak conversion)
    if (spUnit.toLowerCase() !== canonical.unit) return null;
    return spAmount;
}

/**
 * Compute the canonical metadata for a Product given its SPs.
 *
 * Returns `null` only when no SP has a known unit (every row is in an
 * unrecognised unit, e.g. blank or some garbage string from a bad scrape).
 * That case should never happen in practice — defensive null return.
 */
export function canonicalize(sps: SpUnitInput[]): CanonicalMeta | null {
    if (!sps.length) return null;

    // Bucket SPs by family. Anything with an unknown unit is an outlier
    // up-front.
    const byFamily = new Map<UnitFamily, SpUnitInput[]>();
    const orphans: number[] = [];
    for (const sp of sps) {
        const fam = unitFamily(sp.unit);
        if (!fam) { orphans.push(sp.id); continue; }
        const list = byFamily.get(fam) ?? [];
        list.push(sp);
        byFamily.set(fam, list);
    }

    // Dominant family by SP count (ties broken by 'fluid' first, which is
    // the more common case in grocery and the one with sub-unit fungibility).
    let dominantFamily: UnitFamily | null = null;
    let dominantSize = 0;
    for (const [fam, list] of byFamily.entries()) {
        if (list.length > dominantSize || (list.length === dominantSize && fam === 'fluid')) {
            dominantFamily = fam;
            dominantSize = list.length;
        }
    }
    if (!dominantFamily) return null;

    const dominantSps = byFamily.get(dominantFamily)!;
    const outlierSpIds: number[] = [...orphans];
    for (const [fam, list] of byFamily.entries()) {
        if (fam !== dominantFamily) outlierSpIds.push(...list.map(s => s.id));
    }

    // Pick canonical unit within the dominant family.
    let canonicalUnit: CanonicalUnit;
    let inFamilySps: SpUnitInput[];

    if (dominantFamily === 'fluid') {
        // Count votes per display unit (kg vs l). g maps to kg, ml maps
        // to l. Tie → kg (the more common grocery dimension overall).
        let kgVotes = 0;
        let lVotes = 0;
        for (const sp of dominantSps) {
            const u = (sp.unit ?? '').toLowerCase();
            if (u === 'kg' || u === 'g') kgVotes++;
            else if (u === 'l' || u === 'ml') lVotes++;
        }
        canonicalUnit = lVotes > kgVotes ? 'l' : 'kg';
        // All fluid SPs are in-family — kg ≈ l per the transitional
        // simplification documented at the top of this file.
        inFamilySps = dominantSps;
    } else {
        // count: bucket by exact sub-unit; majority wins. Tie → priority
        // order (vnt > pak > rit). Other sub-units become outliers.
        const votes = new Map<CanonicalUnit, SpUnitInput[]>();
        for (const sp of dominantSps) {
            const u = (sp.unit ?? '').toLowerCase() as CanonicalUnit;
            const list = votes.get(u) ?? [];
            list.push(sp);
            votes.set(u, list);
        }
        let bestUnit: CanonicalUnit = COUNT_PRIORITY[0];
        let bestCount = -1;
        for (const candidate of COUNT_PRIORITY) {
            const list = votes.get(candidate);
            if (list && list.length > bestCount) {
                bestUnit = candidate;
                bestCount = list.length;
            }
        }
        canonicalUnit = bestUnit;
        inFamilySps = votes.get(bestUnit) ?? [];
        for (const [unit, list] of votes.entries()) {
            if (unit !== bestUnit) outlierSpIds.push(...list.map(s => s.id));
        }
    }

    // Step = smallest in-family SP amount in canonical units. Ignore
    // null/non-positive amounts (degenerate rows from bad scrapes).
    let step = Infinity;
    for (const sp of inFamilySps) {
        const amt = sp.amount == null ? null : parseFloat(String(sp.amount));
        if (amt === null || !Number.isFinite(amt) || amt <= 0) continue;
        const canonAmt = dominantFamily === 'fluid'
            ? toFluidBase(amt, sp.unit!)
            : amt;
        if (canonAmt < step) step = canonAmt;
    }
    if (!Number.isFinite(step)) step = 1;

    return {
        family: dominantFamily,
        unit: canonicalUnit,
        step,
        inFamilySpIds: new Set(inFamilySps.map(s => s.id)),
        outlierSpIds,
    };
}
