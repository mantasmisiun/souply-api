import { jest } from '@jest/globals';

// applyReceiptAutosave uses the module-level pool for the row-count gate AND a pooled
// connection for the merge transaction — mock both through one scriptable query fn.
const mockQuery = jest.fn<any>();
const mockConn = {
    query: mockQuery,
    beginTransaction: jest.fn<any>(async () => {}),
    commit: jest.fn<any>(async () => {}),
    rollback: jest.fn<any>(async () => {}),
    release: jest.fn(),
};
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockQuery, getConnection: async () => mockConn },
}));

let applyReceiptAutosave: any;
beforeAll(async () => {
    const mod = await import('../src/services/receiptSaveService.js');
    applyReceiptAutosave = mod.applyReceiptAutosave;
});

// Scriptable SQL router: handlers matched in order, first regex wins.
type Handler = { match: RegExp; resp: (params: any[]) => any };
function scriptQueries(handlers: Handler[]) {
    mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
        for (const h of handlers) if (h.match.test(sql)) return h.resp(params);
        return [{ affectedRows: 1 }];
    });
}
const calls = (re: RegExp) => mockQuery.mock.calls.filter((c: any) => re.test(c[0]));

const baseInput = {
    chainId: 3, storeId: 440, receiptNo: '11/22/333', date: '2026-06-20', time: '12:00',
    products: [],
};
const blob = (products: any[]) => ({
    header: { chainId: 3, storeId: 440 },
    footer: { receiptNo: '11/22/333', receiptNos: ['11/22/333'], date: '2026-06-20', time: '12:00', rawText: 'SECRET' },
    products,
});

// One existing row: lineIdx 0, matched to SP 500, price 2.00.
const ROW = { id: 900, lineIdx: 0, name: 'PIENAS', price: '2.00', promoPrice: null, quantity: '1.000', unit: 'vnt', matchedSpId: 500 };

beforeEach(() => jest.clearAllMocks());

