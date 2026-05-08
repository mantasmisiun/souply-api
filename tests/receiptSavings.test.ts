import { computeSavingsFromPrices, type SavingsItem } from '../src/services/statsService.js';

// ---------------------------------------------------------------------------
// computeSavingsFromPrices
// ---------------------------------------------------------------------------

describe('computeSavingsFromPrices', () => {
    const spToProduct = new Map([
        [10, 100],  // sp 10 → product 100
        [11, 101],  // sp 11 → product 101
        [12, 102],  // sp 12 → product 102
    ]);

    const productAvgPrice = new Map([
        [100, 2.00],  // market avg €2.00
        [101, 5.00],  // market avg €5.00
        [102, 1.00],  // market avg €1.00
    ]);

    it('returns positive savings when receipt price is below market average', () => {
        const items: SavingsItem[] = [
            { storeProductId: 10, price: 1.50, quantity: 1 }, // paid 1.50, avg 2.00 → saved 0.50
        ];
        expect(computeSavingsFromPrices(items, spToProduct, productAvgPrice)).toBeCloseTo(0.50);
    });

    it('returns negative savings when receipt price is above market average', () => {
        const items: SavingsItem[] = [
            { storeProductId: 10, price: 2.50, quantity: 1 }, // paid 2.50, avg 2.00 → "saved" -0.50
        ];
        expect(computeSavingsFromPrices(items, spToProduct, productAvgPrice)).toBeCloseTo(-0.50);
    });

    it('multiplies delta by quantity', () => {
        const items: SavingsItem[] = [
            { storeProductId: 10, price: 1.50, quantity: 3 }, // (2.00 - 1.50) * 3 = 1.50
        ];
        expect(computeSavingsFromPrices(items, spToProduct, productAvgPrice)).toBeCloseTo(1.50);
    });

    it('sums across multiple items', () => {
        const items: SavingsItem[] = [
            { storeProductId: 10, price: 1.50, quantity: 1 }, // saved 0.50
            { storeProductId: 11, price: 4.00, quantity: 2 }, // (5.00 - 4.00) * 2 = 2.00
        ];
        expect(computeSavingsFromPrices(items, spToProduct, productAvgPrice)).toBeCloseTo(2.50);
    });

    it('skips items with no matching productId', () => {
        const items: SavingsItem[] = [
            { storeProductId: 99, price: 1.00, quantity: 1 }, // sp 99 not in map
        ];
        expect(computeSavingsFromPrices(items, spToProduct, productAvgPrice)).toBe(0);
    });

    it('skips items with no average price', () => {
        const items: SavingsItem[] = [
            { storeProductId: 12, price: 0.80, quantity: 1 }, // product 102 avg €1.00
        ];
        const avgWithoutProduct102 = new Map([
            [100, 2.00],
            [101, 5.00],
            // 102 missing
        ]);
        expect(computeSavingsFromPrices(items, spToProduct, avgWithoutProduct102)).toBe(0);
    });

    it('skips items with zero or negative price', () => {
        const items: SavingsItem[] = [
            { storeProductId: 10, price: 0,    quantity: 1 },
            { storeProductId: 10, price: -1.00, quantity: 1 },
        ];
        expect(computeSavingsFromPrices(items, spToProduct, productAvgPrice)).toBe(0);
    });

    it('returns 0 for empty item list', () => {
        expect(computeSavingsFromPrices([], spToProduct, productAvgPrice)).toBe(0);
    });

    it('rounds to 2 decimal places', () => {
        const items: SavingsItem[] = [
            { storeProductId: 10, price: 1.334, quantity: 3 }, // (2.00 - 1.334) * 3 = 1.998 → 2.00
        ];
        const result = computeSavingsFromPrices(items, spToProduct, productAvgPrice);
        expect(result).toBe(Math.round(result * 100) / 100);
    });

    it('handles net-zero savings across items', () => {
        const items: SavingsItem[] = [
            { storeProductId: 10, price: 2.00, quantity: 1 }, // exactly avg, 0
            { storeProductId: 11, price: 5.00, quantity: 1 }, // exactly avg, 0
        ];
        expect(computeSavingsFromPrices(items, spToProduct, productAvgPrice)).toBeCloseTo(0);
    });
});
