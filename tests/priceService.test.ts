import { jest } from '@jest/globals';

const mockPoolQuery = jest.fn<any>();
const mockPoolEscape = jest.fn<any>((v: any) => (v === null ? 'NULL' : String(v)));
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockPoolQuery, escape: mockPoolEscape },
}));

const mockGetStoresByChainId = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeModel.js', () => ({
    getStoresByChainId: mockGetStoresByChainId,
    getClosestStores: jest.fn(),
    getStoreById: jest.fn(),
    getClosestStorePerChainToStore: jest.fn(),
}));

// priceModel is no longer used directly by propagateAllFallbackPrices — all
// writes go through pool.query. Keep the mock so Jest doesn't try to load the
// real module (which needs a DB connection).
jest.unstable_mockModule('../src/models/priceModel.js', () => ({
    createPrice: jest.fn(),
    getPriceByStoreProductAndStore: jest.fn(),
    updateFallbackPrice: jest.fn(),
    getLatestPriceByStoreProduct: jest.fn(),
    getPriceHistoryForStoreProduct: jest.fn(),
    getLatestPricesAcrossStores: jest.fn(),
    getActivePromoPrices: jest.fn(),
    updatePriceById: jest.fn(),
    getBaselinePriceAverage: jest.fn(),
    batchGetBaselinePriceAverages: jest.fn(),
    batchGetLatestPricesForReceiptItems: jest.fn(),
    getPriceHistoryForStoreProductAllStores: jest.fn(),
    getLatestPriceForReceiptItem: jest.fn(),
}));

let propagateFallbackPrices: any;
let propagateAllFallbackPrices: any;

beforeAll(async () => {
    const mod = await import('../src/services/priceService.js');
    propagateFallbackPrices = mod.propagateFallbackPrices;
    propagateAllFallbackPrices = mod.propagateAllFallbackPrices;
});

beforeEach(() => jest.resetAllMocks());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SP_ID = 10;
const SOURCE_STORE = 1;
const CHAIN_ID = 5;
const DATE = new Date('2026-05-01');
const PRICE = 2.50;
const PROMO = null;
const RECEIPT = 42;

function makeStores(...ids: number[]) {
    return ids.map(id => ({ id }));
}

// ---------------------------------------------------------------------------
// Early-exit guards
// ---------------------------------------------------------------------------

describe('propagateFallbackPrices — early exits', () => {
    it('makes no DB calls when the chain has only the source store', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE));

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('makes no DB calls when the chain has no stores at all', async () => {
        mockGetStoresByChainId.mockResolvedValue([]);

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        expect(mockPoolQuery).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Batch SELECT issues exactly 1 pool.query call for the SELECT regardless of store count
// ---------------------------------------------------------------------------

describe('propagateFallbackPrices — query count', () => {
    it('issues exactly 1 SELECT query for N stores (batch, not N individual selects)', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2, 3, 4));
        // SELECT returns no existing rows → INSERT will fire
        mockPoolQuery.mockResolvedValue([[]]);

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        // Calls: 1 SELECT + 1 batch INSERT (stores 2,3,4 are new)
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        expect((mockPoolQuery.mock.calls[0][0] as string).toUpperCase()).toMatch(/^SELECT/);
        expect((mockPoolQuery.mock.calls[1][0] as string).toUpperCase()).toMatch(/^INSERT/);
    });

    it('issues 1 SELECT + 1 UPDATE when all other stores have fallback rows', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2, 3));
        mockPoolQuery
            .mockResolvedValueOnce([[{ id: 20, storeProductId: SP_ID, storeId: 2, isFallback: 1 }, { id: 30, storeProductId: SP_ID, storeId: 3, isFallback: 1 }]])
            .mockResolvedValueOnce([{ affectedRows: 2 }]);

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        // 1 SELECT + 1 UPDATE (no INSERT since all stores had fallback rows)
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        expect((mockPoolQuery.mock.calls[1][0] as string).toUpperCase()).toMatch(/^UPDATE/);
    });
});

// ---------------------------------------------------------------------------
// Categorization: skip / update / insert
// ---------------------------------------------------------------------------

