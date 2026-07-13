/**
 * Tests for query efficiency improvements:
 *   - resolveEffectiveProductId: N queries → 1 recursive CTE
 *   - deleteMatchVote: SELECT+DELETE → DELETE...RETURNING
 *   - getEffectiveBaseProductIdForStoreProduct: optional cachedProductId param
 */
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock the DB pool before importing the modules under test.
// jest.unstable_mockModule is required for native ESM (jest.mock is not hoisted).
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockQuery },
}));

// Dynamic imports AFTER the mock is registered
const {
    resolveEffectiveProductId,
    getEffectiveBaseProductIdForStoreProduct,
} = await import('../src/services/storeProductMergeService.js');

const { deleteMatchVote } = await import('../src/models/storeProductMatchModel.js');

beforeEach(() => {
    mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// resolveEffectiveProductId
// ---------------------------------------------------------------------------

describe('resolveEffectiveProductId', () => {
    it('returns the resolved id when DB returns one row', async () => {
        mockQuery.mockResolvedValueOnce([[{ id: 5 }]]);
        const result = await resolveEffectiveProductId(3);
        expect(result).toBe(5);
    });

    it('falls back to the input productId when DB returns no rows', async () => {
        mockQuery.mockResolvedValueOnce([[]]);
        const result = await resolveEffectiveProductId(7);
        expect(result).toBe(7);
    });

    it('calls db.query exactly once (not multiple times as in the old loop)', async () => {
        mockQuery.mockResolvedValueOnce([[{ id: 99 }]]);
        await resolveEffectiveProductId(1);
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('uses a WITH RECURSIVE CTE query', async () => {
        mockQuery.mockResolvedValueOnce([[{ id: 42 }]]);
        await resolveEffectiveProductId(10);
        const sql: string = (mockQuery.mock.calls[0][0] as string);
        expect(sql).toMatch(/WITH RECURSIVE/i);
        expect(sql).toMatch(/chain/i);
    });
});

// ---------------------------------------------------------------------------
// deleteMatchVote
// ---------------------------------------------------------------------------

describe('deleteMatchVote', () => {
    it('returns the deleted vote when a row exists', async () => {
        // First call: SELECT to check existing vote
        mockQuery.mockResolvedValueOnce([[{ vote: 'identical', aggregated: 1 }]]);
        // Second call: DELETE
        mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
        const result = await deleteMatchVote('user1', 1, 2);
        expect(result).toEqual({ deletedVote: 'identical', deletedAggregated: true });
    });

    it('returns null deletedVote when no vote row exists', async () => {
        // SELECT returns empty
        mockQuery.mockResolvedValueOnce([[]]);
        const result = await deleteMatchVote('user1', 1, 2);
        expect(result).toEqual({ deletedVote: null, deletedAggregated: false });
    });

    it('does not call DELETE when the vote row does not exist', async () => {
        mockQuery.mockResolvedValueOnce([[]]);
        await deleteMatchVote('user1', 1, 2);
        // Only one query (the SELECT) — no DELETE issued
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('calls DELETE after finding an existing vote', async () => {
        mockQuery.mockResolvedValueOnce([[{ vote: 'similar' }]]);
        mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
        await deleteMatchVote('user1', 1, 2);
        expect(mockQuery).toHaveBeenCalledTimes(2);
        const deleteSql: string = (mockQuery.mock.calls[1][0] as string);
        expect(deleteSql).toMatch(/DELETE/i);
    });
});

// ---------------------------------------------------------------------------
// getEffectiveBaseProductIdForStoreProduct with cachedProductId
// ---------------------------------------------------------------------------

describe('getEffectiveBaseProductIdForStoreProduct', () => {
    it('skips the StoreProduct lookup when cachedProductId is provided', async () => {
        // First call: resolveEffectiveProductId CTE → returns product id 10
        mockQuery.mockResolvedValueOnce([[{ id: 10 }]]);
        // Second call: SELECT baseProductId → returns baseProductId 20
        mockQuery.mockResolvedValueOnce([[{ baseProductId: 20 }]]);

        const result = await getEffectiveBaseProductIdForStoreProduct(99, undefined, 10);
        expect(result).toBe(20);

        // The StoreProduct query (SELECT productId FROM StoreProduct) should NOT have been called.
        const calls = mockQuery.mock.calls.map((c) => c[0] as string);
        const hasStoreProductLookup = calls.some((sql) => /StoreProduct/i.test(sql));
        expect(hasStoreProductLookup).toBe(false);
    });

    it('performs the StoreProduct lookup when cachedProductId is NOT provided', async () => {
        // First call: SELECT productId FROM StoreProduct
        mockQuery.mockResolvedValueOnce([[{ productId: 10 }]]);
        // Second call: resolveEffectiveProductId CTE
        mockQuery.mockResolvedValueOnce([[{ id: 10 }]]);
        // Third call: SELECT baseProductId FROM Product
        mockQuery.mockResolvedValueOnce([[{ baseProductId: 20 }]]);

        const result = await getEffectiveBaseProductIdForStoreProduct(99);
        expect(result).toBe(20);

        const calls = mockQuery.mock.calls.map((c) => c[0] as string);
        const hasStoreProductLookup = calls.some((sql) => /StoreProduct/i.test(sql));
        expect(hasStoreProductLookup).toBe(true);
    });
});
