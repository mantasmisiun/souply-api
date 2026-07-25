import { attributeComboDiscount, type ComboLine } from '../src/services/comboAttribution.js';

/**
 * Set-deal attribution is DISPLAY ONLY — it decides which line the RINKINYS
 * amount is shown against. Real case (receipt 120): vinegar €0,65 + 2× TICHE
 * water €1,69 with a €1,90 set deal. Spreading it evenly made the VINEGAR look
 * discounted even though a set deal needs 2+ of a qualifying item.
 */

const L = (lineTotal: number, name: string, matchedSpId: number | null = null, quantity = 1): ComboLine =>
    ({ lineTotal, name, matchedSpId, quantity });

// The receipt as parsed: index 2 is where RINKINYS was printed.
const receipt120: ComboLine[] = [
    L(0.65, 'BA JORISKIU MAISTINE ACTO', 59442),
    L(1.69, 'TICHE NATORALUS NEGAZUOTA', 63590),
    L(1.69, 'TICHE NATURALUS NEGAZUOTA', 63590),
];

describe('attributeComboDiscount', () => {
    test('TIER 1 anchor: the deal lands on the water, never the vinegar', () => {
        const a = attributeComboDiscount(receipt120, 1.90, [2]);
        expect(a.basis).toBe('anchor');
        expect(a.shares[0]).toBe(0);                       // vinegar untouched
        expect(a.shares[1] + a.shares[2]).toBeCloseTo(1.90, 2);
        expect(a.shares[1]).toBeCloseTo(0.95, 2);          // split across the pair
        expect(a.shares[2]).toBeCloseTo(0.95, 2);
    });

    test('TIER 2 multiples: no anchor → still only the repeated product', () => {
        const a = attributeComboDiscount(receipt120, 1.90, []);
        expect(a.basis).toBe('multiples');
        expect(a.shares[0]).toBe(0);
        expect(a.shares[1] + a.shares[2]).toBeCloseTo(1.90, 2);
    });

    test('TIER 2 also catches a single line bought ×2', () => {
        const lines = [L(0.65, 'ACTO', 1), L(3.38, 'TICHE', 2, 2)];
        const a = attributeComboDiscount(lines, 1.90, []);
        expect(a.basis).toBe('multiples');
        expect(a.shares[0]).toBe(0);
        expect(a.shares[1]).toBeCloseTo(1.90, 2);
    });

    test('TIER 3 even: nothing identifiable → spread across everything', () => {
        const lines = [L(2.00, 'A', 1), L(2.00, 'B', 2)];
        const a = attributeComboDiscount(lines, 1.00, []);
        expect(a.basis).toBe('even');
        expect(a.shares[0] + a.shares[1]).toBeCloseTo(1.00, 2);
    });

    test('a share NEVER exceeds its line — no negative displayed prices', () => {
        const lines = [L(0.50, 'X', 1, 2), L(0.50, 'Y', 2, 2)];
        const a = attributeComboDiscount(lines, 5.00, []);   // deal bigger than the basket
        a.shares.forEach((s, i) => expect(s).toBeLessThanOrEqual(lines[i].lineTotal + 1e-9));
        expect(a.unattributed).toBeGreaterThan(0);           // remainder reported, not forced on
    });

    test('shares are PROPORTIONAL to line size, so a big line absorbs more', () => {
        const lines = [L(0.20, 'W', 7, 2), L(5.00, 'W', 7, 2)];
        const a = attributeComboDiscount(lines, 2.00, [0]);
        expect(a.shares[0] + a.shares[1]).toBeCloseTo(2.00, 2);
        expect(a.shares[1]).toBeGreaterThan(a.shares[0]);
        expect(a.shares[0]).toBeCloseTo(0.08, 2);   // 0.20/5.20 × 2.00
        expect(a.unattributed).toBe(0);
    });

    test('when a line WOULD be over-charged its leftover moves to the others', () => {
        // Line 0 can absorb at most 0.10; the pair must still take the full 2.00.
        const lines = [L(0.10, 'W', 7, 2), L(9.00, 'W', 7, 2)];
        const a = attributeComboDiscount(lines, 2.00, [0]);
        expect(a.shares[0]).toBeLessThanOrEqual(0.10 + 1e-9);
        expect(a.shares[0] + a.shares[1]).toBeCloseTo(2.00, 2);
        expect(a.unattributed).toBe(0);
    });

    test('no deal / empty input is a clean no-op', () => {
        expect(attributeComboDiscount(receipt120, null, [2]).basis).toBe('none');
        expect(attributeComboDiscount(receipt120, 0, [2]).shares).toEqual([0, 0, 0]);
        expect(attributeComboDiscount([], 1.9, []).shares).toEqual([]);
    });

    test('out-of-range anchors are ignored, falling through to multiples', () => {
        const a = attributeComboDiscount(receipt120, 1.90, [99, -1]);
        expect(a.basis).toBe('multiples');
        expect(a.shares[0]).toBe(0);
    });
});
