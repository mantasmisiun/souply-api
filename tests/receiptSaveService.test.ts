import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// DB pool — connection with transaction lifecycle
// ---------------------------------------------------------------------------

const mockConn = {
    beginTransaction: jest.fn<any>(),
    commit: jest.fn<any>(),
    rollback: jest.fn<any>(),
    release: jest.fn<any>(),
};
const mockGetConnection = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { getConnection: mockGetConnection },
}));

// ---------------------------------------------------------------------------
// priceModel
// ---------------------------------------------------------------------------

const mockCreatePrice = jest.fn<any>();
const mockBatchGetBaselinePriceAverages = jest.fn<any>();
const mockBatchGetLatestPricesForReceiptItems = jest.fn<any>();
jest.unstable_mockModule('../src/models/priceModel.js', () => ({
    createPrice: mockCreatePrice,
    batchGetBaselinePriceAverages: mockBatchGetBaselinePriceAverages,
    batchGetLatestPricesForReceiptItems: mockBatchGetLatestPricesForReceiptItems,
    getLatestPriceByStoreProduct: jest.fn(),
    getPriceHistoryForStoreProduct: jest.fn(),
    getLatestPricesAcrossStores: jest.fn(),
    getActivePromoPrices: jest.fn(),
    updatePriceById: jest.fn(),
    getPriceByStoreProductAndStore: jest.fn(),
    updateFallbackPrice: jest.fn(),
    getBaselinePriceAverage: jest.fn(),
    getPriceHistoryForStoreProductAllStores: jest.fn(),
    getLatestPriceForReceiptItem: jest.fn(),
}));

// ---------------------------------------------------------------------------
// receiptModel
// ---------------------------------------------------------------------------

const mockUpdateReceiptDetails = jest.fn<any>();
const mockUpdateReceiptStore = jest.fn<any>();
const mockUpdateReceiptSavedAmount = jest.fn<any>();
jest.unstable_mockModule('../src/models/receiptModel.js', () => ({
    updateReceiptDetails: mockUpdateReceiptDetails,
    updateReceiptStore: mockUpdateReceiptStore,
    updateReceiptSavedAmount: mockUpdateReceiptSavedAmount,
    createReceipt: jest.fn(),
    getReceiptById: jest.fn(),
    getUserReceipts: jest.fn(),
}));

// ---------------------------------------------------------------------------
// statsService (computeReceiptSavings)
// ---------------------------------------------------------------------------

const mockComputeReceiptSavings = jest.fn<any>();
jest.unstable_mockModule('../src/services/statsService.js', () => ({
    computeReceiptSavings: mockComputeReceiptSavings,
    getUserStats: jest.fn(),
    computeSavingsFromPrices: jest.fn(),
}));

// ---------------------------------------------------------------------------
// receiptSwipeCandidateModel
// ---------------------------------------------------------------------------

const mockReplaceSwipeCandidates = jest.fn<any>();
jest.unstable_mockModule('../src/models/receiptSwipeCandidateModel.js', () => ({
    replaceSwipeCandidates: mockReplaceSwipeCandidates,
    getSwipeCandidates: jest.fn(),
}));

// ---------------------------------------------------------------------------
// receiptLineResolver
// ---------------------------------------------------------------------------

const mockResolveReceiptLineStoreProduct = jest.fn<any>();
jest.unstable_mockModule('../src/services/receiptLineResolver.js', () => ({
    resolveReceiptLineStoreProduct: mockResolveReceiptLineStoreProduct,
    getUnassignedCategoryId: jest.fn(),
}));

// ---------------------------------------------------------------------------
// priceService (propagateAllFallbackPrices — fire-and-forget, not asserted directly)
// ---------------------------------------------------------------------------

const mockPropagateAllFallbackPrices = jest.fn<any>();
jest.unstable_mockModule('../src/services/priceService.js', () => ({
    propagateAllFallbackPrices: mockPropagateAllFallbackPrices,
    propagateFallbackPrices: jest.fn(), // kept for compat; receiptSaveService no longer calls it
}));

