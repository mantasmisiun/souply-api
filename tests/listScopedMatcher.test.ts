import { jest } from '@jest/globals';

/**
 * List-scoped candidate BOOSTING (list-narrowing): once a receipt is linked to a
 * shopping list, the list's products fish same-chain SPs for the receipt's still-
 * UNLINKED (S2/S3) lines, re-scored at the relaxed floor. Survivors APPEND to
 * altMatches flagged `viaList` — never auto-linked, never filtering the existing
 * ladder. The same-chain SP resolution is mocked; the relaxed scorer + the append/
 * update/exclusion logic (the part worth pinning) are the REAL ones.
 */
const mockGetChainSps = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeProductModel.js', () => ({
    getChainSpsByProductIds: mockGetChainSps,
}));

const { fishListScopedCandidates } = await import('../src/services/listScopedMatcher.js');

const listSp = (o: Record<string, any>) => ({
    storeProductId: 0, productId: 0, categoryId: null, categoryName: null, categoryL2Name: null,
    name: '', brandName: null, amount: null, unit: null, isWeighable: false, isCatalog: true,
    ...o,
});

// A mock conn: the ReceiptItem SELECT returns `rows`; UPDATE ReceiptItem is captured.
function makeConn(rows: any[]) {
    const updates: Array<{ sql: string; params: any[] }> = [];
    const db: any = {
        query: jest.fn(async (sql: string, params: any[]) => {
            if (/FROM ReceiptItem/i.test(sql) && /SELECT/i.test(sql)) return [rows];
            if (/UPDATE ReceiptItem/i.test(sql)) { updates.push({ sql, params }); return [{ affectedRows: 1 }]; }
            return [{ affectedRows: 1 }];
        }),
        updates,
    };
    return db;
}

beforeEach(() => { mockGetChainSps.mockReset(); });

describe('fishListScopedCandidates', () => {
    it('appends a viaList altMatch when an unlinked line fuzzy-matches a list product SP', async () => {
        mockGetChainSps.mockResolvedValue([
            listSp({ storeProductId: 5001, productId: 900, name: 'Naminis pienas 2,5% 1L' }),
        ]);
        const conn = makeConn([
            { lineIdx: 0, name: 'NAMINIS PIENAS 2.5% 1L', matchedSpId: null, altMatches: [] },
        ]);
        const n = await fishListScopedCandidates(101, 3, [900], conn);
        expect(n).toBe(1);
        expect(conn.updates.length).toBe(1);
        const written = JSON.parse(conn.updates[0].params[0]); // UPDATE ... SET altMatches = ?
        const added = written.filter((a: any) => a.viaList);
        expect(added.map((a: any) => a.storeProductId)).toEqual([5001]);
        expect(added[0].confidence).toBeGreaterThanOrEqual(0.45);
    });

    it('preserves existing candidates (BOOSTER, never a filter) and excludes SPs already present', async () => {
        mockGetChainSps.mockResolvedValue([
            listSp({ storeProductId: 5001, productId: 900, name: 'Naminis pienas 2,5% 1L' }), // already in altMatches
            listSp({ storeProductId: 5002, productId: 901, name: 'Naminis pienas 2,5% 2L' }), // new list hit
        ]);
        const conn = makeConn([
            { lineIdx: 0, name: 'NAMINIS PIENAS 2.5%', matchedSpId: null,
              altMatches: [{ storeProductId: 5001, confidence: 0.7, name: 'Naminis pienas 2,5% 1L' }] },
        ]);
        const n = await fishListScopedCandidates(101, 3, [900, 901], conn);
        expect(n).toBe(1);
        const written = JSON.parse(conn.updates[0].params[0]);
        // original candidate still first + untouched
        expect(written[0].storeProductId).toBe(5001);
        expect(written[0].viaList).toBeUndefined();
        // only the NOT-already-present SP was appended, flagged viaList
        expect(written.filter((a: any) => a.viaList).map((a: any) => a.storeProductId)).toEqual([5002]);
    });

    it('appends nothing when no list SP name clears the relaxed floor', async () => {
        mockGetChainSps.mockResolvedValue([
            listSp({ storeProductId: 7777, productId: 42, name: 'Degtinė ABSOLUT 40% 0,7L' }),
        ]);
        const conn = makeConn([
            { lineIdx: 0, name: 'BANANAI', matchedSpId: null, altMatches: [] },
        ]);
        const n = await fishListScopedCandidates(101, 3, [42], conn);
        expect(n).toBe(0);
        expect(conn.updates.length).toBe(0);
    });

    it('never touches a line that already has a matchedSpId', async () => {
        mockGetChainSps.mockResolvedValue([
            listSp({ storeProductId: 5001, productId: 900, name: 'Naminis pienas 2,5% 1L' }),
        ]);
        // matchedSpId present → even if it surfaced, the per-row guard skips it.
        const conn = makeConn([
            { lineIdx: 0, name: 'NAMINIS PIENAS 2.5% 1L', matchedSpId: 4321, altMatches: [] },
        ]);
        const n = await fishListScopedCandidates(101, 3, [900], conn);
        expect(n).toBe(0);
        expect(conn.updates.length).toBe(0);
    });

    it('no list products / no same-chain SPs → no-op (fail-open, no writes)', async () => {
        mockGetChainSps.mockResolvedValue([]);
        const conn = makeConn([{ lineIdx: 0, name: 'ANYTHING', matchedSpId: null, altMatches: [] }]);
        expect(await fishListScopedCandidates(101, 3, [], conn)).toBe(0);   // empty productIds → short-circuits
        expect(await fishListScopedCandidates(101, 3, [900], conn)).toBe(0); // no SPs resolved
        expect(conn.updates.length).toBe(0);
    });
});
