import { normalizeReceiptNo, normalizeReceiptDateForStorage } from '../src/utils/receiptMetadata.js';

// ---------------------------------------------------------------------------
// normalizeReceiptNo
// ---------------------------------------------------------------------------

describe('normalizeReceiptNo', () => {
    it('returns null when both arguments are null/undefined', () => {
        expect(normalizeReceiptNo(null)).toBeNull();
        expect(normalizeReceiptNo(undefined)).toBeNull();
    });

    it('returns the trimmed receipt number directly', () => {
        expect(normalizeReceiptNo('12345')).toBe('12345');
        expect(normalizeReceiptNo('  A-001  ')).toBe('A-001');
    });

    it('strips "Kasa N" suffix from receipt number', () => {
        expect(normalizeReceiptNo('12345 Kasa 3')).toBe('12345');
        expect(normalizeReceiptNo('ABC-99 Kasa 12 some trailing')).toBe('ABC-99');
    });

    it('prefers the direct receiptNo over footer text when both are provided', () => {
        const footer = 'Kvito Nr. 999\nother line';
        expect(normalizeReceiptNo('12345', footer)).toBe('12345');
    });

    it('extracts receipt number from footer raw text when receiptNo is null', () => {
        const footer = 'Some line\nKvito Nr. 00123\nanother line';
        expect(normalizeReceiptNo(null, footer)).toBe('00123');
    });

    it('ignores Banko Kvito Nr. lines (bank receipt, not grocery receipt)', () => {
        const footer = 'Banko Kvito Nr. 777\nKvito Nr. 12345';
        expect(normalizeReceiptNo(null, footer)).toBe('12345');
    });

    it('extracts via "Kvito numeris" fallback pattern', () => {
        const footer = 'Kvito numeris ABC-001/2024';
        expect(normalizeReceiptNo(null, footer)).toBe('ABC-001/2024');
    });

    it('returns null when footer has no recognizable receipt number', () => {
        expect(normalizeReceiptNo(null, 'No useful data here')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// normalizeReceiptDateForStorage
// ---------------------------------------------------------------------------

describe('normalizeReceiptDateForStorage', () => {
    it('converts date-only to midnight SQL datetime', () => {
        expect(normalizeReceiptDateForStorage('2024-03-15')).toBe('2024-03-15 00:00:00');
    });

    it('combines date-only with HH:MM time', () => {
        expect(normalizeReceiptDateForStorage('2024-03-15', '14:30')).toBe('2024-03-15 14:30:00');
    });

    it('combines date-only with HH:MM:SS time', () => {
        expect(normalizeReceiptDateForStorage('2024-03-15', '14:30:45')).toBe('2024-03-15 14:30:45');
    });

    it('ignores an invalid time string and falls back to midnight', () => {
        expect(normalizeReceiptDateForStorage('2024-03-15', 'not-a-time')).toBe('2024-03-15 00:00:00');
    });

    it('passes through a full ISO datetime with space separator', () => {
        expect(normalizeReceiptDateForStorage('2024-03-15 14:30:00')).toBe('2024-03-15 14:30:00');
    });

    it('converts T-separator ISO datetime to space-separated SQL datetime', () => {
        expect(normalizeReceiptDateForStorage('2024-03-15T14:30:00')).toBe('2024-03-15 14:30:00');
    });

    it('handles datetime without seconds (HH:MM only)', () => {
        expect(normalizeReceiptDateForStorage('2024-03-15 14:30')).toBe('2024-03-15 14:30:00');
    });

    it('ignores receiptTime when receiptDate already includes a time component', () => {
        // receiptDate already has time — receiptTime should not double-apply
        const result = normalizeReceiptDateForStorage('2024-03-15 10:00:00', '14:30');
        expect(result).toBe('2024-03-15 10:00:00');
    });

    it('falls back to current time (a valid SQL datetime) for null input', () => {
        const result = normalizeReceiptDateForStorage(null);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('falls back to current time for undefined input', () => {
        const result = normalizeReceiptDateForStorage(undefined);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('falls back to current time for empty string', () => {
        const result = normalizeReceiptDateForStorage('');
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
});
