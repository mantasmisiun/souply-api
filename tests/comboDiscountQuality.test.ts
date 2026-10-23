import { assessQuality } from '../src/services/receiptHealService.js';

/**
 * Set-deal ("RINKINYS") discounts are deducted at the FOOTER, never from the line
 * prices, so a receipt's line sum legitimately exceeds its printed total by
 * exactly the deal amount. The quality check used to ignore that and read the
 * difference as a reconciliation failure.
 *
 * Real case — receipt 120: ACTO 0,65 + TICHE 1,69 + TICHE 1,69 = 4,03 against a
 * printed 2,35 with a 1,90 set deal. Every line was captured AND matched, yet the
 * 71 % apparent gap raised the "Perfotografuoti" retake banner — asking the user
 * to re-photograph a perfect scan. With the deal subtracted the gap is 9,4 %,
 * inside tolerance.
 */

// A readable line needs a real ≥3-letter name — `hasUsableName` treats short
// scraps as unreadable, which is its own lowQuality trigger.
const line = (price: number, matched = true, name = 'TICHE NATURALUS') => ({
    price, quantity: 1, name, matched, confirmed: false,
    confidence: 0.9, implausible: false,
});

describe('assessQuality accounts for footer set-deal discounts', () => {
    const receipt120 = [line(0.65, true, 'BA JORISKIU MAISTINE ACTO'), line(1.69), line(1.69)];  // sum 4.03
    const TOTAL = 2.35;
    const COMBO = 1.90;

    test('THE BUG: ignoring the set deal flags a clean receipt as low quality', () => {
        expect(assessQuality(receipt120, TOTAL).lowQuality).toBe(true);
    });

    test('subtracting it clears the flag (no false retake prompt)', () => {
        const q = assessQuality(receipt120, TOTAL, COMBO);
        expect(q.lowQuality).toBe(false);
        expect(q.unmatchedCount).toBe(0);
        expect(q.unreadableCount).toBe(0);
    });

    test('a genuinely broken receipt still flags even with a set deal', () => {
        // Lines nowhere near the total, deal or no deal.
        expect(assessQuality([line(0.65), line(1.69)], 20.00, COMBO).lowQuality).toBe(true);
    });

    test('null / zero / negative combo values are treated as no discount', () => {
        for (const combo of [null, 0, -5]) {
            expect(assessQuality(receipt120, TOTAL, combo).lowQuality).toBe(true);
        }
    });

    test('the OTHER triggers are untouched — an unmatched majority still flags', () => {
        const unmatched = [line(0.65, false), line(1.69, false), line(1.69, false)];
        expect(assessQuality(unmatched, TOTAL, COMBO).lowQuality).toBe(true);
    });
});

describe('loyalty money in reconciliation', () => {
    const line = (price: number, name: string) => ({
        price, quantity: 1, name, matched: true, confirmed: true, confidence: 0.9, implausible: false,
    });

    it('THE CASE: lines over the printed total by the redeemed amount is NOT low quality', () => {
        // Receipt 19: 4 × 0.59 = 2.36 of lines, "Nurašyta MAXIMOS pinigų 0,12",
        // total 2.24. Every line is correct; the balance paid the difference.
        const lines = [
            line(0.59, 'Duonos traškučiai MARETTI'), line(0.59, 'Duonos traškučiai MARETTI'),
            line(0.59, 'Duonos traškučiai MARETTI'), line(0.59, 'Duonos traškučiai MARETTI'),
        ];
        expect(assessQuality(lines, 2.24, null, 0.12).lowQuality).toBe(false);
        // …and without knowing about it, the same receipt trips the gap rule at
        // a 5 % threshold — which is what put a retake banner on a clean scan.
        expect(assessQuality(lines, 2.24, null, null).lowQuality).toBe(false);  // 5.4 % < 10 %
        expect(assessQuality(lines, 2.00, null, null).lowQuality).toBe(true);   // 18 % — no loyalty known
        expect(assessQuality(lines, 2.00, null, 0.36).lowQuality).toBe(false);  // …explained
    });

    it('a set deal and loyalty money both come off the same line sum', () => {
        // Real names: a 1-char name counts as UNREADABLE and would trip the
        // flag for an unrelated reason.
        const lines = [line(5.00, 'Pienas ROKIŠKIO'), line(5.00, 'Duona VILNIAUS')];
        // 10.00 of lines − 1.90 set deal − 1.00 loyalty = 7.10 paid.
        expect(assessQuality(lines, 7.10, 1.90, 1.00).lowQuality).toBe(false);
    });

    it('money EARNED must not be passed here — only what was redeemed', () => {
        // Passing an accrual would make a correct receipt under-reconcile.
        const lines = [line(5.00, 'Pienas ROKIŠKIO')];
        expect(assessQuality(lines, 5.00, null, 0).lowQuality).toBe(false);
        expect(assessQuality(lines, 5.00, null, 1.00).lowQuality).toBe(true);
    });
});
