import { stripReceiptPII } from '../src/util/receiptPII.js';

describe('stripReceiptPII', () => {
    it('removes footer.rawText, header.rawText and products[].rawLines', () => {
        const input = {
            header: { rawText: 'CASHIER 042', store: 'Rimi' },
            footer: { rawText: 'CARD **** 1234 RRN 999', total: 12.5 },
            products: [
                { name: 'Pienas', price: 1.2, rawLines: ['PIENAS 1.20'] },
                { name: 'Duona', price: 0.9, rawLines: ['DUONA 0.90'] },
            ],
            date: '2026-01-01',
        };
        const out = stripReceiptPII(input) as any;
        expect(out.header.rawText).toBeUndefined();
        expect(out.footer.rawText).toBeUndefined();
        expect(out.products.every((p: any) => p.rawLines === undefined)).toBe(true);
        // Structured purchase data is retained for the price DB.
        expect(out.header.store).toBe('Rimi');
        expect(out.footer.total).toBe(12.5);
        expect(out.products[0]).toMatchObject({ name: 'Pienas', price: 1.2 });
        expect(out.date).toBe('2026-01-01');
    });

    it('does not mutate the input', () => {
        const input = { footer: { rawText: 'secret' }, products: [{ name: 'x', rawLines: ['x'] }] };
        stripReceiptPII(input);
        expect(input.footer.rawText).toBe('secret');
        expect(input.products[0].rawLines).toEqual(['x']);
    });

    it('passes through null / non-object inputs untouched', () => {
        expect(stripReceiptPII(null)).toBeNull();
        expect(stripReceiptPII(undefined)).toBeUndefined();
        expect(stripReceiptPII('text' as unknown)).toBe('text');
    });

    it('handles missing sections gracefully', () => {
        expect(stripReceiptPII({ products: [] })).toEqual({ products: [] });
        expect(stripReceiptPII({ header: { store: 'IKI' } })).toEqual({ header: { store: 'IKI' } });
    });
});
