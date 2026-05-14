import { extractRecoveryFields } from '../src/utils/receiptIntrospect.js';

describe('extractRecoveryFields', () => {
    it('pulls receiptNo/date/total from a Maxima-shape footer', () => {
        const parsed = {
            footer: {
                date: '2025-11-05',
                receiptNo: '638137',
                total: 2.24,
            },
        };
        expect(extractRecoveryFields(parsed)).toEqual({
            receiptNo: '638137',
            date: '2025-11-05',
            total: 2.24,
        });
    });

    it('handles a datetime date string by stripping the time component', () => {
        const parsed = {
            footer: { date: '2026-03-10T09:50:57Z', receiptNo: '9/134/21269', total: 12.83 },
        };
        const out = extractRecoveryFields(parsed);
        expect(out?.date).toBe('2026-03-10');
    });

    it('accepts a comma-decimal string total', () => {
        const parsed = { footer: { date: '2026-01-01', receiptNo: 'X1', total: '5,49' } };
        const out = extractRecoveryFields(parsed);
        expect(out?.total).toBeCloseTo(5.49, 2);
    });

    it('returns null when receiptNo is missing', () => {
        expect(extractRecoveryFields({ footer: { date: '2026-01-01', total: 1.0 } })).toBeNull();
    });

    it('returns null when total is zero or negative', () => {
        expect(extractRecoveryFields({ footer: { date: '2026-01-01', receiptNo: 'X', total: 0 } })).toBeNull();
        expect(extractRecoveryFields({ footer: { date: '2026-01-01', receiptNo: 'X', total: -3 } })).toBeNull();
    });

    it('returns null when date is not YYYY-MM-DD-prefixed', () => {
        expect(extractRecoveryFields({ footer: { date: '05/11/2025', receiptNo: 'X', total: 1 } })).toBeNull();
    });

    it('returns null for non-object input', () => {
        expect(extractRecoveryFields(null)).toBeNull();
        expect(extractRecoveryFields('string')).toBeNull();
        expect(extractRecoveryFields(42)).toBeNull();
        expect(extractRecoveryFields({})).toBeNull();
    });
});
