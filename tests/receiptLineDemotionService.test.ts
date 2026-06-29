import { jest } from '@jest/globals';
import { demoteRejectedReceiptLine, demoteReceiptLineDirect } from '../src/services/receiptLineDemotionService.js';

// Mock connection: SELECT parsedData FOR UPDATE returns the seeded blob; UPDATE
// records the written parsedData so we can assert the mutation.
function makeConn(parsedData: any) {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const conn: any = {
        _calls: calls,
        query: jest.fn(async (sql: string, params: any[]) => {
            calls.push({ sql, params });
            if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsedData) }]];
            return [{ affectedRows: 1 }];
        }),
    };
    return conn;
}

// The slyvos line: a bootstrapped IKI SP (97651) whose top altMatch is the Barbora
// plums SP (240) it borrowed identity from.
const slyvosLine = (overrides: Record<string, any> = {}) => ({
    name: 'RAUDONOSIOS PAPRKOS',
    storeProductId: 97651,
    matchedName: 'Raudonosios slyvos',
    matchConfirmed: true,
    priceVerified: false,
    altMatches: [
        { storeProductId: 240, confidence: 0.69, name: 'Raudonosios slyvos' },
        { storeProductId: 205, confidence: 0.61, name: 'Raudonosios vynuogės' },
    ],
    ...overrides,
});

const writtenParsed = (conn: any) => {
    const update = conn._calls.find((c: any) => /UPDATE Receipt/.test(c.sql));
    return update ? JSON.parse(update.params[0]) : null;
};