describe('applyReceiptAutosave — ownership-aware merge', () => {
    it('merges user content edits (price) into the row and its own Price row — no DELETE, no re-adjudication', async () => {
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[{ ...ROW }]] },
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        const res = await applyReceiptAutosave(206, 'u1', blob([
            { name: 'PIENAS', price: 2.5, promoPrice: null, quantity: 1, unit: 'vnt', storeProductId: 500 },
        ]), baseInput);

        expect(res.saved).toBe(1);
        // The item UPDATE carries ONLY the changed content field.
        const itemUpdates = calls(/UPDATE ReceiptItem SET/);
        expect(itemUpdates).toHaveLength(1);
        expect(itemUpdates[0][0]).toContain('price = ?');
        expect(itemUpdates[0][0]).not.toContain('matchedSpId');
        expect(itemUpdates[0][0]).not.toContain('matchConfirmed');
        expect(itemUpdates[0][0]).not.toContain('priceVerified');
        // The line's own Price row is updated IN PLACE via receiptItemId; an edited
        // value is no longer the verified observation, so priceVerified resets.
        const priceUpdates = calls(/UPDATE Price SET price = \?, promoPrice = \?, priceVerified = 0 WHERE receiptItemId/);
        expect(priceUpdates).toHaveLength(1);
        expect(priceUpdates[0][1]).toEqual([2.5, null, 900]);
        // Nothing was deleted, nothing re-resolved.
        expect(calls(/DELETE FROM/)).toHaveLength(0);
        expect(mockConn.commit).toHaveBeenCalled();
    });

    it('a STALE client SP (differs, no manualMatch flag) does NOT overwrite the row match', async () => {
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[{ ...ROW }]] },
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        // Client still holds the pre-Round-2 pick (SP 111) — server row says 500.
        const res = await applyReceiptAutosave(206, 'u1', blob([
            { name: 'PIENAS', price: 2, promoPrice: null, quantity: 1, unit: 'vnt', storeProductId: 111 },
        ]), baseInput);

        expect(res.saved).toBe(0);
        expect(calls(/UPDATE ReceiptItem SET/)).toHaveLength(0);
    });

    it('manualMatch: true applies the new SP (same chain), unverifies + repoints the Price row', async () => {
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[{ ...ROW }]] },
            { match: /SELECT chainId FROM StoreProduct WHERE id = \?/, resp: () => [[{ chainId: 3 }]] },
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        const res = await applyReceiptAutosave(206, 'u1', blob([
            { name: 'PIENAS', price: 2, promoPrice: null, quantity: 1, unit: 'vnt',
              storeProductId: 777, matchedName: 'Pienas DVARO', manualMatch: true },
        ]), baseInput);

        expect(res.saved).toBe(1);
        const itemUpdate = calls(/UPDATE ReceiptItem SET/)[0];
        expect(itemUpdate[0]).toContain('matchedSpId = ?');
        expect(itemUpdate[0]).toContain('matchConfirmed = ?'); // reset to false — not vote-confirmed
        const repoint = calls(/UPDATE Price SET storeProductId = \?, priceVerified = 0 WHERE receiptItemId/);
        expect(repoint).toHaveLength(1);
        expect(repoint[0][1]).toEqual([777, 900]);
    });

    it('manualMatch rejects a WRONG-CHAIN SP (no cross-chain link via autosave)', async () => {
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[{ ...ROW }]] },
            { match: /SELECT chainId FROM StoreProduct WHERE id = \?/, resp: () => [[{ chainId: 2 }]] }, // Rimi SP on an IKI receipt
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        const res = await applyReceiptAutosave(206, 'u1', blob([
            { name: 'PIENAS', price: 2, promoPrice: null, quantity: 1, unit: 'vnt',
              storeProductId: 777, manualMatch: true },
        ]), baseInput);

        expect(res.saved).toBe(0);
        expect(calls(/UPDATE ReceiptItem SET/)).toHaveLength(0);
    });

    it('strips header/footer rawText and keeps products: [] in the blob write', async () => {
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[{ ...ROW }]] },
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        await applyReceiptAutosave(206, 'u1', blob([]), baseInput);

        const blobWrite = calls(/UPDATE Receipt\b/).find((c: any) => /parsedData/.test(c[0]));
        expect(blobWrite).toBeTruthy();
        const written = JSON.parse(blobWrite![1][3]);
        expect(written.products).toEqual([]);
        expect(written.footer.rawText).toBeUndefined();
    });

    it('a nonpositive edited price updates the ReceiptItem but NEVER reaches the Price table', async () => {
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[{ ...ROW }]] },
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        await applyReceiptAutosave(206, 'u1', blob([
            { name: 'PIENAS', price: 0, promoPrice: null, quantity: 1, unit: 'vnt', storeProductId: 500 },
        ]), baseInput);

        expect(calls(/UPDATE ReceiptItem SET/)).toHaveLength(1);         // display keeps the edit
        expect(calls(/UPDATE Price SET price/)).toHaveLength(0);         // reference table protected
    });

    it('manual rematch of a previously-UNMATCHED line INSERTS the missing Price row', async () => {
        const unmatchedRow = { ...ROW, matchedSpId: null };
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[unmatchedRow]] },
            { match: /SELECT chainId FROM StoreProduct WHERE id = \?/, resp: () => [[{ chainId: 3 }]] },
            // The repoint UPDATE hits no row (unmatched lines never wrote a Price).
            { match: /UPDATE Price SET storeProductId/, resp: () => [{ affectedRows: 0 }] },
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        await applyReceiptAutosave(206, 'u1', blob([
            { name: 'PIENAS', price: 2, promoPrice: null, quantity: 1, unit: 'vnt',
              storeProductId: 777, matchedName: 'Pienas DVARO', manualMatch: true },
        ]), baseInput);

        // createPrice INSERT lands with the receiptItemId link (unverified, non-fallback).
        const inserts = calls(/INSERT INTO Price/);
        expect(inserts).toHaveLength(1);
        expect(inserts[0][1]).toEqual(expect.arrayContaining([777, 440, 2, 206, 900]));
    });

    it('autosave never creates lines for client indexes with no row', async () => {
        scriptQueries([
            { match: /SELECT COUNT\(\*\) AS n FROM ReceiptItem/, resp: () => [[{ n: 1 }]] },
            { match: /FROM ReceiptItem WHERE receiptId = \? FOR UPDATE/, resp: () => [[{ ...ROW }]] },
            { match: /SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem/, resp: () => [[]] },
        ]);

        await applyReceiptAutosave(206, 'u1', blob([
            { name: 'PIENAS', price: 2, quantity: 1, unit: 'vnt', storeProductId: 500 },
            { name: 'PHANTOM', price: 9.99, quantity: 1, unit: 'vnt' }, // lineIdx 1 — no row
        ]), baseInput);

        expect(calls(/INSERT INTO ReceiptItem/)).toHaveLength(0);
    });
});
