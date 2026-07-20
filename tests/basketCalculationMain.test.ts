import { jest } from '@jest/globals';

const mockPoolQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockPoolQuery },
}));

const mockGetClosestStores = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeModel.js', () => ({
    getClosestStores: mockGetClosestStores,
    getStoresByIdsWithDistance: jest.fn(),
    getStoreById: jest.fn(),
    getClosestStorePerChainToStore: jest.fn(),
}));

const mockGetBasketProductIds = jest.fn<any>();
const mockGetBasketOwnerId = jest.fn<any>().mockResolvedValue(null); // no owner → personal tier skipped
jest.unstable_mockModule('../src/models/basketModel.js', () => ({
    getBasketProductIds: mockGetBasketProductIds,
    getBasketOwnerId: mockGetBasketOwnerId,
}));

// Linked-set (personal + merge) expansion — default to EMPTY so the existing
// tier tests keep their deterministic pool.query sequence. Individual tests
// override it to exercise the personal/merge tiers.
const mockFetchLinkedSets = jest.fn<any>().mockResolvedValue({ personal: new Map(), merge: new Map() });
jest.unstable_mockModule('../src/models/linkedProductModel.js', () => ({
    fetchLinkedSets: mockFetchLinkedSets,
}));

// Tier-3 now scores the chain's cached candidates (with learned aliases) via the
// advanced matcher instead of a LIKE query. Mock the candidate source so the
// pool.query sequence stays deterministic (default: no candidates → no substitute).
const mockGetCachedChainCandidates = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeProductModel.js', () => ({
    getCachedChainCandidates: mockGetCachedChainCandidates,
}));

let calculateBasketForStores: any;

beforeAll(async () => {
    const mod = await import('../src/services/basketCalculationService.js');
    calculateBasketForStores = mod.calculateBasketForStores;
});