// ---------------------------------------------------------------------------
// userPointsService
// ---------------------------------------------------------------------------

const mockAwardReceiptPoints = jest.fn<any>();
jest.unstable_mockModule('../src/services/userPointsService.js', () => ({
    awardReceiptPoints: mockAwardReceiptPoints,
    awardSwipePoint: jest.fn(),
    getUserLevel: jest.fn(),
    getPointsToNextLevel: jest.fn(),
}));

// ---------------------------------------------------------------------------
// swipeSessionService
// ---------------------------------------------------------------------------

const mockInitMandatorySwipeSession = jest.fn<any>();
jest.unstable_mockModule('../src/services/swipeSessionService.js', () => ({
    initMandatorySwipeSession: mockInitMandatorySwipeSession,
    isBurstSwipe: jest.fn(),
    getMandatorySwipeCount: jest.fn(),
    decrementMandatorySwipeCount: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Load module under test
// ---------------------------------------------------------------------------

let persistReceiptPrices: any;

beforeAll(async () => {
    const mod = await import('../src/services/receiptSaveService.js');
    persistReceiptPrices = mod.persistReceiptPrices;
});

beforeEach(() => {
    jest.resetAllMocks();

    mockGetConnection.mockResolvedValue(mockConn);
    mockConn.beginTransaction.mockResolvedValue(undefined);
    mockConn.commit.mockResolvedValue(undefined);
    mockConn.rollback.mockResolvedValue(undefined);
    mockConn.release.mockReturnValue(undefined);

    // Default stub behaviour — tests override only what they care about.
    mockUpdateReceiptDetails.mockResolvedValue(undefined);
    mockUpdateReceiptStore.mockResolvedValue(undefined);
    mockUpdateReceiptSavedAmount.mockResolvedValue(undefined);
    mockReplaceSwipeCandidates.mockResolvedValue(undefined);
    mockInitMandatorySwipeSession.mockResolvedValue(undefined);
    mockAwardReceiptPoints.mockResolvedValue(undefined);
    mockComputeReceiptSavings.mockResolvedValue(0);
    mockCreatePrice.mockResolvedValue(1);
    mockPropagateAllFallbackPrices.mockResolvedValue(undefined);

    // Default resolver: return same storeProductId, mark as confirmed.
    mockResolveReceiptLineStoreProduct.mockResolvedValue({ storeProductId: 100, source: 'reused' });

    // Default batch maps: no baseline → no clearance; no latest → no duplicate.
    mockBatchGetBaselinePriceAverages.mockResolvedValue(new Map());
    mockBatchGetLatestPricesForReceiptItems.mockResolvedValue(new Map());
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal `ParsedReceiptInput` with sensible defaults. Each product entry
 * maps to a `parsedData.products` entry with the same index (caller must
 * keep them in sync).
 */
function makeInput(overrides: Record<string, any> = {}) {
    const { products = [], ...rest } = overrides;
    return {
        chainId: 1,
        storeId: 10,
        receiptNo: 'REC-001',
        date: '2026-05-01',
        time: null,
        products: (products as any[]).map(p => ({
            storeProductId: 100,
            matchConfirmed: true,
            priceVerified: false,
            price: 2.00,
            promoPrice: null,
            quantity: 1,
            unit: 'vnt',
            ...p,
        })),
        ...rest,
    };
}

/** Minimal `parsedData` blob that mirrors the `input.products` indices. */
function makeParsedData(lines: any[] = []) {
    return {
        products: lines,
        footer: { rawText: null },
        receiptNo: 'REC-001',
    };
}

// ---------------------------------------------------------------------------
// skippedNoMatch
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — skippedNoMatch', () => {
    it('counts item whose parsedData name is empty as skippedNoMatch (resolver skips it, matchConfirmed stays false)', async () => {
        const input = makeInput({ products: [{ storeProductId: null, matchConfirmed: false, price: 2.00 }] });
        const parsedData = makeParsedData([{ name: '', storeProductId: null }]);

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedNoMatch).toBe(1);
        expect(result.saved).toBe(0);
        expect(mockCreatePrice).not.toHaveBeenCalled();
    });

    it('counts item with price <= 0 as skippedNoMatch even when matchConfirmed', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, matchConfirmed: true, price: 0 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedNoMatch).toBe(1);
        expect(result.saved).toBe(0);
        expect(mockCreatePrice).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Clearance guard
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — clearance guard', () => {
    it('skips item when price is below 50% of the baseline average', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 0.90 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);
        // 0.90 < 2.00 * 0.5 = 1.00 → clearance
        mockBatchGetBaselinePriceAverages.mockResolvedValue(new Map([[100, 2.00]]));

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedClearance).toBe(1);
        expect(result.saved).toBe(0);
        expect(mockCreatePrice).not.toHaveBeenCalled();
    });

    it('saves item whose price is exactly 50% of the baseline (boundary is exclusive)', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 1.00 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);
        // 1.00 == 2.00 * 0.5 → NOT clearance (condition is strict <)
        mockBatchGetBaselinePriceAverages.mockResolvedValue(new Map([[100, 2.00]]));

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedClearance).toBe(0);
        expect(result.saved).toBe(1);
    });

    it('saves item when no baseline exists for that storeProductId', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 0.01 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);
        mockBatchGetBaselinePriceAverages.mockResolvedValue(new Map()); // no baseline

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedClearance).toBe(0);
        expect(result.saved).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Duplicate guard
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — duplicate guard', () => {
    it('skips item when both price and promoPrice match the latest stored values', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 2.00, promoPrice: null }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);
        mockBatchGetLatestPricesForReceiptItems.mockResolvedValue(
            new Map([[100, { price: '2.00', promoPrice: null }]])
        );

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedDuplicate).toBe(1);
        expect(result.saved).toBe(0);
        expect(mockCreatePrice).not.toHaveBeenCalled();
    });

    it('saves item when price changed even if promoPrice is the same', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 2.50, promoPrice: null }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);
        mockBatchGetLatestPricesForReceiptItems.mockResolvedValue(
            new Map([[100, { price: '2.00', promoPrice: null }]])
        );

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedDuplicate).toBe(0);
        expect(result.saved).toBe(1);
    });

    it('saves item when promoPrice changed even if base price is the same', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 2.00, promoPrice: 1.80 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);
        mockBatchGetLatestPricesForReceiptItems.mockResolvedValue(
            new Map([[100, { price: '2.00', promoPrice: null }]])
        );

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.skippedDuplicate).toBe(0);
        expect(result.saved).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// createPrice correctness
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — createPrice arguments', () => {
    it('writes priceVerified=true when the item was pre-verified', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 2.00, priceVerified: true }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100, priceVerified: true }]);

        await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(mockCreatePrice).toHaveBeenCalledWith(
            100,              // storeProductId
            10,               // storeId
            2.00,             // price
            null,             // promoPrice
            null,             // promoEnd
            false,            // isFallback
            expect.any(Date), // date (derived from receipt date)
            true,             // priceVerified
            1,                // receiptId
            mockConn,         // connection
        );
    });

    it('writes priceVerified=false for items that were not explicitly verified', async () => {
        const input = makeInput({ products: [{ storeProductId: 100, price: 2.00, priceVerified: false }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);

        await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(mockCreatePrice).toHaveBeenCalledWith(
            100, 10, 2.00, null, null, false, expect.any(Date), false, 1, mockConn,
        );
    });
});

