import { comboDiscountOf } from '../src/services/statsService.js';

// Receipt-level combo/set-deal discount (IKI bare "RINKINYS -1,90") — parser writes
// parsedData.footer.comboDiscount; savedAmount ADDS it, the comparison SUBTRACTS it from
// the visited basket. This helper is the single defensive gate all consumers share.
describe('comboDiscountOf', () => {
    it('reads a positive footer.comboDiscount', () => {
        expect(comboDiscountOf({ footer: { comboDiscount: 1.9 } })).toBe(1.9);
    });

    it('rounds to cents', () => {
        expect(comboDiscountOf({ footer: { comboDiscount: 1.899999 } })).toBe(1.9);
    });

    it('caps at the provided ceiling (OCR-garbage guard)', () => {
        expect(comboDiscountOf({ footer: { comboDiscount: 190 } }, 4.03)).toBe(4.03);
    });

    it('collapses missing / null / zero / negative / non-finite to 0', () => {
        expect(comboDiscountOf(null)).toBe(0);
        expect(comboDiscountOf({})).toBe(0);
        expect(comboDiscountOf({ footer: {} })).toBe(0);
        expect(comboDiscountOf({ footer: { comboDiscount: null } })).toBe(0);
        expect(comboDiscountOf({ footer: { comboDiscount: 0 } })).toBe(0);
        expect(comboDiscountOf({ footer: { comboDiscount: -1.9 } })).toBe(0);
        expect(comboDiscountOf({ footer: { comboDiscount: NaN } })).toBe(0);
        expect(comboDiscountOf({ footer: { comboDiscount: 'abc' } })).toBe(0);
        expect(comboDiscountOf({ footer: { comboDiscount: Infinity } })).toBe(0);
    });
});
