import { jest } from '@jest/globals';

const mockPoolQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockPoolQuery },
}));

let fuzzyMatchSp: any;
let fuzzyMatchSpMulti: any;

beforeAll(async () => {
    const mod = await import('../src/scrapers/shared/productMatcher.js');
    fuzzyMatchSp = mod.fuzzyMatchSp;
    fuzzyMatchSpMulti = mod.fuzzyMatchSpMulti;
});

beforeEach(() => {
    jest.resetAllMocks();
});

function spRow(id: number, name: string, amount: number | null, unit: string | null) {
    return { id, productId: id * 10, storeProductName: name, amount, unit };
}

// ---------------------------------------------------------------------------
// Family gate — refuses to merge incoming SP with an existing SP whose unit
// family is different (e.g. an all-kg Product getting a stray 1 vnt bag).
// ---------------------------------------------------------------------------

// `_spIndexes` inside productMatcher is a module-level cache keyed by
// chainId. Use a fresh chainId per test so each one populates its own
// cache slot from the mocked query response. Reset jest.resetModules in
// beforeAll is too coarse (re-imports the module); fresh chainId is
// simpler and sufficient.
let nextChainId = 1000;
const chain = () => nextChainId++;

describe('fuzzyMatchSp — unit family gate', () => {
    it('blocks merge when incoming unit family differs from matched SP family', async () => {
        const c = chain();
        mockPoolQuery.mockResolvedValueOnce([[
            spRow(1, 'pienas dvaras', 1, 'kg'),
        ]]);
        const result = await fuzzyMatchSp(c, 'pienas dvaras', 1, 'vnt');
        expect(result).toBeNull();
    });

    it('allows merge when families match (kg ↔ l, both fluid)', async () => {
        const c = chain();
        mockPoolQuery.mockResolvedValueOnce([[
            spRow(1, 'pienas dvaras', 1, 'l'),
        ]]);
        const result = await fuzzyMatchSp(c, 'pienas dvaras', 1, 'kg');
        expect(result).not.toBeNull();
        expect(result!.id).toBe(1);
    });

    it('allows merge when families match (g and ml — both fluid)', async () => {
        const c = chain();
        mockPoolQuery.mockResolvedValueOnce([[
            spRow(1, 'jogurtas', 500, 'g'),
        ]]);
        const result = await fuzzyMatchSp(c, 'jogurtas', 500, 'ml');
        expect(result).not.toBeNull();
    });

    it('allows merge when incoming unit is unknown (preserve current behaviour)', async () => {
        const c = chain();
        mockPoolQuery.mockResolvedValueOnce([[
            spRow(1, 'some product', 1, 'kg'),
        ]]);
        const result = await fuzzyMatchSp(c, 'some product', null, null);
        expect(result).not.toBeNull();
    });

    it('allows merge when matched SP unit is unknown', async () => {
        const c = chain();
        mockPoolQuery.mockResolvedValueOnce([[
            spRow(1, 'older product', null, null),
        ]]);
        const result = await fuzzyMatchSp(c, 'older product', 1, 'kg');
        expect(result).not.toBeNull();
    });

    it('vnt vs pak (different count sub-units) — still allowed (both count family)', async () => {
        // The matcher gate operates at the family level — sub-unit
        // disambiguation (vnt vs pak) happens later at canonicalize() time.
        const c = chain();
        mockPoolQuery.mockResolvedValueOnce([[
            spRow(1, 'kiausiniai pakuote', 10, 'vnt'),
        ]]);
        const result = await fuzzyMatchSp(c, 'kiausiniai pakuote', 1, 'pak');
        expect(result).not.toBeNull();
    });
});

describe('fuzzyMatchSpMulti — unit family gate', () => {
    it('filters out matches whose family differs from incoming', async () => {
        const c = chain();
        mockPoolQuery.mockResolvedValueOnce([[
            spRow(1, 'pienas dvaras', 1, 'kg'),
            spRow(2, 'pienas dvaras', 1, 'l'),
            spRow(3, 'pienas dvaras', 1, 'vnt'),
        ]]);
        const results = await fuzzyMatchSpMulti(c, 'pienas dvaras', 1, 'kg', 5);
        const ids = results.map((r: any) => r.id);
        expect(ids).not.toContain(3);
        expect(ids.length).toBeGreaterThan(0);
    });
});