// ---------------------------------------------------------------------------
// No storeId — early exit
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — no storeId', () => {
    it('commits early and skips price writes when no storeId is provided', async () => {
        const input = makeInput({ storeId: null, products: [{ price: 2.00 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.saved).toBe(0);
        expect(mockCreatePrice).not.toHaveBeenCalled();
        expect(mockBatchGetBaselinePriceAverages).not.toHaveBeenCalled();
        expect(mockConn.commit).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Batch query efficiency
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — batch queries', () => {
    it('calls batchGetBaseline and batchGetLatest exactly once regardless of item count', async () => {
        const input = makeInput({
            products: [
                { storeProductId: 100, price: 1.00 },
                { storeProductId: 101, price: 2.00 },
                { storeProductId: 102, price: 3.00 },
            ],
        });
        const parsedData = makeParsedData([
            { name: 'A', storeProductId: 100 },
            { name: 'B', storeProductId: 101 },
            { name: 'C', storeProductId: 102 },
        ]);
        mockResolveReceiptLineStoreProduct
            .mockResolvedValueOnce({ storeProductId: 100, source: 'reused' })
            .mockResolvedValueOnce({ storeProductId: 101, source: 'reused' })
            .mockResolvedValueOnce({ storeProductId: 102, source: 'reused' });

        await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(mockBatchGetBaselinePriceAverages).toHaveBeenCalledTimes(1);
        expect(mockBatchGetLatestPricesForReceiptItems).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Mixed item statuses
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — mixed item statuses', () => {
    it('correctly counts all four result fields across a mixed batch', async () => {
        // 4 items: saved, skippedNoMatch (empty name), skippedClearance, skippedDuplicate.
        const input = makeInput({
            products: [
                { storeProductId: 100, matchConfirmed: true,  price: 2.00 },
                { storeProductId: null, matchConfirmed: false, price: 2.00 }, // empty name → stays false
                { storeProductId: 101, matchConfirmed: true,  price: 0.90 }, // clearance
                { storeProductId: 102, matchConfirmed: true,  price: 3.00 }, // duplicate
            ],
        });
        const parsedData = makeParsedData([
            { name: 'Pienas',  storeProductId: 100 },
            { name: '',        storeProductId: null }, // empty name → resolver skips
            { name: 'Mėsa',   storeProductId: 101 },
            { name: 'Duona',   storeProductId: 102 },
        ]);

        // Resolver is only called for items with a non-empty name (3 calls).
        mockResolveReceiptLineStoreProduct
            .mockResolvedValueOnce({ storeProductId: 100, source: 'reused' })
            .mockResolvedValueOnce({ storeProductId: 101, source: 'reused' })
            .mockResolvedValueOnce({ storeProductId: 102, source: 'reused' });

        mockBatchGetBaselinePriceAverages.mockResolvedValue(
            new Map([[101, 2.00]]) // item 3: 0.90 < 1.00 → clearance
        );
        mockBatchGetLatestPricesForReceiptItems.mockResolvedValue(
            new Map([[102, { price: '3.00', promoPrice: null }]]) // item 4: duplicate
        );

        const result = await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(result.saved).toBe(1);
        expect(result.skippedNoMatch).toBe(1);
        expect(result.skippedClearance).toBe(1);
        expect(result.skippedDuplicate).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Transaction lifecycle
// ---------------------------------------------------------------------------

describe('persistReceiptPrices — transaction', () => {
    it('commits and releases on success', async () => {
        const input = makeInput({ products: [{ price: 2.00 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);

        await persistReceiptPrices(1, 'u1', parsedData, input);

        expect(mockConn.beginTransaction).toHaveBeenCalled();
        expect(mockConn.commit).toHaveBeenCalled();
        expect(mockConn.rollback).not.toHaveBeenCalled();
        expect(mockConn.release).toHaveBeenCalled();
    });

    it('rolls back, releases, and rethrows on error inside the transaction', async () => {
        const input = makeInput({ products: [{ price: 2.00 }] });
        const parsedData = makeParsedData([{ name: 'Product', storeProductId: 100 }]);
        mockCreatePrice.mockRejectedValue(new Error('DB write failed'));

        await expect(
            persistReceiptPrices(1, 'u1', parsedData, input)
        ).rejects.toThrow('DB write failed');

        expect(mockConn.rollback).toHaveBeenCalled();
        expect(mockConn.commit).not.toHaveBeenCalled();
        expect(mockConn.release).toHaveBeenCalled();
    });
});
