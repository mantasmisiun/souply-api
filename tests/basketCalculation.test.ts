import {
    pickCheapest,
    pickCheapestForQuantity,
    priceItem,
    type SpRow,
} from '../src/services/basketCalculationService.js';
import { canonicalize } from '../src/services/canonicalUnit.js';

function makeSpRow(overrides: Partial<SpRow> & { price: string }): SpRow {
    return {
        id: 1,
        productId: 100,
        storeProductName: 'Test Product',
        isWeighable: false,
        amount: '1',
        unit: 'vnt',
        promoPrice: null,
        isFallback: false,
        ...overrides,
    };
}

const FLAGS_DIRECT = { isSubstituted: false, isCrossChainAverage: false };

// ---------------------------------------------------------------------------
// pickCheapest — legacy per-unit picker (retained for tier-3 substitute,
// single-row callers). Tier-1/2 now uses pickCheapestForQuantity.
// ---------------------------------------------------------------------------

describe('pickCheapest (legacy per-unit)', () => {
    it('returns null for empty array', () => {
        expect(pickCheapest([])).toBeNull();
    });

    it('returns null when all rows have null price', () => {
        const rows = [makeSpRow({ price: null as any })];
        expect(pickCheapest(rows)).toBeNull();
    });

    it('prefers promoPrice over regular price for effectivePrice', () => {
        const row = makeSpRow({ price: '3.00', promoPrice: '2.00' });
        const result = pickCheapest([row]);
        expect(result!.effectivePrice).toBeCloseTo(2.00);
    });

    it('picks cheapest per-unit (legacy)', () => {
        // 1.00 / 0.5 = 2.00 per unit vs 1.50 / 1 = 1.50 per unit
        const smallPack = makeSpRow({ id: 1, price: '1.00', amount: '0.5' });
        const largePack = makeSpRow({ id: 2, price: '1.50', amount: '1' });
        expect(pickCheapest([smallPack, largePack])!.id).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// pickCheapestForQuantity — per-total picker used by tier-1/2
// ---------------------------------------------------------------------------

describe('pickCheapestForQuantity — weighable', () => {
    it('picks cheapest per-canonical-unit when all SPs are in the same fluid family', () => {
        // SP1: 5.00 / kg. SP2: 3.50 / kg. User wants 1 kg.
        const sp1 = makeSpRow({ id: 1, price: '5.00', amount: '1', unit: 'kg', isWeighable: true });
        const sp2 = makeSpRow({ id: 2, price: '3.50', amount: '1', unit: 'kg', isWeighable: true });
        const canonical = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 1, unit: 'kg' },
        ])!;
        const result = pickCheapestForQuantity([sp1, sp2], 1, canonical);
        expect(result!.id).toBe(2);
    });

    it('normalises g to kg when picking cheapest', () => {
        // SP1: 100g for 0.20 → 2.00 / kg (after normalisation to canonical kg)
        // SP2: 1kg for 1.50  → 1.50 / kg
        const sp1 = makeSpRow({ id: 1, price: '0.20', amount: '100', unit: 'g', isWeighable: true });
        const sp2 = makeSpRow({ id: 2, price: '1.50', amount: '1', unit: 'kg', isWeighable: true });
        const canonical = canonicalize([
            { id: 1, amount: 100, unit: 'g' },
            { id: 2, amount: 1, unit: 'kg' },
        ])!;
        const result = pickCheapestForQuantity([sp1, sp2], 1, canonical);
        expect(result!.id).toBe(2);
    });
});

describe('pickCheapestForQuantity — non-weighable per-total semantics', () => {
    it('picks cheapest per-egg when quantity is large enough that pack-rounding waste is negligible', () => {
        // 10-pack at 1.00 (0.10/egg), 30-pack at 2.50 (0.083/egg). User wants 30.
        // 10-pack: ceil(30/10) = 3 × 1.00 = 3.00
        // 30-pack: ceil(30/30) = 1 × 2.50 = 2.50 ← wins
        const sp10 = makeSpRow({ id: 1, price: '1.00', amount: '10', unit: 'vnt', isWeighable: false });
        const sp30 = makeSpRow({ id: 2, price: '2.50', amount: '30', unit: 'vnt', isWeighable: false });
        const canonical = canonicalize([
            { id: 1, amount: 10, unit: 'vnt' },
            { id: 2, amount: 30, unit: 'vnt' },
        ])!;
        const result = pickCheapestForQuantity([sp10, sp30], 30, canonical);
        expect(result!.id).toBe(2);
    });

    it('picks smaller pack when per-unit cheaper SP would over-buy (the eggs/5 case)', () => {
        // The KEY test for the per-total fix.
        // 4-pack at 0.40 (0.10/each) vs 30-pack at 2.50 (0.083/each). User wants 5.
        // 4-pack: ceil(5/4) = 2 × 0.40 = 0.80 ← wins
        // 30-pack: ceil(5/30) = 1 × 2.50 = 2.50
        const sp4 = makeSpRow({ id: 1, price: '0.40', amount: '4', unit: 'vnt', isWeighable: false });
        const sp30 = makeSpRow({ id: 2, price: '2.50', amount: '30', unit: 'vnt', isWeighable: false });
        const canonical = canonicalize([
            { id: 1, amount: 4, unit: 'vnt' },
            { id: 2, amount: 30, unit: 'vnt' },
        ])!;
        const result = pickCheapestForQuantity([sp4, sp30], 5, canonical);
        expect(result!.id).toBe(1);
    });

    it('milk varying pack size: chooses cheapest total for the requested litres', () => {
        // 500ml at 0.60 (1.20 / L), 1L at 1.10, 2L at 2.00 (1.00 / L). User wants 2 L.
        // 500ml: ceil(2 / 0.5) = 4 × 0.60 = 2.40
        // 1L:    ceil(2 / 1)   = 2 × 1.10 = 2.20
        // 2L:    ceil(2 / 2)   = 1 × 2.00 = 2.00 ← wins
        const sp500 = makeSpRow({ id: 1, price: '0.60', amount: '500', unit: 'ml', isWeighable: false });
        const sp1L  = makeSpRow({ id: 2, price: '1.10', amount: '1', unit: 'l', isWeighable: false });
        const sp2L  = makeSpRow({ id: 3, price: '2.00', amount: '2', unit: 'l', isWeighable: false });
        const canonical = canonicalize([
            { id: 1, amount: 500, unit: 'ml' },
            { id: 2, amount: 1, unit: 'l' },
            { id: 3, amount: 2, unit: 'l' },
        ])!;
        const result = pickCheapestForQuantity([sp500, sp1L, sp2L], 2, canonical);
        expect(result!.id).toBe(3);
    });

    it('excludes outlier-family SPs from the candidate pool', () => {
        // Product is fluid-majority (2 fluid + 1 count). The count SP is an
        // outlier — must never win even if its raw price is lower.
        const fluid1 = makeSpRow({ id: 1, price: '2.00', amount: '1', unit: 'kg', isWeighable: false });
        const fluid2 = makeSpRow({ id: 2, price: '1.80', amount: '1', unit: 'kg', isWeighable: false });
        const outlier = makeSpRow({ id: 3, price: '0.50', amount: '1', unit: 'vnt', isWeighable: false });
        const canonical = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 1, unit: 'kg' },
            { id: 3, amount: 1, unit: 'vnt' },
        ])!;
        expect(canonical.outlierSpIds).toContain(3);
        const result = pickCheapestForQuantity([fluid1, fluid2, outlier], 1, canonical);
        expect(result!.id).toBe(2); // cheaper of the two in-family fluid SPs
    });

    it('falls back to all priced rows when canonical exists but no in-family SP is stocked here', () => {
        // Canonical says fluid; only an outlier SP is available at this store.
        // Rather than returning null, fall through to the outlier so the user
        // still sees *something* (better than a missing slot).
        const outlierOnly = makeSpRow({ id: 3, price: '0.50', amount: '1', unit: 'vnt', isWeighable: false });
        const canonical = canonicalize([
            { id: 1, amount: 1, unit: 'kg' },
            { id: 2, amount: 1, unit: 'kg' },
            { id: 3, amount: 1, unit: 'vnt' },
        ])!;
        const result = pickCheapestForQuantity([outlierOnly], 1, canonical);
        expect(result).not.toBeNull();
        expect(result!.id).toBe(3);
    });

    it('treats kg ≈ l within fluid family (transitional simplification)', () => {
        // 1L at 1.00, 1kg at 0.90. User wants 1 (canonical kg/l unit).
        // Both are fluid; the SP with kg unit normalises cleanly to canonical kg.
        const spL  = makeSpRow({ id: 1, price: '1.00', amount: '1', unit: 'l', isWeighable: false });
        const spKg = makeSpRow({ id: 2, price: '0.90', amount: '1', unit: 'kg', isWeighable: false });
        const canonical = canonicalize([
            { id: 1, amount: 1, unit: 'l' },
            { id: 2, amount: 1, unit: 'kg' },
        ])!;
        const result = pickCheapestForQuantity([spL, spKg], 1, canonical);
        expect(result!.id).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// priceItem
// ---------------------------------------------------------------------------

describe('priceItem — non-weighable with canonical', () => {
    it('charges ceil(userQuantity / canonAmount) packs at pack price', () => {
        // 1L pack at 2.00. User wants 3 L. ceil(3/1) = 3 packs = 6.00.
        const sp = makeSpRow({ id: 1, price: '2.00', amount: '1', unit: 'l', isWeighable: false });
        const canonical = canonicalize([{ id: 1, amount: 1, unit: 'l' }])!;
        const result = priceItem(1, 3, 'Milk', 'sku', { ...sp, effectivePrice: 2.00 }, FLAGS_DIRECT, canonical);
        expect(result.packsNeeded).toBe(3);
        expect(result.totalPrice).toBeCloseTo(6.00);
        expect(result.actualAmount).toBeCloseTo(3.0); // 3 packs × 1L
    });

    it('rounds up to nearest pack multiple', () => {
        // 500ml pack at 0.60. User wants 1.2 L. ceil(1.2/0.5) = 3 packs = 1.80.
        const sp = makeSpRow({ id: 1, price: '0.60', amount: '500', unit: 'ml', isWeighable: false });
        const canonical = canonicalize([{ id: 1, amount: 500, unit: 'ml' }])!;
        const result = priceItem(1, 1.2, 'Juice', 'sku', { ...sp, effectivePrice: 0.60 }, FLAGS_DIRECT, canonical);
        expect(result.packsNeeded).toBe(3);
        expect(result.totalPrice).toBeCloseTo(1.80);
        expect(result.actualAmount).toBeCloseTo(1.5); // 3 × 500ml = 1.5L canonical
    });

    it('vnt: ceil items / pack-content', () => {
        // 10-egg pack at 1.00. User wants 25 eggs. ceil(25/10) = 3 packs = 3.00, 30 eggs.
        const sp = makeSpRow({ id: 1, price: '1.00', amount: '10', unit: 'vnt', isWeighable: false });
        const canonical = canonicalize([{ id: 1, amount: 10, unit: 'vnt' }])!;
        const result = priceItem(1, 25, 'Eggs', 'sku', { ...sp, effectivePrice: 1.00 }, FLAGS_DIRECT, canonical);
        expect(result.packsNeeded).toBe(3);
        expect(result.totalPrice).toBeCloseTo(3.00);
        expect(result.actualAmount).toBe(30);
    });

    it('legacy path (no canonical): treats userQuantity as pack count', () => {
        // When canonical is null (e.g. tier-3 substitute from a different
        // Product), behaviour matches the pre-canonical math: 1 user-quantity
        // unit = 1 pack.
        const sp = makeSpRow({ id: 1, price: '2.00', amount: '1', isWeighable: false });
        const result = priceItem(1, 3, 'X', 'sku', { ...sp, effectivePrice: 2.00 }, FLAGS_DIRECT, null);
        expect(result.packsNeeded).toBe(3);
        expect(result.totalPrice).toBeCloseTo(6.00);
    });

    it('uses promoPrice when provided', () => {
        const sp = makeSpRow({ id: 1, price: '5.00', promoPrice: '3.00', amount: '1', unit: 'l', isWeighable: false });
        const canonical = canonicalize([{ id: 1, amount: 1, unit: 'l' }])!;
        const result = priceItem(1, 2, 'X', 'sku', { ...sp, effectivePrice: 3.00 }, FLAGS_DIRECT, canonical);
        expect(result.effectivePrice).toBeCloseTo(3.00);
        expect(result.totalPrice).toBeCloseTo(6.00);
    });

    it('propagates isSubstituted flag', () => {
        const sp = makeSpRow({ id: 1, price: '1.00', amount: '1', unit: 'l', isWeighable: false });
        const canonical = canonicalize([{ id: 1, amount: 1, unit: 'l' }])!;
        const result = priceItem(1, 1, 'X', 'sku', { ...sp, effectivePrice: 1.00 },
            { isSubstituted: true, isCrossChainAverage: false }, canonical);
        expect(result.isSubstituted).toBe(true);
    });

    it('rounds totalPrice to 2 decimal places', () => {
        const sp = makeSpRow({ id: 1, price: '1.334', amount: '1', unit: 'l', isWeighable: false });
        const canonical = canonicalize([{ id: 1, amount: 1, unit: 'l' }])!;
        const result = priceItem(1, 3, 'X', 'sku', { ...sp, effectivePrice: 1.334 }, FLAGS_DIRECT, canonical);
        expect(result.totalPrice).toBe(Math.round(result.totalPrice! * 100) / 100);
    });
});

describe('priceItem — weighable with canonical', () => {
    it('charges userQuantity × per-canonical-unit price', () => {
        // SP priced per kg. User wants 0.5 kg.
        const sp = makeSpRow({ id: 1, price: '10.00', amount: '1', unit: 'kg', isWeighable: true });
        const canonical = canonicalize([{ id: 1, amount: 1, unit: 'kg' }])!;
        const result = priceItem(1, 0.5, 'Meat', 'sku', { ...sp, effectivePrice: 10.00 }, FLAGS_DIRECT, canonical);
        expect(result.totalPrice).toBeCloseTo(5.00);
        expect(result.packsNeeded).toBe(1);
        expect(result.actualAmount).toBeCloseTo(0.5);
    });

    it('normalises g-priced SP into canonical kg automatically', () => {
        // SP: 100g pack at 0.50 → 5.00 per canonical kg. User wants 0.3 kg.
        // Expected: 0.3 × 5.00 = 1.50
        const sp = makeSpRow({ id: 1, price: '0.50', amount: '100', unit: 'g', isWeighable: true });
        const canonical = canonicalize([{ id: 1, amount: 100, unit: 'g' }])!;
        // Note canonical.unit is 'kg' (g normalised away) even though there's
        // only one SP — the picker UI never shows g/ml.
        expect(canonical.unit).toBe('kg');
        const result = priceItem(1, 0.3, 'Spice', 'sku', { ...sp, effectivePrice: 0.50 }, FLAGS_DIRECT, canonical);
        expect(result.totalPrice).toBeCloseTo(1.50);
    });

    it('normalises ml-priced SP into canonical l', () => {
        // 250ml at 1.00 → 4.00 / canonical l. User wants 0.5 l.
        const sp = makeSpRow({ id: 1, price: '1.00', amount: '250', unit: 'ml', isWeighable: true });
        const canonical = canonicalize([{ id: 1, amount: 250, unit: 'ml' }])!;
        expect(canonical.unit).toBe('l');
        const result = priceItem(1, 0.5, 'Oil', 'sku', { ...sp, effectivePrice: 1.00 }, FLAGS_DIRECT, canonical);
        expect(result.totalPrice).toBeCloseTo(2.00);
    });
});
