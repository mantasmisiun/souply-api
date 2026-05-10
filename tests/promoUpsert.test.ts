/**
 * Tests for promoUpsert.ts — specifically the fan-out behaviour that
 * inserts promo prices for ALL stores in a chain, not just one.
 *
 * All DB calls are mocked; no live connection required.
 *
 * Note: promoUpsert.ts holds an in-process `chainStoreIdsCache` that persists
 * across tests in the same run. We handle this by using mockImplementation
 * based on SQL content rather than mockResolvedValueOnce, which makes each
 * test independent of whether the cache is warm or cold.
 */
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock the DB pool BEFORE importing the module under test (ESM hoisting).
// ---------------------------------------------------------------------------

const mockPoolQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockPoolQuery },
}));

const mockFindExact = jest.fn<any>().mockResolvedValue(null);
const mockCreateSp   = jest.fn<any>().mockResolvedValue(99);
const mockUpdateImg  = jest.fn<any>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/models/storeProductModel.js', () => ({
    findExactMatchingStoreProduct: mockFindExact,
    createStoreProduct: mockCreateSp,
    updateStoreProductImageUrl: mockUpdateImg,
}));

const mockCreateProduct = jest.fn<any>().mockResolvedValue(200);
jest.unstable_mockModule('../src/models/productModel.js', () => ({
    createProduct: mockCreateProduct,
}));

