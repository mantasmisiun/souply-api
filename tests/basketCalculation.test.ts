import { pickCheapest, priceItem, type SpRow } from '../src/services/basketCalculationService.js';

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

// ---------------------------------------------------------------------------
// pickCheapest
// ---------------------------------------------------------------------------

describe('pickCheapest', () => {
    it('returns null for empty array', () => {
        expect(pickCheapest([])).toBeNull();
    });

    it('returns null when all rows have null price', () => {
        const rows = [makeSpRow({ price: null as any })];
        expect(pickCheapest(rows)).toBeNull();
    });

    it('returns the single priced row', () => {
        const row = makeSpRow({ price: '2.50' });
        const result = pickCheapest([row]);
        expect(result).not.toBeNull();
        expect(result!.effectivePrice).toBeCloseTo(2.50);
    });

    it('prefers promoPrice over regular price for effectivePrice', () => {
        const row = makeSpRow({ price: '3.00', promoPrice: '2.00' });
        const result = pickCheapest([row]);
        expect(result!.effectivePrice).toBeCloseTo(2.00);
    });

    it('picks the cheaper row by regular price', () => {
        const expensive = makeSpRow({ id: 1, price: '5.00' });
        const cheap     = makeSpRow({ id: 2, price: '3.00' });
        const result = pickCheapest([expensive, cheap]);
        expect(result!.id).toBe(2);
    });

    it('picks the cheaper row by promoPrice when comparing to regular price', () => {
        const regular = makeSpRow({ id: 1, price: '3.00' });
        const promo   = makeSpRow({ id: 2, price: '5.00', promoPrice: '2.00' });
        const result = pickCheapest([regular, promo]);
        expect(result!.id).toBe(2);
    });

    it('picks cheapest per-unit when pack sizes differ', () => {
        // id=1: 1.00 for 0.5 units = 2.00/unit
        // id=2: 1.50 for 1 unit    = 1.50/unit  ← cheaper per unit
        const smallPack = makeSpRow({ id: 1, price: '1.00', amount: '0.5' });
        const largePack = makeSpRow({ id: 2, price: '1.50', amount: '1' });
        const result = pickCheapest([smallPack, largePack]);
        expect(result!.id).toBe(2);
    });

    it('skips rows with null price even when mixed with valid rows', () => {
        const valid   = makeSpRow({ id: 1, price: '2.00' });
        const invalid = makeSpRow({ id: 2, price: null as any });
        const result = pickCheapest([invalid, valid]);
        expect(result!.id).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// priceItem
// ---------------------------------------------------------------------------

const FLAGS_DIRECT = { isSubstituted: false, isCrossChainAverage: false };

describe('priceItem — non-weighable', () => {
    it('charges quantity × effectivePrice for whole packs', () => {
        const sp = makeSpRow({ id: 1, price: '2.00', amount: '1', isWeighable: false });
        const result = priceItem(1, 3, 'Milk', 'sku', { ...sp, effectivePrice: 2.00 }, FLAGS_DIRECT);
        expect(result.totalPrice).toBeCloseTo(6.00);
        expect(result.packsNeeded).toBe(3);
    });

    it('rounds fractional quantity up to next whole pack', () => {
        const sp = makeSpRow({ id: 1, price: '2.00', amount: '1', isWeighable: false });
        const result = priceItem(1, 1.5, 'Milk', 'sku', { ...sp, effectivePrice: 2.00 }, FLAGS_DIRECT);
        expect(result.packsNeeded).toBe(2);
        expect(result.totalPrice).toBeCloseTo(4.00);
    });

    it('computes actualAmount as packs × spAmount', () => {
        const sp = makeSpRow({ id: 1, price: '3.00', amount: '0.5', isWeighable: false });
        const result = priceItem(1, 2, 'Item', 'sku', { ...sp, effectivePrice: 3.00 }, FLAGS_DIRECT);
        expect(result.actualAmount).toBeCloseTo(1.0); // 2 packs × 0.5
    });

    it('sets isMissing=false and isFallback=false for direct match', () => {
        const sp = makeSpRow({ id: 1, price: '1.00', isWeighable: false });
        const result = priceItem(1, 1, 'Item', 'sku', { ...sp, effectivePrice: 1.00 }, FLAGS_DIRECT);
        expect(result.isMissing).toBe(false);
        expect(result.isFallback).toBe(false);
    });

    it('uses promoPrice as effectivePrice when provided', () => {
        const sp = makeSpRow({ id: 1, price: '5.00', promoPrice: '3.00', isWeighable: false });
        const result = priceItem(1, 2, 'Item', 'sku', { ...sp, effectivePrice: 3.00 }, FLAGS_DIRECT);
        expect(result.effectivePrice).toBeCloseTo(3.00);
        expect(result.totalPrice).toBeCloseTo(6.00);
    });

    it('propagates isSubstituted flag', () => {
        const sp = makeSpRow({ id: 1, price: '1.00', isWeighable: false });
        const result = priceItem(1, 1, 'X', 'sku', { ...sp, effectivePrice: 1.00 }, { isSubstituted: true, isCrossChainAverage: false });
        expect(result.isSubstituted).toBe(true);
    });

    it('rounds totalPrice to 2 decimal places', () => {
        const sp = makeSpRow({ id: 1, price: '1.334', isWeighable: false });
        const result = priceItem(1, 3, 'Item', 'sku', { ...sp, effectivePrice: 1.334 }, FLAGS_DIRECT);
        expect(result.totalPrice).toBe(Math.round(result.totalPrice! * 100) / 100);
    });
});

describe('priceItem — weighable', () => {
    it('charges weight × (price / spAmount) for weighable items', () => {
        // SP is priced per kg. User wants 0.5 kg.
        const sp = makeSpRow({ id: 1, price: '10.00', amount: '1', unit: 'kg', isWeighable: true });
        const result = priceItem(1, 0.5, 'Meat', 'sku', { ...sp, effectivePrice: 10.00 }, FLAGS_DIRECT);
        expect(result.totalPrice).toBeCloseTo(5.00);
    });

    it('normalizes g-priced SP: user quantity < 10 is treated as kg → g conversion', () => {
        // SP priced per gram, user typed "2" meaning 2 kg = 2000 g
        const sp = makeSpRow({ id: 1, price: '0.01', amount: '1', unit: 'g', isWeighable: true });
        const result = priceItem(1, 2, 'Bulk item', 'sku', { ...sp, effectivePrice: 0.01 }, FLAGS_DIRECT);
        // 2 * 1000 * (0.01 / 1) = 20.00
        expect(result.totalPrice).toBeCloseTo(20.00);
    });

    it('normalizes kg-priced SP: user quantity > 10 is treated as grams → kg conversion', () => {
        // SP priced per kg, user typed "1500" meaning 1500 g = 1.5 kg
        const sp = makeSpRow({ id: 1, price: '10.00', amount: '1', unit: 'kg', isWeighable: true });
        const result = priceItem(1, 1500, 'Bulk kg', 'sku', { ...sp, effectivePrice: 10.00 }, FLAGS_DIRECT);
        // 1500 / 1000 = 1.5 kg × 10.00 = 15.00
        expect(result.totalPrice).toBeCloseTo(15.00);
    });

    it('sets packsNeeded=1 for weighable items regardless of quantity', () => {
        const sp = makeSpRow({ id: 1, price: '5.00', amount: '1', unit: 'kg', isWeighable: true });
        const result = priceItem(1, 3, 'Meat', 'sku', { ...sp, effectivePrice: 5.00 }, FLAGS_DIRECT);
        expect(result.packsNeeded).toBe(1);
    });
});
