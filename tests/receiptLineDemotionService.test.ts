import { jest } from '@jest/globals';
import { demoteRejectedReceiptLine, demoteReceiptLineDirect } from '../src/services/receiptLineDemotionService.js';
import { lineToItem } from '../src/models/receiptItemModel.js';

// Mock connection (P2 Step C): the demotion now reads the line from ReceiptItem rows (built
// here via lineToItem from the seeded `products`), the chainId from the receipt header, and
// writes the mutation as a single-row UPDATE ReceiptItem. `spChain` = the chainId returned
// for the runner-up SP lookup (same-chain re-point vs cross-chain OCR-clear).
function makeConn(pd: any, spChain = 3) {
    const lines = Array.isArray(pd?.products) ? pd.products : [];
    const chainId = Number(pd?.header?.chainId) || 3;
    const rows = lines.map((line: any, i: number) => lineToItem(108, i, line));
    const calls: Array<{ sql: string; params: any[] }> = [];
    const conn: any = {
        _calls: calls,
        query: jest.fn(async (sql: string, params: any[]) => {
            calls.push({ sql, params });
            if (/FROM ReceiptItem/.test(sql)) {
                if (/matchedSpId IN/.test(sql)) {
                    const [, a, b] = params; // receiptId, spA, spB
                    return [rows.filter((r: any) => r.matchedSpId === a || r.matchedSpId === b)];
                }
                if (/lineIdx = \?/.test(sql)) {
                    const r = rows.find((r: any) => r.lineIdx === params[1]);
                    return [r ? [r] : []];
                }
                return [rows];
            }
            if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify({ header: { chainId } }) }]];
            if (/chainId FROM StoreProduct|SELECT chainId/.test(sql)) return [[{ chainId: spChain }]];
            return [{ affectedRows: 1 }];
        }),
    };
    return conn;
}

// Reconstruct the line's mutated match-state from the single-row UPDATE ReceiptItem — same
// shape the tests used to read from the (now-gone) parsedData blob write.
function patchedLine(conn: any) {
    const upd = conn._calls.find((c: any) => /UPDATE ReceiptItem SET/.test(c.sql));
    if (!upd) return null;
    const cols = [...upd.sql.matchAll(/(\w+) = \?/g)].map((m: any) => m[1]);
    const o: any = {};
    cols.forEach((c: string, i: number) => { o[c] = upd.params[i]; });
    return {
        storeProductId: o.matchedSpId,
        matchConfirmed: o.matchConfirmed === 1,
        matchedName: o.matchedName,
        priceVerified: o.priceVerified === 1,
        itemConfidence: o.itemConfidence ? JSON.parse(o.itemConfidence) : null,
    };
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


describe('demoteRejectedReceiptLine', () => {
    it('demotes a line whose top-altMatch identity the user rejected → clears to OCR + userRejected veto', async () => {
        const conn = makeConn({ products: [slyvosLine()] });
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);

        expect(result).toBe(true);
        const line = patchedLine(conn);
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
        expect(patchedLine(conn).storeProductId).toBeNull();
    });

    it('does NOT demote when the rejected SP is a LOWER altMatch, not the primary identity', async () => {
        const conn = makeConn({ products: [slyvosLine()] });
        const result = await demoteRejectedReceiptLine(108, 97651, 205, conn); // 205 = altMatches[1]
        expect(result).toBe(false);
        expect(conn._calls.some((c: any) => /UPDATE ReceiptItem/.test(c.sql))).toBe(false);
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
        const conn = makeConn(parsed, 3); // runner-up 555 is same-chain
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);
        expect(result).toBe(true);
        const line = patchedLine(conn);
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
        const conn = makeConn(parsed, 1); // runner-up 556 is a DIFFERENT chain
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);
        expect(result).toBe(true);
        const line = patchedLine(conn);
        expect(line.storeProductId).toBeNull();
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(true);
    });

    it('reject with no runner-up + a valid price → NO-MINT: clears to OCR, marks the rejected price unverified', async () => {
        const parsed = { header: { chainId: 3 }, products: [slyvosLine({ price: 3.49, isWeighable: true })] };
        const conn = makeConn(parsed);
        const line = await demoteReceiptLineDirect(108, 0, conn);
        expect(line.storeProductId).toBeNull();  // NO orphan minted — cleared to OCR
        expect(line.matchConfirmed).toBe(false);
        expect(line.priceVerified).toBe(false);
        expect(line.matchedName).toBeNull();
        // No SP/Product was created.
        expect(conn._calls.some((c: any) => /INSERT INTO StoreProduct/.test(c.sql))).toBe(false);
        expect(conn._calls.some((c: any) => /INSERT INTO Product/.test(c.sql))).toBe(false);
        // The rejected match's Price was marked UNVERIFIED (not moved to an orphan).
        // TWO statements since the index-defeating OR was split (each binds receiptId, sp):
        // one for receiptItemId-linked rows, one for the legacy receiptId+sp rows.
        const unverifies = conn._calls.filter((c: any) => /UPDATE Price SET priceVerified = 0/.test(c.sql));
        expect(unverifies).toHaveLength(2);
        expect(unverifies[0].params).toEqual([108, 97651]);
        expect(unverifies[1].params).toEqual([108, 97651]);
    });

    it('demoteReceiptLineDirect (self-pair) demotes the line at lineIdx regardless of pair', async () => {
        const conn = makeConn({ header: { chainId: 3 }, products: [slyvosLine()] });
        const result = await demoteReceiptLineDirect(108, 0, conn);
        expect(result).toBeTruthy();
        const line = patchedLine(conn);
        expect(line.storeProductId).toBeNull();
        expect(line.matchConfirmed).toBe(false);
        expect(line.itemConfidence.vetoes.some((v: any) => v.reason === 'userRejected')).toBe(true);
    });

    it('no parsedData / no matching line → false, no write', async () => {
        const conn = makeConn({ products: [slyvosLine({ storeProductId: 5000 })] }); // no line owns 97651/240
        const result = await demoteRejectedReceiptLine(108, 97651, 240, conn);
        expect(result).toBe(false);
        expect(conn._calls.some((c: any) => /UPDATE ReceiptItem/.test(c.sql))).toBe(false);
    });
});
