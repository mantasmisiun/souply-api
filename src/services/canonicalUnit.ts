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
    /** True when this SP is sold by weight at the deli counter (not in
     *  fixed packs). The presence of any weighable SP in the dominant
     *  family overrides the pack-derived step down to 0.1 — the deli
     *  granularity — so the picker can ask for arbitrary weights. */
    isWeighable?: number | boolean | null;
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
    // Fluid-origin SP in a count/vnt canonical: canonicalize() reclassified
    // this single-size non-weighable product from fluid to vnt. One physical
    // pack counts as 1 unit regardless of its weight.
    if (canonical.family === 'count' && canonical.unit === 'vnt' && unitFamily(spUnit) === 'fluid') {
        return 1;
    }
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

    // Step computation walks the in-family SPs and looks at their canonical
    // amounts. Used both as the smallest-pack baseline and to count how
    // many distinct pack sizes exist (single-pack vs multi-pack drives
    // different UX rules below).
    let step = Infinity;
    const distinctCanonAmounts = new Set<number>();
    for (const sp of inFamilySps) {
        const amt = sp.amount == null ? null : parseFloat(String(sp.amount));
        if (amt === null || !Number.isFinite(amt) || amt <= 0) continue;
        const canonAmt = dominantFamily === 'fluid'
            ? toFluidBase(amt, sp.unit!)
            : amt;
        if (canonAmt < step) step = canonAmt;
        // Round to 3 decimals before set-keying so 0.330000001 and 0.33
        // count as one. Pack sizes in this catalogue never need finer.
        distinctCanonAmounts.add(Math.round(canonAmt * 1000) / 1000);
    }
    if (!Number.isFinite(step)) step = 1;

    // Weighable override: when ANY in-family SP is sold by weight, the
    // picker should step in deli-counter granularity (0.1 kg/l), not in
    // whatever pack size a co-clustered pre-packed SP carries. The
    // basket calc service already prices weighable items by exact
    // quantity (no pack rounding), so this only widens the user's
    // freedom of choice on the UI side. Restricted to the fluid family
    // — 0.1 doesn't make sense for count units (vnt / pak / rit).
    if (dominantFamily === 'fluid' && inFamilySps.some(sp => !!sp.isWeighable)) {
        step = Math.min(step, 0.1);
    } else if (dominantFamily === 'fluid' && distinctCanonAmounts.size > 1) {
        // Multi-pack fluid (e.g. Pepsi with 0.33 / 0.5 / 1 / 1.5 L SPs):
        // stepping by the smallest pack (0.33) gives the picker
        // confusing increments (0.33, 0.66, 0.99…). Widen to a
        // shopping-friendly 0.5L step. Single-pack-only Products keep
        // their actual pack size — they have no flexibility, so the
        // step must equal what's buyable. The basket calc continues to
        // pick the cheapest combination of SPs regardless of step, so
        // the picker step is purely a UX choice here.
        step = Math.max(step, 0.5);
    }

    // Single-size non-weighable fluid product (e.g. a 36g tea bag, a 330ml
    // can with one SP): the kg/l unit is meaningless — users think in packs,
    // not kilograms. Reclassify to count so the picker shows "1 vnt" instead
    // of "0.0 kg". Multi-size products and anything weighable keep fluid.
    if (
        dominantFamily === 'fluid' &&
        !inFamilySps.some(sp => !!sp.isWeighable) &&
        distinctCanonAmounts.size <= 1
    ) {
        return {
            family: 'count',
            unit: 'vnt',
            step: 1,
            inFamilySpIds: new Set(inFamilySps.map(s => s.id)),
            outlierSpIds,
        };
    }

    return {
        family: dominantFamily,
        unit: canonicalUnit,
        step,
        inFamilySpIds: new Set(inFamilySps.map(s => s.id)),
        outlierSpIds,
    };
}
