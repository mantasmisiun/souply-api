import {
    unitFamily,
    toFluidBase,
    toCanonicalAmount,
    canonicalize,
    type SpUnitInput,
} from '../src/services/canonicalUnit.js';

describe('unitFamily', () => {
    it('recognises fluid units (kg, g, l, ml) case-insensitively', () => {
        expect(unitFamily('kg')).toBe('fluid');
        expect(unitFamily('KG')).toBe('fluid');
        expect(unitFamily('g')).toBe('fluid');
        expect(unitFamily('l')).toBe('fluid');
        expect(unitFamily('ml')).toBe('fluid');
        expect(unitFamily('Ml')).toBe('fluid');
    });

    it('recognises count units (vnt, pak, rit)', () => {
        expect(unitFamily('vnt')).toBe('count');
        expect(unitFamily('pak')).toBe('count');
        expect(unitFamily('rit')).toBe('count');
    });

    it('returns null for unknown / empty / nullish units', () => {
        expect(unitFamily(null)).toBeNull();
        expect(unitFamily(undefined)).toBeNull();
        expect(unitFamily('')).toBeNull();
        expect(unitFamily('oz')).toBeNull();
        expect(unitFamily('xx')).toBeNull();
    });
});

describe('toFluidBase', () => {
    it('passes kg through unchanged', () => {
        expect(toFluidBase(1.5, 'kg')).toBe(1.5);
    });
    it('passes l through unchanged', () => {
        expect(toFluidBase(2, 'l')).toBe(2);
    });
    it('divides g by 1000', () => {
        expect(toFluidBase(500, 'g')).toBe(0.5);
    });
    it('divides ml by 1000', () => {
        expect(toFluidBase(750, 'ml')).toBe(0.75);
    });
    it('is case-insensitive', () => {
        expect(toFluidBase(500, 'G')).toBe(0.5);
        expect(toFluidBase(500, 'ML')).toBe(0.5);
    });
});

describe('canonicalize — empty / invalid inputs', () => {
    it('returns null for empty input', () => {
        expect(canonicalize([])).toBeNull();
    });

    it('returns null when every SP has an unknown unit', () => {
        const sps: SpUnitInput[] = [
            { id: 1, amount: 1, unit: 'oz' },
            { id: 2, amount: 1, unit: null },
        ];
        expect(canonicalize(sps)).toBeNull();
    });

    it('collects unknown-unit SPs as outliers when there are other valid ones', () => {
        // Two distinct fluid sizes keep this a fluid canonical (a single-size
        // fluid SP would reclassify to a vnt pack); the oz row is the outlier.
        const sps: SpUnitInput[] = [
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 2, unit: 'kg' },
            { id: 3, amount: 1, unit: 'oz' },
        ];
        const meta = canonicalize(sps)!;
        expect(meta.family).toBe('fluid');
        expect(meta.outlierSpIds).toContain(3);
        expect(meta.inFamilySpIds.has(1)).toBe(true);
        expect(meta.inFamilySpIds.has(3)).toBe(false);
    });
});

describe('canonicalize — fluid family', () => {
    it('single-size non-weighable kg SP → reclassified to a vnt pack', () => {
        // A lone fixed-size fluid SP is meaningless as "0.0 kg" in the picker;
        // it is reclassified to "1 vnt" (one pack). Weighable or multi-size
        // fluid products stay kg/l (covered below).
        const meta = canonicalize([{ id: 1, amount: 1, unit: 'kg' }])!;
        expect(meta.family).toBe('count');
        expect(meta.unit).toBe('vnt');
        expect(meta.step).toBe(1);
        expect(meta.outlierSpIds).toEqual([]);
    });

    it('weighable single kg SP stays fluid kg', () => {
        const meta = canonicalize([{ id: 1, amount: 1, unit: 'kg', isWeighable: true }])!;
        expect(meta.family).toBe('fluid');
        expect(meta.unit).toBe('kg');
    });

    it('multi-size l SPs → canonical l', () => {
        const meta = canonicalize([
            { id: 1, amount: 0.5, unit: 'l' },
            { id: 2, amount: 1.5, unit: 'l' },
        ])!;
        expect(meta.family).toBe('fluid');
        expect(meta.unit).toBe('l');
        expect(meta.step).toBe(0.5);
    });

    it('g is normalised to kg for step', () => {
        // 500g should appear as 0.5 in canonical kg
        const meta = canonicalize([
            { id: 1, amount: 500, unit: 'g' },
            { id: 2, amount: 1, unit: 'kg' },
        ])!;
        expect(meta.unit).toBe('kg');
        expect(meta.step).toBeCloseTo(0.5);
    });

    it('ml is normalised to l for step', () => {
        const meta = canonicalize([
            { id: 1, amount: 500, unit: 'ml' },
            { id: 2, amount: 1, unit: 'l' },
            { id: 3, amount: 2, unit: 'l' },
        ])!;
        expect(meta.unit).toBe('l');
        expect(meta.step).toBeCloseTo(0.5);
    });

    it('mixed kg + l → all fluid, canonical = majority unit', () => {
        // 2 kg-style + 1 l-style → kg wins
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 500, unit: 'g' },
            { id: 3, amount: 1, unit: 'l' },
        ])!;
        expect(meta.family).toBe('fluid');
        expect(meta.unit).toBe('kg');
        // all three are in-family (kg ≈ l transitional simplification)
        expect(meta.inFamilySpIds.size).toBe(3);
        expect(meta.outlierSpIds).toEqual([]);
    });

    it('tie kg vs l → kg wins', () => {
        // Distinct sizes keep it fluid (so it is not reclassified to a vnt pack).
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 2, unit: 'l' },
        ])!;
        expect(meta.family).toBe('fluid');
        expect(meta.unit).toBe('kg');
    });

    it('majority l → canonical l', () => {
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'l' },
            { id: 2, amount: 500, unit: 'ml' },
            { id: 3, amount: 1, unit: 'kg' },
        ])!;
        expect(meta.unit).toBe('l');
        expect(meta.step).toBeCloseTo(0.5);
    });

    it('ignores zero / negative / NaN amounts when computing step', () => {
        const meta = canonicalize([
            { id: 1, amount: 0, unit: 'kg' },
            { id: 2, amount: -1, unit: 'kg' },
            { id: 3, amount: 1, unit: 'kg' },
        ])!;
        expect(meta.step).toBe(1);
    });

    it('falls back to step=1 when no in-family SP has a positive amount', () => {
        const meta = canonicalize([
            { id: 1, amount: 0, unit: 'kg' },
            { id: 2, amount: null, unit: 'kg' },
        ])!;
        expect(meta.step).toBe(1);
    });
});

