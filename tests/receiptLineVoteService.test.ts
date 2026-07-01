import { jest } from '@jest/globals';
import { castReceiptLineVote } from '../src/services/receiptLineVoteService.js';

function makeConn(parsedData: any) {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const conn: any = {
        _calls: calls,
        query: jest.fn(async (sql: string, params: any[]) => {
            calls.push({ sql, params });
            if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsedData) }]];
            if (/SELECT chainId/.test(sql)) return [[{ chainId: 3 }]];
            if (/SELECT receiptLineIdx/.test(sql)) return [[]];
            return [{ affectedRows: 1 }];
        }),
    };
    return conn;
}

const lineFix = (o: Record<string, any> = {}) => ({
    name: 'OCR', storeProductId: 50, matchedName: 'M', matchConfidence: 0.7,
    price: 2, quantity: 1, itemConfidence: { band: 'S3' }, ...o,
});

const priceUpdate = (conn: any) => conn._calls.find((c: any) => /UPDATE Price/.test(c.sql));

describe('castReceiptLineVote', () => {
    it('identical → confirms the product, price-verified, band S1', async () => {
        const conn = makeConn({ products: [lineFix()] });
        const line = await castReceiptLineVote(108, 0, 'identical', conn);
        expect(line.matchConfirmed).toBe(true);
        expect(line.priceVerified).toBe(true);
        expect(line.variantUncertain).toBe(false);
        expect(line.itemConfidence.band).toBe('S1');
        expect(line.itemConfidence.override).toBe('user_confirmed');
        expect(priceUpdate(conn).params[0]).toBe(1); // Price verified
    });

    it('similar → demotes the line (a same-category substitute is a DIFFERENT product)', async () => {
        const conn = makeConn({ header: { chainId: 3 }, products: [lineFix({ altMatches: [{ storeProductId: 50, confidence: 0.7 }] })] });
        const line = await castReceiptLineVote(108, 0, 'similar', conn);
        expect(line.storeProductId).toBeNull();
        expect(line.matchConfirmed).toBe(false);
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(true);
    });

    it('different → demotes the line (no runner-up → cleared to OCR)', async () => {
        const conn = makeConn({ header: { chainId: 3 }, products: [lineFix({ altMatches: [{ storeProductId: 50, confidence: 0.7 }] })] });
        const line = await castReceiptLineVote(108, 0, 'different', conn);
        expect(line.storeProductId).toBeNull();
        expect(line.matchConfirmed).toBe(false);
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(true);
    });

    it('a line with no match → null (nothing to confirm)', async () => {
        const conn = makeConn({ products: [lineFix({ storeProductId: null })] });
        expect(await castReceiptLineVote(108, 0, 'identical', conn)).toBeNull();
    });
});