const mockFuzzyProduct = jest.fn<any>().mockResolvedValue(null);
const mockFuzzySp      = jest.fn<any>().mockResolvedValue(null);
jest.unstable_mockModule('../src/scrapers/shared/productMatcher.js', () => ({
    fuzzyMatchProduct: mockFuzzyProduct,
    fuzzyMatchSp:      mockFuzzySp,
    addProductToIndex: jest.fn(),
    addSpToIndex:      jest.fn(),
    normalizeName:     (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
}));

let upsertPriceForSpId: any;
let upsertPromo: any;

beforeAll(async () => {
    const mod = await import('../src/scrapers/shared/promoUpsert.js');
    upsertPriceForSpId = mod.upsertPriceForSpId;
    upsertPromo        = mod.upsertPromo;
});

// clearAllMocks resets call history but keeps mock implementations (return values).
// resetAllMocks would also clear return values, breaking createStoreProduct etc.
beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROMO_END = new Date('2026-06-01T23:59:59Z');

/**
 * Set up a pool.query mock that discriminates by SQL content.
 * This is robust against the module-level chainStoreIdsCache because the
 * right response is always returned regardless of whether the cache is warm.
 *
 * @param storeIds   Store IDs to return for the chain-stores query.
 * @param priceRows  Rows to return for the fetchLatestPrices query.
 * @param insertMode 'insert' → bulk INSERT; 'skip' → no INSERT call expected.
 */
function setupPoolMock(
    storeIds: number[],
    priceRows: any[] = [],
    insertMode: 'insert' | 'skip' | 'update' = 'insert',
) {
    mockPoolQuery.mockImplementation(async (sql: string) => {
        if (typeof sql !== 'string') return [[]];
        if (sql.includes('FROM Store'))            return [storeIds.map(id => ({ id }))];
        if (sql.includes('FROM Price p\n         INNER JOIN') || sql.includes('FROM Price p\r\n         INNER JOIN') || (sql.includes('FROM Price p') && sql.includes('INNER JOIN')))
            return [priceRows];
        if (sql.includes('INSERT IGNORE INTO Price'))     return [{ insertId: 0 }];
        if (sql.includes('UPDATE Price SET promoEnd')) return [{ affectedRows: 1 }];
        if (sql.includes('SELECT imageUrl FROM StoreProduct')) return [[{ imageUrl: null }]];
        return [[]];
    });
}

// ---------------------------------------------------------------------------
// upsertPriceForSpId — fan-out behaviour
// ---------------------------------------------------------------------------

describe('upsertPriceForSpId — fan-out', () => {
    it('inserts a price row for every store in the chain when none exist', async () => {
        setupPoolMock([1, 2, 3], []);  // 3 stores, no existing prices

        await upsertPriceForSpId(10, 1, null, 5.99, 3.49, PROMO_END);

        const insertCall = mockPoolQuery.mock.calls.find(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO Price'),
        );
        expect(insertCall).toBeDefined();
        const insertValues = insertCall![1][0] as any[][];
        // One row per store
        expect(insertValues).toHaveLength(3);
        // Each row's storeId (index 1) covers all 3 stores
        const insertedStoreIds = insertValues.map((r: any[]) => r[1]);
        expect(insertedStoreIds).toEqual(expect.arrayContaining([1, 2, 3]));
        // priceVerified (index 8) must be true so prices are visible in the app
        expect(insertValues.every((r: any[]) => r[8] === true)).toBe(true);
    });

    it('returns "inserted" when at least one store gets a new row', async () => {
        setupPoolMock([1, 2, 3], []);

        const result = await upsertPriceForSpId(10, 2, null, 5.99, 3.49, PROMO_END);

        expect(result).toBe('inserted');
    });

    it('returns "skipped" when all stores already have the same price', async () => {
        setupPoolMock([1, 2], [
            { id: 100, storeId: 1, price: '5.99', promoPrice: '3.49', promoEnd: PROMO_END, requiresCoupon: 0 },
            { id: 101, storeId: 2, price: '5.99', promoPrice: '3.49', promoEnd: PROMO_END, requiresCoupon: 0 },
        ]);

        const result = await upsertPriceForSpId(10, 3, null, 5.99, 3.49, PROMO_END);

        expect(result).toBe('skipped');
        expect(mockPoolQuery.mock.calls.some(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO Price'),
        )).toBe(false);
    });

    it('extends promoEnd for unchanged price when end date moves forward', async () => {
        const earlierEnd = new Date('2026-05-31T23:59:59Z');
        const laterEnd   = new Date('2026-06-15T23:59:59Z');

        setupPoolMock([1], [
            { id: 100, storeId: 1, price: '5.99', promoPrice: '3.49', promoEnd: earlierEnd, requiresCoupon: 0 },
        ]);

        await upsertPriceForSpId(10, 4, null, 5.99, 3.49, laterEnd);

        const updateCall = mockPoolQuery.mock.calls.find(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE Price SET promoEnd'),
        );
        expect(updateCall).toBeDefined();
        expect(mockPoolQuery.mock.calls.some(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO Price'),
        )).toBe(false);
    });

    it('inserts new row when promoPrice changed, even if promoEnd is the same', async () => {
        setupPoolMock([1], [
            { id: 100, storeId: 1, price: '5.99', promoPrice: '3.49', promoEnd: PROMO_END, requiresCoupon: 0 },
        ]);

        const result = await upsertPriceForSpId(10, 5, null, 5.99, 2.99, PROMO_END);

        expect(result).toBe('inserted');
        expect(mockPoolQuery.mock.calls.some(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO Price'),
        )).toBe(true);
    });

    it('inserts only for stores missing a price, skips those that already match', async () => {
        setupPoolMock([1, 2, 3], [
            // Store 1 already has the correct price
            { id: 100, storeId: 1, price: '5.99', promoPrice: '3.49', promoEnd: PROMO_END, requiresCoupon: 0 },
        ]);

        await upsertPriceForSpId(10, 6, null, 5.99, 3.49, PROMO_END);

        const insertCall = mockPoolQuery.mock.calls.find(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO Price'),
        );
        expect(insertCall).toBeDefined();
        const insertValues = insertCall![1][0] as any[][];
        // Only stores 2 and 3 should be inserted (store 1 already up-to-date)
        expect(insertValues).toHaveLength(2);
        const insertedStoreIds = insertValues.map((r: any[]) => r[1]);
        expect(insertedStoreIds).toEqual(expect.arrayContaining([2, 3]));
        expect(insertedStoreIds).not.toContain(1);
    });

    it('returns "skipped" when chain has no stores', async () => {
        setupPoolMock([]);

        const result = await upsertPriceForSpId(10, 7, null, 5.99, 3.49, PROMO_END);

        expect(result).toBe('skipped');
    });
});

// ---------------------------------------------------------------------------
// upsertPromo — SP / Product creation paths
// ---------------------------------------------------------------------------

describe('upsertPromo — result codes', () => {
    it('returns "inserted" when SP already exists and price is new', async () => {
        mockFindExact.mockResolvedValue(50);
        setupPoolMock([1], []);

        const result = await upsertPromo({
            chainId: 8,
            storeProductName: 'Pienas 1L',
            amount: 1, unit: 'vnt', isWeighable: false,
            imageUrl: null, regularPrice: 3.99, promoPrice: 2.49, promoEnd: PROMO_END,
        });

        expect(result).toBe('inserted');
    });

    it('returns "sp_created" when fuzzyMatchProduct finds an existing Product', async () => {
        mockFindExact.mockResolvedValue(null);
        mockFuzzySp.mockResolvedValue(null);
        mockFuzzyProduct.mockResolvedValue({ id: 300, name: 'Pienas' });
        setupPoolMock([1], []);

        const result = await upsertPromo({
            chainId: 9,
            storeProductName: 'Pienas Dvaras 1L',
            amount: 1, unit: 'vnt', isWeighable: false,
            imageUrl: null, regularPrice: 3.99, promoPrice: 2.49, promoEnd: PROMO_END,
        });

        expect(result).toBe('sp_created');
    });

    it('returns "product_created" when neither SP nor Product fuzzy-match found', async () => {
        mockFindExact.mockResolvedValue(null);
        mockFuzzySp.mockResolvedValue(null);
        mockFuzzyProduct.mockResolvedValue(null);
        setupPoolMock([1], []);

        const result = await upsertPromo({
            chainId: 10,
            storeProductName: 'Brand New Product XYZ',
            amount: null, unit: null, isWeighable: false,
            imageUrl: null, regularPrice: 9.99, promoPrice: 6.99, promoEnd: PROMO_END,
        });

        expect(result).toBe('product_created');
    });

    it('returns "skipped" when SP exists and price is already current at all stores', async () => {
        mockFindExact.mockResolvedValue(50);
        setupPoolMock([1], [
            { id: 100, storeId: 1, price: '3.99', promoPrice: '2.49', promoEnd: PROMO_END, requiresCoupon: 0 },
        ]);

        const result = await upsertPromo({
            chainId: 11,
            storeProductName: 'Pienas 1L',
            amount: 1, unit: 'vnt', isWeighable: false,
            imageUrl: null, regularPrice: 3.99, promoPrice: 2.49, promoEnd: PROMO_END,
        });

        expect(result).toBe('skipped');
    });
});
