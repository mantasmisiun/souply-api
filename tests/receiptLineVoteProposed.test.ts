import { jest } from '@jest/globals';
import { castReceiptLineVote } from '../src/services/receiptLineVoteService.js';
import { lineToItem } from '../src/models/receiptItemModel.js';

/**
 * PROPOSED-card votes (receipt-237 salmon): the line is UNLINKED and the card showed
 * the best altMatches candidate; the client echoes it as proposedSpId.
 *   identical → LINK the candidate (user name-confirm; price stays UNVERIFIED — a
 *               swipe must not launder a price Round-2 declined to confirm).
 *   different/similar → alias verdict only; the line stays unlinked, no demotion.
 * Validation: the id must be among the line's STORED altMatches and same-chain.
 */
function makeConn(pd: any, spChain: Record<number, number> = {}) {
    const lines = Array.isArray(pd?.products) ? pd.products : [];
    const chainId = Number(pd?.header?.chainId) || 3;
    const rows = lines.map((line: any, i: number) => lineToItem(237, i, line));
    const calls: Array<{ sql: string; params: any[] }> = [];
    const conn: any = {
        _calls: calls,
        query: jest.fn(async (sql: string, params: any[]) => {
            calls.push({ sql, params });
            if (/storeProductName, imageUrl, chainId FROM StoreProduct/.test(sql)) {
                const id = Number(params?.[0]);
                return [spChain[id] != null
                    ? [{ storeProductName: `SP ${id}`, imageUrl: `sp${id}.jpg`, chainId: spChain[id] }]
                    : []];
            }
            if (/FROM ReceiptItem/.test(sql)) {
                if (/lineIdx = \?/.test(sql)) {
                    const r = rows.find((r: any) => r.lineIdx === params[1]);
                    return [r ? [r] : []];
                }
                return [rows];
            }
            if (/SELECT parsedData/.test(sql)) return [[{ parsedData: JSON.stringify({ header: { chainId } }) }]];
            if (/SELECT receiptLineIdx/.test(sql)) return [[]];
            return [{ affectedRows: 1 }];
        }),
    };
    return conn;
}

const salmon = (o: Record<string, any> = {}) => ({
    name: 'ATLATINES LAŠISOSs BE GAL',
    storeProductId: null, matchedName: null, matchConfidence: 0.69,
    price: 16.99, promoPrice: 9.99, quantity: 1.068,
    itemConfidence: { band: 'S2' },
    altMatches: [
        { storeProductId: 58876, confidence: 0.69, name: 'lašišos 4/6', categoryId: 42, categoryName: 'Žuvis', categoryL2Name: 'Šviežia žuvis' },
        { storeProductId: 97839, confidence: 0.58, name: 'lašišų gabalai', viaPrice: true },
    ],
    ...o,
});

const itemUpdate = (conn: any) => conn._calls.find((c: any) => /UPDATE ReceiptItem/.test(c.sql));

describe('castReceiptLineVote — proposedSpId path', () => {
    it('identical + valid proposal → LINKS the SP, price stays unverified, category from the candidate', async () => {
        const conn = makeConn({ products: [salmon()] }, { 58876: 3 });
        const line = await castReceiptLineVote(237, 0, 'identical', conn, 'user-1', 58876);
        expect(line.storeProductId).toBe(58876);
        expect(line.matchConfirmed).toBe(true);
        expect(line.priceVerified).toBe(false);
        expect(line.matchedName).toBe('SP 58876');
        expect(line.storeProductImageUrl).toBe('sp58876.jpg');
        expect(line.categoryId).toBe(42);
        expect(line.itemConfidence.override).toBe('user_confirmed');
        expect(itemUpdate(conn)).toBeTruthy();
        // NO Price-verified write for a proposal confirm (that flag is Round-2's).
        expect(conn._calls.some((c: any) => /UPDATE Price/.test(c.sql))).toBe(false);
    });

    it('different + proposal → line stays unlinked (alias verdict only, no demotion write)', async () => {
        const conn = makeConn({ products: [salmon()] }, { 58876: 3 });
        const line = await castReceiptLineVote(237, 0, 'different', conn, 'user-1', 58876);
        expect(line.storeProductId).toBeNull();
        expect(line.matchConfirmed).toBeFalsy();
        expect(itemUpdate(conn)).toBeFalsy();
    });

    it('rejects a proposedSpId that is NOT among the line stored candidates', async () => {
        const conn = makeConn({ products: [salmon()] }, { 424242: 3 });
        const line = await castReceiptLineVote(237, 0, 'identical', conn, 'user-1', 424242);
        // degrades to the plain unlinked behavior: nothing to confirm
        expect(line).toBeNull();
    });

    it('rejects a cross-chain proposedSpId', async () => {
        const conn = makeConn({ products: [salmon()] }, { 58876: 1 }); // Maxima SP on an IKI receipt
        const line = await castReceiptLineVote(237, 0, 'identical', conn, 'user-1', 58876);
        expect(line).toBeNull();
    });

    it('ignores proposedSpId when the line is already LINKED (normal confirm path wins)', async () => {
        const conn = makeConn({ products: [salmon({ storeProductId: 61591, matchedName: 'Colgate' })] }, { 58876: 3 });
        const line = await castReceiptLineVote(237, 0, 'identical', conn, 'user-1', 58876);
        expect(line.storeProductId).toBe(61591); // kept — proposal path never fires on linked lines
        expect(line.matchConfirmed).toBe(true);
    });
});
