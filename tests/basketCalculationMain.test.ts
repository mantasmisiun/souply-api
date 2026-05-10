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
 * (single chain, single product, N stores):
 *
 *   Call 1  — batchFetchTier12Prices step 1: find matching StoreProducts
 *   Call 2  — batchFetchTier12Prices step 2: fetchLatestPrices for those SPs
 *             (only queued if spRows.length > 0)
 *   Call 3  — batchFetchTier3Substitutes LIKE candidate query (empty by default)
 *   Call 4  — approximateCrossChain step 1: SP rows for the product
 *   Call 5  — approximateCrossChain step 2: fetchLatestPrices for tier-4 SPs
 *             (only queued if tier4SpRows.length > 0)
 */
function setupTiers(
    spRows: any[],
    priceRows: any[],
    tier3Rows: any[] = [],
    tier4SpRows: any[] = [],
    tier4PriceRows: any[] = [],
) {
    mockPoolQuery.mockResolvedValueOnce([spRows]);
    if (spRows.length > 0) {
        mockPoolQuery.mockResolvedValueOnce([priceRows]);
    }
    mockPoolQuery.mockResolvedValueOnce([tier3Rows]);
    mockPoolQuery.mockResolvedValueOnce([tier4SpRows]);
    if (tier4SpRows.length > 0) {
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
