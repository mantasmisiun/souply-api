import { stripReceiptPII, stripProductRawText } from '../src/util/receiptPII.js';

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

describe('stripProductRawText', () => {
    it('drops header/footer rawText but keeps structured header/footer + geometry', () => {
        const input = {
            version: 1,
            header: { storeAddress: 'Vilniaus g. 128-2, Šiauliai', rawText: 'IKI L\nVIRTA DEŠRA 2,49\n...' },
            footer: { total: 2.3, receiptNo: '151349', rawText: 'Kvito Nr...\nKORTELĖS ****' },
            products: [],
            wordsDump: [{ t: 'IKI L' }],
        };
        const out = stripProductRawText(input) as any;
        expect(out.header.rawText).toBeUndefined();
        expect(out.footer.rawText).toBeUndefined();
        // Structured fields + geometry survive.
        expect(out.header.storeAddress).toBe('Vilniaus g. 128-2, Šiauliai');
        expect(out.footer).toMatchObject({ total: 2.3, receiptNo: '151349' });
        expect(out.wordsDump).toEqual([{ t: 'IKI L' }]);
        expect(out.version).toBe(1);
    });

    it('does not mutate the input (products[] stays intact for the ReceiptItem dual-write)', () => {
        const input = {
            header: { rawText: 'keep me in memory' },
            footer: { rawText: 'keep me too' },
            products: [{ name: 'Pienas', rawLines: ['PIENAS 1.20'] }],
        };
        const out = stripProductRawText(input) as any;
        expect(input.header.rawText).toBe('keep me in memory');
        expect(input.footer.rawText).toBe('keep me too');
        expect(input.products[0].rawLines).toEqual(['PIENAS 1.20']);
        // products[] is passed through untouched (the caller empties it separately).
        expect(out.products[0].rawLines).toEqual(['PIENAS 1.20']);
    });

    it('passes through null / non-object / missing sections', () => {
        expect(stripProductRawText(null as any)).toBeNull();
        expect(stripProductRawText({ products: [] } as any)).toEqual({ products: [] });
        expect(stripProductRawText({ header: { storeAddress: 'X' } } as any)).toEqual({ header: { storeAddress: 'X' } });
    });
});