beforeEach(() => {
    jest.resetAllMocks();
    // resetAllMocks() wipes module-level defaults — re-establish the inert ones.
    mockFetchLinkedSets.mockResolvedValue({ personal: new Map(), merge: new Map() });
    mockGetBasketOwnerId.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(id: number, overrides: Record<string, any> = {}) {
    return {
        id,
        name: `Store ${id}`,
        chainName: 'Maxima',
        chainId: 1,
        logoUrl: null,
        address: `Addr ${id}`,
        distance: id * 0.5,
        ...overrides,
    };
}

function makeBasketItem(overrides: Record<string, any> = {}) {
    return { productId: 100, quantity: '2', name: 'Pienas', matchMode: 'sku', ...overrides };
}

/**
 * SP row returned by batchFetchTier12Prices step 1:
 *   SELECT sp.id, sp.productId, sp.storeProductName, sp.isWeighable,
 *          sp.amount, sp.unit, prod.baseProductId
 */
function makeSpDbRow(overrides: Record<string, any> = {}) {
    return {
        id: 10,
        productId: 100,
        storeProductName: 'Pienas 1L',
        isWeighable: 0,
        amount: '1',
        unit: 'vnt',
        baseProductId: null,
        ...overrides,
    };
}

/**
 * Price row returned by fetchLatestPrices (batchFetchTier12Prices step 2):
 *   SELECT p.storeProductId, p.storeId, p.price, p.promoPrice, p.isFallback
 */
function makePriceDbRow(storeId: number, price: string, overrides: Record<string, any> = {}) {
    return {
        storeProductId: 10,
        storeId,
        price,
        promoPrice: null,
        isFallback: 0,
        ...overrides,
    };
}

/**
 * Queue the mock pool responses for a calculateBasketForStores call
 * (single chain, single product, N stores). After the canonical-unit
 * refactor the query order is:
 *
 *   Call 1  — fetchAllSpMetadata: every SP across every chain for the
 *             basket Products. Drives canonical-unit computation and
 *             feeds tier-4 cross-chain averaging.
 *   Call 2  — batchFetchTier12Prices step 1: SPs at relevant chains for
 *             the basket Products.
 *   Call 3  — batchFetchTier12Prices step 2: latest prices for those SPs
 *             at the user's stores (only if spRows.length > 0).
 *   Call 4  — batchFetchTier3Substitutes: LIKE candidate query (empty
 *             by default).
 *   Call 5  — approximateCrossChain: latest prices for tier-4 SPs (only
 *             when fetchAllSpMetadata returned anything).
 */
function setupTiers(
    spRows: any[],
    priceRows: any[],
    tier3Rows: any[] = [],
    tier4SpRows: any[] = [],
    tier4PriceRows: any[] = [],
) {
    // Combine tier-1/2 SPs with tier-4-only SPs into a single SP-metadata
    // result. Both are SPs of the basket Products; tier-1/2 is the
    // chain-filtered subset, tier-4 is anything stocked elsewhere.
    const seen = new Set<number>();
    const allSps: any[] = [];
    for (const r of [...spRows, ...tier4SpRows]) {
        const id = Number(r.id);
        if (seen.has(id)) continue;
        seen.add(id);
        allSps.push({
            id,
            productId: r.productId ?? 100,
            amount: r.amount,
            unit: r.unit,
            isWeighable: r.isWeighable,
        });
    }
    mockPoolQuery.mockResolvedValueOnce([allSps]);

    mockPoolQuery.mockResolvedValueOnce([spRows]);
    if (spRows.length > 0) {
        mockPoolQuery.mockResolvedValueOnce([priceRows]);
    }
    // Tier-3 no longer issues a candidate pool.query — it reads the mocked
    // getCachedChainCandidates (empty by default → no substitute, no price query).
    void tier3Rows;
    mockGetCachedChainCandidates.mockResolvedValue([]);
    // tier-4 prices query fires once per Product that has any SP metadata.
    if (allSps.length > 0) {
        mockPoolQuery.mockResolvedValueOnce([tier4PriceRows]);
    }
}

// ---------------------------------------------------------------------------
// Empty basket
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — empty basket', () => {
    it('returns [] without hitting the DB', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([]);

        const result = await calculateBasketForStores(1);

        expect(result).toEqual([]);
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tier-1/2 match (served from pre-fetched cache, no extra DB calls)
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — tier-1 match', () => {
    it('computes total as qty × effectivePrice for a direct match', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);
        setupTiers(
            [makeSpDbRow()],
            [makePriceDbRow(1, '2.50')],
        );

        const [store] = await calculateBasketForStores(1);

        expect(store.total).toBe(5.00); // 2 × 2.50
        expect(store.items[0].isMissing).toBe(false);
        expect(store.items[0].isSubstituted).toBe(false);
        expect(store.items[0].isCrossChainAverage).toBe(false);
        expect(store.isApproximated).toBe(false);
        expect(store.missingItemNames).toHaveLength(0);
    });

    it('uses promoPrice as effectivePrice when present', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);
        setupTiers(
            [makeSpDbRow()],
            [makePriceDbRow(1, '5.00', { promoPrice: '3.00' })],
        );

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].effectivePrice).toBeCloseTo(3.00);
        expect(store.total).toBe(6.00); // 2 × 3.00
    });

    it('preserves isFallback from the Price row', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);
        setupTiers(
            [makeSpDbRow()],
            [makePriceDbRow(1, '2.00', { isFallback: 1 })],
        );

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isFallback).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Missing item (no data at any tier)
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — missing item', () => {
    it('marks item missing and contributes 0 to total when no tier matches', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);
        // SP query returns empty → batchFetchTier12 returns early, no step-2 call
        // tier-3 LIKE returns empty → no substitute
        // tier-4 SP returns empty → approximateCrossChain returns null
        setupTiers([], [], [], []);

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isMissing).toBe(true);
        expect(store.missingItemNames).toContain('Pienas');
        expect(store.total).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Tier-3 substitute (advanced matcher)
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — tier-3 substitute', () => {
    it('finds and prices a name-similar substitute via the advanced typed matcher', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]); // "Pienas", product 100
        // fetchAllSpMetadata: product 100 exists (canonical/tier-4 machinery runs)…
        mockPoolQuery.mockResolvedValueOnce([[{ id: 10, productId: 100, amount: '1', unit: 'l', isWeighable: 0 }]]);
        // …but tier-1/2 miss at the target chain → falls to tier-3.
        mockPoolQuery.mockResolvedValueOnce([[]]);
        // Tier-3 candidates: a branded, name-similar SP of a DIFFERENT product, same
        // form (packaged). The matcher must match despite the extra "Rokiškio" word.
        mockGetCachedChainCandidates.mockResolvedValue([{
            id: 55, productId: 999, categoryId: 5, categoryName: null, categoryL2Name: null,
            storeProductName: 'Pienas Rokiškio 2,5%', brandName: null,
            amount: 1, unit: 'l', isWeighable: false, aliases: [],
        }]);
        // Tier-3 price for the winning SP.
        mockPoolQuery.mockResolvedValueOnce([[{ storeProductId: 55, storeId: 1, price: '1.20', promoPrice: null, isFallback: 0 }]]);
        // Tier-4 cross-chain prices (product 100) — empty, so the substitute wins.
        mockPoolQuery.mockResolvedValueOnce([[]]);

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isSubstituted).toBe(true);
        expect(store.items[0].isMissing).toBe(false);
        expect(store.total).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Personal & merge tiers (evidence ladder) — "same product, different signal"
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — personal & merge tiers', () => {
    it('PERSONAL: resolves via a product the viewer voted "same" when the exact SKU is absent', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem({ productId: 100, quantity: '1' })]);
        mockGetBasketOwnerId.mockResolvedValue('user-1');
        // Viewer personally linked product 100 ≡ 200; no global merge.
        mockFetchLinkedSets.mockResolvedValue({ personal: new Map([[100, new Set([200])]]), merge: new Map() });

        // Call 1: fetchAllSpMetadata — basket product 100 AND its linked product 200
        // (both fetched so the canonical unit family spans the merge group).
        mockPoolQuery.mockResolvedValueOnce([[
            { id: 10, productId: 100, amount: '1', unit: 'vnt', isWeighable: 0 },
            { id: 20, productId: 200, amount: '1', unit: 'vnt', isWeighable: 0 },
        ]]);
        // Call 2: tier-1/2 main SP query — EMPTY (no exact/cluster SKU at the chain)
        mockPoolQuery.mockResolvedValueOnce([[]]);
        // Call 3: linked SP query — the personally-linked product 200's SP
        mockPoolQuery.mockResolvedValueOnce([[makeSpDbRow({ id: 20, productId: 200, storeProductName: 'Pienas (kita SKU)' })]]);
        // Call 4: linked price — €2 at store 1
        mockPoolQuery.mockResolvedValueOnce([[makePriceDbRow(1, '2.00', { storeProductId: 20 })]]);
        // Call 5: tier-4 price — empty
        mockPoolQuery.mockResolvedValueOnce([[]]);

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isMissing).toBe(false);
        expect(store.items[0].isSubstituted).toBe(false); // personal = the product, not a substitute
        expect(store.items[0].isCrossChainAverage).toBe(false);
        expect(store.items[0].effectivePrice).toBeCloseTo(2.00);
        expect(store.total).toBe(2.00); // 1 × 2.00
    });

    it('MERGE: prices the cheapest of the exact SKU and a hard-merged sibling', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem({ productId: 100, quantity: '1' })]);
        mockGetBasketOwnerId.mockResolvedValue('user-1');
        // Product 100 hard-merged with 200 (community-promoted); no personal link.
        mockFetchLinkedSets.mockResolvedValue({ personal: new Map(), merge: new Map([[100, new Set([200])]]) });

        // Call 1: fetchAllSpMetadata — basket product 100 AND its linked product 200.
        mockPoolQuery.mockResolvedValueOnce([[
            { id: 10, productId: 100, amount: '1', unit: 'vnt', isWeighable: 0 },
            { id: 20, productId: 200, amount: '1', unit: 'vnt', isWeighable: 0 },
        ]]);
        // Call 2: tier-1/2 main SP — the exact SKU (product 100) IS present
        mockPoolQuery.mockResolvedValueOnce([[makeSpDbRow({ id: 10, productId: 100 })]]);
        // Call 3: main price — exact SKU = €5 (pricey)
        mockPoolQuery.mockResolvedValueOnce([[makePriceDbRow(1, '5.00', { storeProductId: 10 })]]);
        // Call 4: linked SP — the merged sibling product 200
        mockPoolQuery.mockResolvedValueOnce([[makeSpDbRow({ id: 20, productId: 200 })]]);
        // Call 5: linked price — merged sibling = €2 (cheaper → wins)
        mockPoolQuery.mockResolvedValueOnce([[makePriceDbRow(1, '2.00', { storeProductId: 20 })]]);
        // Call 6: tier-4 price — empty
        mockPoolQuery.mockResolvedValueOnce([[]]);

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isMissing).toBe(false);
        expect(store.items[0].isSubstituted).toBe(false);
        expect(store.items[0].effectivePrice).toBeCloseTo(2.00);
        expect(store.total).toBe(2.00); // 1 × 2.00, sibling undercuts the exact SKU
    });
});

