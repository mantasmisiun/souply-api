import { clampSavings } from '../src/util/savings.js';

describe('clampSavings', () => {
    it('passes through positive finite amounts', () => {
        expect(clampSavings(3.5)).toBe(3.5);
        expect(clampSavings(0.01)).toBe(0.01);
    });
    it('accrues nothing for zero / negative', () => {
        expect(clampSavings(0)).toBe(0);
        expect(clampSavings(-5)).toBe(0);
    });
    it('accrues nothing for non-finite values', () => {
        expect(clampSavings(NaN)).toBe(0);
        expect(clampSavings(Infinity)).toBe(0);
    });
});
