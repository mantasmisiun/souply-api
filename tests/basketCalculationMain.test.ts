import { jest } from '@jest/globals';

const mockPoolQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockPoolQuery },
}));

const mockGetClosestStores = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeModel.js', () => ({
    getClosestStores: mockGetClosestStores,
    getStoreById: jest.fn(),
    getClosestStorePerChainToStore: jest.fn(),
}));

const mockGetBasketProductIds = jest.fn<any>();
jest.unstable_mockModule('../src/models/basketModel.js', () => ({
    getBasketProductIds: mockGetBasketProductIds,
}));

let calculateBasketForStores: any;

beforeAll(async () => {
    const mod = await import('../src/services/basketCalculationService.js');
    calculateBasketForStores = mod.calculateBasketForStores;
});

// resetAllMocks clears both call tracking AND queued mockResolvedValueOnce values.
// clearAllMocks would leave stale queue entries that bleed into later tests.
beforeEach(() => jest.resetAllMocks());

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
 * Row format returned by batchFetchTier12Prices. Uses `spProductId` (aliased
 * from Product.id in the SQL) as the cache key, alongside `storeId` so the
 * cache is indexed per store.
 */
function makeBatchRow(storeId: number, price: string, overrides: Record<string, any> = {}) {
    return {
        id: 10, spProductId: 100, storeProductName: 'Pienas 1L',
        isWeighable: 0, amount: '1', unit: 'vnt',
        price, promoPrice: null, isFallback: 0,
        storeId, baseProductId: null,
        ...overrides,
    };
}

/**
 * Sets up mockPoolQuery for the typical tier waterfall:
 *   1st call  — batchFetchTier12Prices (single pre-fetch)
 *   subsequent — discriminated by SQL content for tier-3/4 fallbacks
 */
function setupTiers(
    tier12Rows: any[],
    tier3Rows: any[] = [],
    tier4Rows: any[] = [],
) {
    mockPoolQuery
        .mockResolvedValueOnce([tier12Rows])   // batch pre-fetch
        .mockImplementation(async (sql: string) => {
            if (sql.includes('ACOS')) return [tier4Rows];
            if (sql.includes('LIKE ?')) return [tier3Rows];
            return [[]];
        });
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
        setupTiers([makeBatchRow(1, '2.50')]);

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
        setupTiers([makeBatchRow(1, '5.00', { promoPrice: '3.00' })]);

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].effectivePrice).toBeCloseTo(3.00);
        expect(store.total).toBe(6.00); // 2 × 3.00
    });

    it('preserves isFallback from the Price row', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);
        setupTiers([makeBatchRow(1, '2.00', { isFallback: 1 })]);

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
        setupTiers([], [], []); // batch empty + tier-3 + tier-4 empty

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isMissing).toBe(true);
        expect(store.missingItemNames).toContain('Pienas');
        expect(store.total).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Tier-4 cross-chain average
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — tier-4 cross-chain average', () => {
    it('sets isCrossChainAverage and isApproximated when tier-4 is used', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);
        setupTiers(
            [],  // no tier-1/2 match
            [],  // no tier-3 substitute
            [    // tier-4: cross-chain price from a nearby store
                {
                    amount: '1', unit: 'vnt', isWeighable: 0,
                    effectivePrice: '3.00', rawPrice: '3.00',
                    promoPrice: null, isFallback: 0, storeId: 99,
                },
            ]
        );

        const [store] = await calculateBasketForStores(1);

        expect(store.items[0].isCrossChainAverage).toBe(true);
        expect(store.isApproximated).toBe(true);
        expect(store.items[0].isMissing).toBe(false);
        expect(store.total).toBe(6.00); // 2 × 3.00
    });

    it('averages across multiple stores in the same pack-size bucket', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem({ quantity: '1' })]);
        setupTiers(
            [], [],
            [
                { amount: '1', unit: 'vnt', isWeighable: 0, effectivePrice: '2.00', rawPrice: '2.00', promoPrice: null, isFallback: 0, storeId: 10 },
                { amount: '1', unit: 'vnt', isWeighable: 0, effectivePrice: '4.00', rawPrice: '4.00', promoPrice: null, isFallback: 0, storeId: 20 },
            ]
        );

        const [store] = await calculateBasketForStores(1);

        // avg(2.00, 4.00) = 3.00, qty=1 → total=3.00
        expect(store.total).toBe(3.00);
    });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe('calculateBasketForStores — sort order', () => {
    it('puts stores with fewer missing items first', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1), makeStore(2)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);

        // Batch returns data only for store 1; store 2 falls through to
        // tier-3/4 which are also empty → store 2 has a missing item.
        setupTiers([makeBatchRow(1, '4.00')]);

        const result = await calculateBasketForStores(1);

        expect(result[0].storeId).toBe(1); // 0 missing → first
        expect(result[1].storeId).toBe(2); // 1 missing → second
    });

    it('sorts by total when missing count is equal', async () => {
        mockGetClosestStores.mockResolvedValue([makeStore(1), makeStore(2)]);
        mockGetBasketProductIds.mockResolvedValue([makeBasketItem()]);

        // Batch contains rows for both stores at different prices.
        setupTiers([
            makeBatchRow(1, '2.00'),  // total = 2 × 2.00 = 4.00
            makeBatchRow(2, '5.00'),  // total = 2 × 5.00 = 10.00
        ]);

        const result = await calculateBasketForStores(1);

        expect(result[0].storeId).toBe(1);
        expect(result[0].total).toBe(4.00);
        expect(result[1].total).toBe(10.00);
    });
});