describe('demoteRejectedReceiptLine', () => {
    it('demotes a line whose top-altMatch identity the user rejected → clears to OCR + userRejected veto', async () => {
        const conn = makeConn({ products: [slyvosLine()] });
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);

        expect(result).toBe(true);
        const line = writtenParsed(conn).products[0];
        expect(line.storeProductId).toBeNull();
        expect(line.matchConfirmed).toBe(false);
        expect(line.matchedName).toBeNull();
        expect(line.priceVerified).toBe(false);
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(true);
        expect(line.itemConfidence.band).toBe('S3');
    });

    it('order-independent: the rejected SP may be either side of the voted pair', async () => {
        const conn = makeConn({ products: [slyvosLine()] });
        const result = await demoteRejectedReceiptLine(108, 240, 97651, conn); // swapped
        expect(result).toBe(true);
        expect(writtenParsed(conn).products[0].storeProductId).toBeNull();
    });

    it('does NOT demote when the rejected SP is a LOWER altMatch, not the primary identity', async () => {
        const conn = makeConn({ products: [slyvosLine()] });
        const result = await demoteRejectedReceiptLine(108, 97651, 205, conn); // 205 = altMatches[1]
        expect(result).toBe(false);
        expect(conn._calls.some((c: any) => /UPDATE Receipt/.test(c.sql))).toBe(false);
    });

    it('does NOT demote a same-chain line whose SP IS its top altMatch (self-pair territory)', async () => {
        // line SP == top altMatch (240); voting it against an unrelated SP must not demote.
        const conn = makeConn({ products: [slyvosLine({ storeProductId: 240, altMatches: [{ storeProductId: 240, confidence: 1, name: 'X' }] })] });
        const result = await demoteRejectedReceiptLine(108, 240, 999, conn);
        expect(result).toBe(false);
    });

    it('re-points to a SAME-CHAIN runner-up (≥ auto-apply) instead of clearing to OCR', async () => {
        const parsed = {
            header: { chainId: 3 },
            products: [slyvosLine({
                altMatches: [
                    { storeProductId: 240, confidence: 0.69, name: 'Raudonosios slyvos' },       // top → rejected
                    { storeProductId: 555, confidence: 0.9, name: 'Raudonos paprikos', imageUrl: 'p.jpg' }, // strong runner-up
                ],
            })],
        };
        const conn: any = {
            _calls: [] as any[],
            query: jest.fn(async (sql: string, params: any[]) => {
                conn._calls.push({ sql, params });
                if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsed) }]];
                if (/SELECT chainId/.test(sql)) return [[{ chainId: 3 }]]; // runner-up 555 is same-chain
                return [{ affectedRows: 1 }];
            }),
        };
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);
        expect(result).toBe(true);
        const line = writtenParsed(conn).products[0];
        expect(line.storeProductId).toBe(555);
        expect(line.matchConfirmed).toBe(true);
        expect(line.matchedName).toBe('Raudonos paprikos');
        expect(line.priceVerified).toBe(false);
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(false);
    });

    it('a CROSS-chain runner-up is NOT re-pointed (falls to OCR — no bootstrap in the vote path)', async () => {
        const parsed = {
            header: { chainId: 3 },
            products: [slyvosLine({
                altMatches: [
                    { storeProductId: 240, confidence: 0.69, name: 'Raudonosios slyvos' },
                    { storeProductId: 556, confidence: 0.9, name: 'Cross-chain SP' }, // strong but other chain
                ],
            })],
        };
        const conn: any = {
            _calls: [] as any[],
            query: jest.fn(async (sql: string, params: any[]) => {
                conn._calls.push({ sql, params });
                if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsed) }]];
                if (/SELECT chainId/.test(sql)) return [[{ chainId: 1 }]]; // runner-up 556 is a DIFFERENT chain
                return [{ affectedRows: 1 }];
            }),
        };
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);
        expect(result).toBe(true);
        const line = writtenParsed(conn).products[0];
        expect(line.storeProductId).toBeNull();
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(true);
    });

    it('reject with no runner-up + a valid price → mints a quarantined orphan (keeps price, unverified)', async () => {
        const parsed = { header: { chainId: 3 }, products: [slyvosLine({ price: 3.49, isWeighable: true })] };
        const conn: any = {
            _calls: [] as any[],
            query: jest.fn(async (sql: string, params: any[]) => {
                conn._calls.push({ sql, params });
                if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify(parsed) }]];
                if (/FROM Category/.test(sql)) return [[{ id: 688 }]];           // getUnassignedCategoryId
                if (/FROM Product WHERE categoryId/.test(sql)) return [[]];       // resolveBaseProductId → no cluster
                if (/INSERT INTO Product/.test(sql)) return [{ insertId: 5000 }]; // fresh orphan Product
                if (/INSERT INTO StoreProduct/.test(sql)) return [{ insertId: 9000 }]; // fresh orphan SP
                return [{ affectedRows: 1 }];
            }),
        };
        const line = await demoteReceiptLineDirect(108, 0, conn);
        expect(line.storeProductId).toBe(9000); // re-pointed to the fresh orphan SP
        expect(line.matchConfirmed).toBe(false);
        expect(line.priceVerified).toBe(false);
        expect(line.matchedName).toBeNull();
        // the recorded price was moved onto the orphan, unverified
        const move = conn._calls.find((c: any) => /UPDATE Price SET storeProductId/.test(c.sql));
        expect(move.params).toEqual([9000, 108, 97651]); // newSp, receiptId, oldSp(lineSp)
    });

    it('demoteReceiptLineDirect (self-pair) demotes the line at lineIdx regardless of pair', async () => {
        const conn = makeConn({ header: { chainId: 3 }, products: [slyvosLine()] });
        const result = await demoteReceiptLineDirect(108, 0, conn);
        expect(result).toBeTruthy();
        const line = writtenParsed(conn).products[0];
        expect(line.storeProductId).toBeNull();
        expect(line.matchConfirmed).toBe(false);
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(true);
    });

    it('no parsedData / no matching line → false, no write', async () => {
        const conn = makeConn({ products: [slyvosLine({ storeProductId: 5000 })] }); // no line owns 97651/240
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);
        expect(result).toBe(false);
        expect(conn._calls.some((c: any) => /UPDATE Receipt/.test(c.sql))).toBe(false);
    });
});