describe('propagateFallbackPrices — categorization', () => {
    it('skips stores that have a real price row (isFallback=0)', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2));
        // Store 2 has a real price → skip it
        mockPoolQuery.mockResolvedValue([[{ id: 20, storeProductId: SP_ID, storeId: 2, isFallback: 0 }]]);

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        // Only the SELECT fires — no UPDATE (no fallback rows), no INSERT (covered by real price)
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it('issues a batch INSERT for stores that have no existing Price row', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2, 3));
        mockPoolQuery
            .mockResolvedValueOnce([[]])       // SELECT → no existing rows
            .mockResolvedValueOnce([{}]);      // INSERT

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        // SELECT + INSERT
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        const insertSql = (mockPoolQuery.mock.calls[1][0] as string).toUpperCase();
        expect(insertSql).toMatch(/^INSERT/);
        // The VALUES array should include rows for stores 2 and 3
        const insertRows: any[] = mockPoolQuery.mock.calls[1][1][0];
        const insertedStoreIds = insertRows.map((r: any) => r[1]);
        expect(insertedStoreIds).toEqual(expect.arrayContaining([2, 3]));
    });

    it('batches the UPDATE for all fallback rows in one query', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2, 3));
        mockPoolQuery
            .mockResolvedValueOnce([[
                { id: 20, storeProductId: SP_ID, storeId: 2, isFallback: 1 },
                { id: 30, storeProductId: SP_ID, storeId: 3, isFallback: 1 },
            ]])
            .mockResolvedValueOnce([{ affectedRows: 2 }]);

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        const updateSql = mockPoolQuery.mock.calls[1][0] as string;
        expect(updateSql.toUpperCase()).toMatch(/^UPDATE/);
        // Both fallback ids should appear in the WHERE clause params
        const updateParams = mockPoolQuery.mock.calls[1][1];
        const idArray = updateParams[updateParams.length - 1]; // last param is the ids array
        expect(idArray).toEqual(expect.arrayContaining([20, 30]));
    });

    it('handles a mix: skip real, update fallback, insert missing — all in one pass', async () => {
        // Stores: 2 (real → skip), 3 (fallback → update), 4 (missing → insert)
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2, 3, 4));
        mockPoolQuery
            .mockResolvedValueOnce([[
                { id: 20, storeProductId: SP_ID, storeId: 2, isFallback: 0 }, // real → skip
                { id: 30, storeProductId: SP_ID, storeId: 3, isFallback: 1 }, // fallback → update
            ]])                                                                  // store 4 missing → insert
            .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE for store 3
            .mockResolvedValueOnce([{}]);                  // INSERT for store 4

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        // SELECT + UPDATE + INSERT
        expect(mockPoolQuery).toHaveBeenCalledTimes(3);
        expect((mockPoolQuery.mock.calls[1][0] as string).toUpperCase()).toMatch(/^UPDATE/);
        expect((mockPoolQuery.mock.calls[2][0] as string).toUpperCase()).toMatch(/^INSERT/);
    });

    it('skips the UPDATE query entirely when no fallback rows exist', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2));
        mockPoolQuery
            .mockResolvedValueOnce([[]])  // no existing rows → INSERT only
            .mockResolvedValueOnce([{}]);

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, PROMO, DATE, RECEIPT);

        // SELECT + INSERT (no UPDATE)
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        expect((mockPoolQuery.mock.calls[1][0] as string).toUpperCase()).toMatch(/^INSERT/);
    });

    it('passes receiptId correctly to the batch UPDATE', async () => {
        const RECEIPT_ID = 77;
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2));
        mockPoolQuery
            .mockResolvedValueOnce([[{ id: 20, storeProductId: SP_ID, storeId: 2, isFallback: 1 }]])
            .mockResolvedValueOnce([{ affectedRows: 1 }]);

        await propagateFallbackPrices(SP_ID, SOURCE_STORE, CHAIN_ID, PRICE, null, DATE, RECEIPT_ID);

        const updateParams = mockPoolQuery.mock.calls[1][1];
        // receiptId is the second-to-last param (before the id array)
        expect(updateParams[updateParams.length - 2]).toBe(RECEIPT_ID);
    });
});

// ---------------------------------------------------------------------------
// propagateAllFallbackPrices — multi-product batch
// ---------------------------------------------------------------------------

describe('propagateAllFallbackPrices — multi-product batch', () => {
    it('handles multiple products in a single batch (2 SELECTs max: stores + existing rows)', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE, 2, 3));
        mockPoolQuery
            .mockResolvedValueOnce([[]])  // SELECT existing → none
            .mockResolvedValueOnce([{}]); // INSERT

        await propagateAllFallbackPrices(
            [
                { storeProductId: 10, storeId: SOURCE_STORE, chainId: CHAIN_ID, price: 1.50, promoPrice: null, date: DATE },
                { storeProductId: 11, storeId: SOURCE_STORE, chainId: CHAIN_ID, price: 2.00, promoPrice: null, date: DATE },
            ],
            RECEIPT,
        );

        // 1 SELECT for all SPs × all target stores, 1 INSERT for all missing pairs
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
        const insertRows: any[] = mockPoolQuery.mock.calls[1][1][0];
        // 2 products × 2 target stores = 4 insert rows
        expect(insertRows.length).toBe(4);
    });

    it('returns immediately without any queries when items is empty', async () => {
        await propagateAllFallbackPrices([], RECEIPT);
        expect(mockPoolQuery).not.toHaveBeenCalled();
        expect(mockGetStoresByChainId).not.toHaveBeenCalled();
    });

    it('returns immediately without any queries when chain has no other stores', async () => {
        mockGetStoresByChainId.mockResolvedValue(makeStores(SOURCE_STORE)); // only source

        await propagateAllFallbackPrices(
            [{ storeProductId: 10, storeId: SOURCE_STORE, chainId: CHAIN_ID, price: 1.50, promoPrice: null, date: DATE }],
            RECEIPT,
        );

        expect(mockPoolQuery).not.toHaveBeenCalled();
    });
});