// ---------------------------------------------------------------------------
// Tier-4 cross-chain average
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — tier-4 cross-chain average', () => {
    it('sets isCrossChainAverage and isApproximated when tier-4 is used', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);

        // No SP in this chain → tier-1 miss
        const tier4Sp = { id: 20, amount: '1', unit: 'vnt', isWeighable: 0 };
        const tier4Price = { storeProductId: 20, storeId: 1, price: '3.00', promoPrice: null, isFallback: 0 };
        setupTiers([], [], [], [tier4Sp], [tier4Price]);

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isCrossChainAverage).toBe(true);
        expect(store.isApproximated).toBe(true);
        expect(store.items[0].isMissing).toBe(false);
        expect(store.total).toBe(6.00); // 2 × 3.00
    });

    it('averages across multiple stores in the same pack-size bucket', async () => {
        // Two nearby stores; neither has a tier-1 SP for the product.
        // Both have prices for the product's SP (from another chain/context).
        mockGetClosestStores.mockResolvedValue([makeStore(10), makeStore(20)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem({ quantity: '1' })]);

        const tier4Sp = { id: 30, amount: '1', unit: 'vnt', isWeighable: 0 };
        const tier4Prices = [
            { storeProductId: 30, storeId: 10, price: '2.00', promoPrice: null, isFallback: 0 },
            { storeProductId: 30, storeId: 20, price: '4.00', promoPrice: null, isFallback: 0 },
        ];
        setupTiers([], [], [], [tier4Sp], tier4Prices);

        const results = await calculateBasketForStores(1);

        // Both stores use tier-4 cross-chain average = (2.00 + 4.00) / 2 = 3.00
        expect(results[0].total).toBe(3.00);
    });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — sort order', () => {
    it('puts stores with fewer missing items first', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1), makeStore(2)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);

        // Only storeId=1 has a price row; storeId=2 gets nothing at any tier.
        setupTiers(
            [makeSpDbRow()],
            [makePriceDbRow(1, '4.00')], // only store 1 priced
        );

        const result = await calculateBasketForStores(1);

        expect(result[0].storeId).toBe(1); // 0 missing → first
        expect(result[1].storeId).toBe(2); // 1 missing → second
    });

    it('sorts by total when missing count is equal', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1), makeStore(2)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);

        // Both stores have prices for the same SP (id=10).
        setupTiers(
            [makeSpDbRow()],
            [
                makePriceDbRow(1, '2.00'), // store 1: total = 2 × 2.00 = 4.00
                makePriceDbRow(2, '5.00'), // store 2: total = 2 × 5.00 = 10.00
            ],
        );

        const result = await calculateBasketForStores(1);

        expect(result[0].storeId).toBe(1);
        expect(result[0].total).toBe(4.00);
        expect(result[1].total).toBe(10.00);
    });
});
