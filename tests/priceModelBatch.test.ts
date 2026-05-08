/**
 * Tests for batchGetBaselinePriceAverages and batchGetLatestPricesForReceiptItems.
 *
 * We mock the mysql2 pool so these tests run without a live DB connection.
 * The mock returns the raw row arrays that a real MariaDB query would return,
 * letting us verify that the post-query grouping / averaging logic is correct.
 */
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock the DB pool before importing the module under test.
// jest.unstable_mockModule is required for native ESM (jest.mock is not hoisted).
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockQuery },
}));

// Dynamic import AFTER the mock is registered so the mock is in place
const { batchGetBaselinePriceAverages, batchGetLatestPricesForReceiptItems } =
    await import('../src/models/priceModel.js');

beforeEach(() => {
    mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// batchGetBaselinePriceAverages
// ---------------------------------------------------------------------------

describe('batchGetBaselinePriceAverages', () => {
    it('returns empty map for empty storeProductIds', async () => {
        const result = await batchGetBaselinePriceAverages([], 1);
        expect(result.size).toBe(0);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns correct average for a storeProduct with 3 rows', async () => {
        mockQuery.mockResolvedValueOnce([
            [
                { storeProductId: 10, price: '1.00' },
                { storeProductId: 10, price: '1.20' },
                { storeProductId: 10, price: '1.40' },
            ],
        ]);
        const result = await batchGetBaselinePriceAverages([10], 1);
        expect(result.get(10)).toBeCloseTo(1.20, 5);
    });

    it('returns null when a storeProduct has fewer than 2 rows', async () => {
        mockQuery.mockResolvedValueOnce([
            [{ storeProductId: 20, price: '5.00' }],
        ]);
        const result = await batchGetBaselinePriceAverages([20], 1);
        expect(result.get(20)).toBeNull();
    });

    it('returns no entry (undefined) for a storeProduct absent from query results', async () => {
        // query returns nothing for storeProductId=99 (no prices)
        mockQuery.mockResolvedValueOnce([[{ storeProductId: 10, price: '2.00' }, { storeProductId: 10, price: '2.50' }]]);
        const result = await batchGetBaselinePriceAverages([10, 99], 1);
        expect(result.get(10)).toBeCloseTo(2.25, 5);
        expect(result.get(99)).toBeUndefined();
    });

    it('handles multiple storeProducts in a single call', async () => {
        mockQuery.mockResolvedValueOnce([
            [
                { storeProductId: 10, price: '1.00' },
                { storeProductId: 10, price: '3.00' },
                { storeProductId: 11, price: '4.00' },
                { storeProductId: 11, price: '6.00' },
                { storeProductId: 11, price: '8.00' },
            ],
        ]);
        const result = await batchGetBaselinePriceAverages([10, 11], 1);
        expect(result.get(10)).toBeCloseTo(2.00, 5);
        expect(result.get(11)).toBeCloseTo(6.00, 5);
    });

    it('returns null for a storeProduct whose only row count is exactly 1', async () => {
        mockQuery.mockResolvedValueOnce([[{ storeProductId: 42, price: '9.99' }]]);
        const result = await batchGetBaselinePriceAverages([42], 1);
        expect(result.get(42)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// batchGetLatestPricesForReceiptItems
// ---------------------------------------------------------------------------

describe('batchGetLatestPricesForReceiptItems', () => {
    it('returns empty map for empty storeProductIds', async () => {
        const result = await batchGetLatestPricesForReceiptItems([], 1, 1);
        expect(result.size).toBe(0);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns the row for a matched storeProduct', async () => {
        mockQuery.mockResolvedValueOnce([
            [{ storeProductId: 10, price: '2.80', promoPrice: null }],
        ]);
        const result = await batchGetLatestPricesForReceiptItems([10], 1, 42);
        const row = result.get(10);
        expect(row).not.toBeNull();
        expect(parseFloat(row!.price)).toBeCloseTo(2.80);
        expect(row!.promoPrice).toBeNull();
    });

    it('returns null-equivalent for storeProduct absent from results', async () => {
        // query returns row for sp=10, nothing for sp=99
        mockQuery.mockResolvedValueOnce([
            [{ storeProductId: 10, price: '2.80', promoPrice: null }],
        ]);
        const result = await batchGetLatestPricesForReceiptItems([10, 99], 1, 42);
        expect(result.get(10)).not.toBeNull();
        expect(result.get(99) ?? null).toBeNull();
    });

    it('handles promoPrice correctly when set', async () => {
        mockQuery.mockResolvedValueOnce([
            [{ storeProductId: 10, price: '3.00', promoPrice: '2.49' }],
        ]);
        const result = await batchGetLatestPricesForReceiptItems([10], 1, 42);
        expect(result.get(10)!.promoPrice).toBe('2.49');
    });

    it('handles multiple storeProducts in a single call', async () => {
        mockQuery.mockResolvedValueOnce([
            [
                { storeProductId: 10, price: '2.80', promoPrice: null },
                { storeProductId: 11, price: '5.00', promoPrice: '4.20' },
            ],
        ]);
        const result = await batchGetLatestPricesForReceiptItems([10, 11], 1, 42);
        expect(parseFloat(result.get(10)!.price)).toBeCloseTo(2.80);
        expect(parseFloat(result.get(11)!.price)).toBeCloseTo(5.00);
        expect(result.get(11)!.promoPrice).toBe('4.20');
    });

    it('returns empty result when query returns no rows', async () => {
        mockQuery.mockResolvedValueOnce([[]]);
        const result = await batchGetLatestPricesForReceiptItems([10], 1, 42);
        expect(result.get(10) ?? null).toBeNull();
    });
});