describe('canonicalize — count family', () => {
    it('single vnt SP → canonical vnt', () => {
        const meta = canonicalize([{ id: 1, amount: 10, unit: 'vnt' }])!;
        expect(meta.family).toBe('count');
        expect(meta.unit).toBe('vnt');
        expect(meta.step).toBe(10);
    });

    it('majority vnt → vnt; pak rows become outliers', () => {
        const meta = canonicalize([
            { id: 1, amount: 10, unit: 'vnt' },
            { id: 2, amount: 12, unit: 'vnt' },
            { id: 3, amount: 1, unit: 'pak' },
        ])!;
        expect(meta.unit).toBe('vnt');
        expect(meta.inFamilySpIds.has(1)).toBe(true);
        expect(meta.inFamilySpIds.has(2)).toBe(true);
        expect(meta.outlierSpIds).toContain(3);
    });

    it('majority pak → pak; vnt rows become outliers', () => {
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'pak' },
            { id: 2, amount: 1, unit: 'pak' },
            { id: 3, amount: 10, unit: 'vnt' },
        ])!;
        expect(meta.unit).toBe('pak');
        expect(meta.outlierSpIds).toContain(3);
    });

    it('tie vnt vs pak → vnt (priority)', () => {
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'vnt' },
            { id: 2, amount: 1, unit: 'pak' },
        ])!;
        expect(meta.unit).toBe('vnt');
        expect(meta.outlierSpIds).toEqual([2]);
    });

    it('step = smallest in-family count amount', () => {
        const meta = canonicalize([
            { id: 1, amount: 30, unit: 'vnt' },
            { id: 2, amount: 12, unit: 'vnt' },
            { id: 3, amount: 10, unit: 'vnt' },
        ])!;
        expect(meta.step).toBe(10);
    });
});

describe('canonicalize — mixed family', () => {
    it('majority fluid → fluid; count rows are outliers', () => {
        // 2 fluid + 1 count → fluid wins; the vnt SP is the outlier
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 500, unit: 'g' },
            { id: 3, amount: 1, unit: 'vnt' },
        ])!;
        expect(meta.family).toBe('fluid');
        expect(meta.outlierSpIds).toEqual([3]);
        expect(meta.inFamilySpIds.has(1)).toBe(true);
        expect(meta.inFamilySpIds.has(2)).toBe(true);
        expect(meta.inFamilySpIds.has(3)).toBe(false);
    });

    it('majority count → count; fluid rows are outliers', () => {
        const meta = canonicalize([
            { id: 1, amount: 10, unit: 'vnt' },
            { id: 2, amount: 12, unit: 'vnt' },
            { id: 3, amount: 1, unit: 'kg' },
        ])!;
        expect(meta.family).toBe('count');
        expect(meta.outlierSpIds).toEqual([3]);
    });

    it('tie 2 fluid vs 2 count → fluid wins (tie-break)', () => {
        // Distinct fluid sizes keep the fluid winner from being reclassified
        // to a vnt pack.
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 2, unit: 'l' },
            { id: 3, amount: 1, unit: 'vnt' },
            { id: 4, amount: 1, unit: 'vnt' },
        ])!;
        expect(meta.family).toBe('fluid');
        // both vnt rows are outliers
        expect(meta.outlierSpIds.sort()).toEqual([3, 4]);
    });
});

describe('toCanonicalAmount', () => {
    it('returns null when SP family mismatches canonical family', () => {
        // Multi-size fluid → genuine kg canonical (a single-size SP would
        // reclassify to a vnt pack, which would change this assertion).
        const meta = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 2, unit: 'kg' },
        ])!;
        expect(meta.family).toBe('fluid');
        expect(toCanonicalAmount(1, 'vnt', meta)).toBeNull();
    });

    it('returns null when count sub-unit mismatches canonical sub-unit', () => {
        const meta = canonicalize([{ id: 1, amount: 10, unit: 'vnt' }])!;
        expect(toCanonicalAmount(1, 'pak', meta)).toBeNull();
    });

    it('fluid: converts g/ml correctly into canonical base', () => {
        const metaKg = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 2, unit: 'kg' },
        ])!;
        expect(metaKg.family).toBe('fluid');
        expect(toCanonicalAmount(500, 'g', metaKg)).toBeCloseTo(0.5);
        expect(toCanonicalAmount(500, 'ml', metaKg)).toBeCloseTo(0.5);
        // kg ≈ l per the transitional simplification: an l SP under a kg
        // canonical resolves cleanly.
        expect(toCanonicalAmount(2, 'l', metaKg)).toBe(2);
    });

    it('count: returns the original amount when sub-unit matches', () => {
        const meta = canonicalize([{ id: 1, amount: 10, unit: 'vnt' }])!;
        expect(toCanonicalAmount(30, 'vnt', meta)).toBe(30);
    });
});
