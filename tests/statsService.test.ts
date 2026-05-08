import { jest } from '@jest/globals';

// computeReceiptSavings accepts an optional `conn` — no module mock needed.
// getUserStats uses `pool` directly, so we mock db.js for those tests.
const mockPoolQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockPoolQuery },
}));

let computeReceiptSavings: any;
let getUserStats: any;

beforeAll(async () => {
    const mod = await import('../src/services/statsService.js');
    computeReceiptSavings = mod.computeReceiptSavings;
    getUserStats = mod.getUserStats;
});

// resetAllMocks (not clearAllMocks) is required here: clearAllMocks only
// resets call tracking but leaves mockResolvedValueOnce queues intact.
// Tests that receive fewer receipts (skipping the category query) would
// leave a queued value that bleeds into the next test's mock responses.
beforeEach(() => jest.resetAllMocks());

// ---------------------------------------------------------------------------
// computeReceiptSavings
// (injectable conn avoids module-level pool; tests are fully synchronous-ish)
// ---------------------------------------------------------------------------

describe('computeReceiptSavings', () => {
    function makeConn(spRows: any[], avgRows: any[]) {
        return {
            query: jest.fn<any>()
                .mockResolvedValueOnce([spRows])   // SP → productId lookup
                .mockResolvedValueOnce([avgRows]), // avg price per product
        };
    }

    it('returns 0 immediately for empty item list without hitting the DB', async () => {
        const conn = { query: jest.fn() };
        expect(await computeReceiptSavings([], conn)).toBe(0);
        expect(conn.query).not.toHaveBeenCalled();
    });

    it('returns 0 when all items have storeProductId <= 0 or price <= 0', async () => {
        const conn = { query: jest.fn() };
        const items = [
            { storeProductId: 0,  price: 1.50, quantity: 1 },
            { storeProductId: 10, price: 0,    quantity: 1 },
        ];
        expect(await computeReceiptSavings(items, conn)).toBe(0);
        expect(conn.query).not.toHaveBeenCalled();
    });

    it('returns 0 when no SP rows are found in the DB', async () => {
        const conn = makeConn([], []); // empty SP lookup → short-circuit
        const items = [{ storeProductId: 10, price: 1.50, quantity: 1 }];
        expect(await computeReceiptSavings(items, conn)).toBe(0);
    });

    it('computes savings correctly via two-query batch', async () => {
        const conn = makeConn(
            [{ id: 10, productId: 100 }],
            [{ productId: 100, avg_price: '2.00' }]
        );
        const items = [{ storeProductId: 10, price: 1.50, quantity: 1 }];

        // Saved 0.50: market avg 2.00 − paid 1.50
        expect(await computeReceiptSavings(items, conn)).toBeCloseTo(0.50);
    });

    it('multiplies savings delta by quantity', async () => {
        const conn = makeConn(
            [{ id: 10, productId: 100 }],
            [{ productId: 100, avg_price: '2.00' }]
        );
        const items = [{ storeProductId: 10, price: 1.50, quantity: 3 }];

        // (2.00 − 1.50) × 3 = 1.50
        expect(await computeReceiptSavings(items, conn)).toBeCloseTo(1.50);
    });

    it('returns negative savings when the receipt price exceeds the market avg', async () => {
        const conn = makeConn(
            [{ id: 10, productId: 100 }],
            [{ productId: 100, avg_price: '1.80' }]
        );
        const items = [{ storeProductId: 10, price: 2.00, quantity: 1 }];

        expect(await computeReceiptSavings(items, conn)).toBeCloseTo(-0.20);
    });

    it('issues exactly 2 DB queries regardless of item count', async () => {
        const conn = makeConn(
            [{ id: 10, productId: 100 }, { id: 11, productId: 101 }],
            [{ productId: 100, avg_price: '2.00' }, { productId: 101, avg_price: '3.00' }]
        );
        const items = [
            { storeProductId: 10, price: 1.50, quantity: 1 },
            { storeProductId: 11, price: 2.50, quantity: 2 },
        ];

        await computeReceiptSavings(items, conn);

        expect((conn.query as jest.Mock).mock.calls).toHaveLength(2);
    });

    it('market avg query includes scraped catalog prices (isFallback=1, receiptId IS NULL)', async () => {
        const conn = makeConn(
            [{ id: 10, productId: 100 }],
            [{ productId: 100, avg_price: '2.50' }], // avg from scraped + real prices
        );
        const items = [{ storeProductId: 10, price: 2.00, quantity: 1 }];

        // With scraped Rimi data (isFallback=1, receiptId IS NULL) avg = 2.50
        // Savings = 2.50 − 2.00 = 0.50
        expect(await computeReceiptSavings(items, conn)).toBeCloseTo(0.50);
        // Verify the second query uses the inclusive condition
        const avgSql: string = (conn.query as jest.Mock).mock.calls[1][0];
        expect(avgSql).toMatch(/receiptId IS NULL/i);
    });
});

// ---------------------------------------------------------------------------
// getUserStats
// (uses pool directly; pool is mocked at module level)
// ---------------------------------------------------------------------------

describe('getUserStats', () => {
    // Query order for receipts with storeProductId items:
    //   1. Receipts query (always)
    //   2. SP→productId+category join (when any item has storeProductId)
    //   3. Market avg query for savings (when spPriceList is non-empty)
    //
    // For receipts WITHOUT storeProductId items the SP and market avg queries
    // are skipped — only the receipts query fires.

    // Helper: set up pool for receipts that have no storeProductId items.
    // Savings will be 0 (no matched SPs) — no extra queries needed.
    function setupPoolNoSp(receipts: any[]) {
        mockPoolQuery.mockResolvedValueOnce([receipts]);
    }

    // Helper: set up pool for receipts WITH storeProductId items.
    // Caller provides the SP rows (query 2) and avg rows (query 3).
    function setupPoolWithSp(
        receipts: any[],
        spRows: any[],
        avgRows: any[],
    ) {
        mockPoolQuery
            .mockResolvedValueOnce([receipts])  // receipts
            .mockResolvedValueOnce([spRows])    // SP→productId+category
            .mockResolvedValueOnce([avgRows]);  // market avg
    }

    it('returns empty breakdowns and 0 savings when the user has no receipts', async () => {
        setupPoolNoSp([]);

        const result = await getUserStats('user-empty');

        expect(result.storeBreakdown).toHaveLength(0);
        expect(result.categoryBreakdown).toHaveLength(0);
        expect(result.totalSavings).toBe(0);
        expect(result.monthlySpending).toHaveLength(6);
        expect(result.monthlySpending.every((m: any) => m.total === 0)).toBe(true);
    });

    it('always returns exactly 6 monthly spending entries', async () => {
        setupPoolNoSp([]);
        const result = await getUserStats('user1');
        expect(result.monthlySpending).toHaveLength(6);
    });

    it('aggregates spending by chain into storeBreakdown (no storeProductId → no SP query)', async () => {
        const parsedData = {
            products: [
                { price: '2.00', quantity: '3' }, // 6.00
                { price: '1.50', quantity: '1' }, // 1.50
            ],
        };
        setupPoolNoSp([
            { receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' },
            { receiptDate: '2026-05-02', parsedData: { products: [{ price: '5.00', quantity: '1' }] }, chainName: 'Rimi' },
        ]);

        const result = await getUserStats('user1');

        const maxima = result.storeBreakdown.find((s: any) => s.chainName === 'Maxima');
        const rimi   = result.storeBreakdown.find((s: any) => s.chainName === 'Rimi');

        expect(maxima.total).toBeCloseTo(7.50); // 6.00 + 1.50
        expect(rimi.total).toBeCloseTo(5.00);
    });

    it('assigns correct brand colour to known chains', async () => {
        setupPoolNoSp([{ receiptDate: '2026-05-01', parsedData: { products: [{ price: '1.00', quantity: '1' }] }, chainName: 'Lidl' }]);

        const result = await getUserStats('user1');
        const lidl = result.storeBreakdown.find((s: any) => s.chainName === 'Lidl');
        expect(lidl.color).toBe('#0095D9');
    });

    it('falls back to Kita when chainName is null', async () => {
        setupPoolNoSp([{ receiptDate: '2026-05-01', parsedData: { products: [{ price: '1.00', quantity: '1' }] }, chainName: null }]);

        const result = await getUserStats('user1');
        const kita = result.storeBreakdown.find((s: any) => s.chainName === 'Kita');
        expect(kita).toBeDefined();
    });

    it('aggregates spending by L2 category into categoryBreakdown', async () => {
        // The SP query now resolves L2 via CASE + LEFT JOIN on Category.
        // Mock returns the already-resolved L2 name in categoryName.
        const parsedData = {
            products: [
                { price: '3.00', quantity: '2', storeProductId: 10 }, // 6.00 → Pienas (L2)
                { price: '1.00', quantity: '1', storeProductId: 10 }, // 1.00 → Pienas (L2)
                { price: '2.00', quantity: '1', storeProductId: 11 }, // 2.00 → Šviežia mėsa (L2)
            ],
        };
        setupPoolWithSp(
            [{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [
                // categoryName is the resolved L2 name (NULL for L1 products — excluded from breakdown)
                { spId: 10, productId: 100, categoryName: 'Pienas' },
                { spId: 11, productId: 101, categoryName: 'Šviežia mėsa ir paukštiena' },
            ],
            [], // no avg data → savings = 0
        );

        const result = await getUserStats('user1');
        const pienas = result.categoryBreakdown.find((c: any) => c.categoryName === 'Pienas');
        const mesa   = result.categoryBreakdown.find((c: any) => c.categoryName === 'Šviežia mėsa ir paukštiena');

        expect(pienas.total).toBeCloseTo(7.00); // 6.00 + 1.00
        expect(mesa.total).toBeCloseTo(2.00);
    });

    it('computes totalSavings dynamically from market avg vs receipt prices', async () => {
        // User paid 1.50 for sp10 (productId=100). Market avg = 2.00 → saved 0.50.
        const parsedData = { products: [{ price: '1.50', quantity: '1', storeProductId: 10 }] };
        setupPoolWithSp(
            [{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [{ productId: 100, avg_price: '2.00' }],
        );

        const result = await getUserStats('user1');
        expect(result.totalSavings).toBeCloseTo(0.50);
    });

    it('returns negative totalSavings when receipt price exceeds market avg', async () => {
        const parsedData = { products: [{ price: '2.50', quantity: '1', storeProductId: 10 }] };
        setupPoolWithSp(
            [{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [{ productId: 100, avg_price: '2.00' }],
        );

        const result = await getUserStats('user1');
        expect(result.totalSavings).toBeCloseTo(-0.50);
    });

    it('accumulates savings across multiple receipts and items', async () => {
        // Receipt 1: sp10, paid 1.50, avg 2.00, qty 2 → saved 1.00
        // Receipt 2: sp11, paid 3.00, avg 4.00, qty 1 → saved 1.00
        const r1 = { products: [{ price: '1.50', quantity: '2', storeProductId: 10 }] };
        const r2 = { products: [{ price: '3.00', quantity: '1', storeProductId: 11 }] };
        setupPoolWithSp(
            [
                { receiptDate: '2026-05-01', parsedData: r1, chainName: 'Maxima' },
                { receiptDate: '2026-05-02', parsedData: r2, chainName: 'Rimi' },
            ],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }, { spId: 11, productId: 101, categoryName: 'Mėsa' }],
            [{ productId: 100, avg_price: '2.00' }, { productId: 101, avg_price: '4.00' }],
        );

        const result = await getUserStats('user1');
        expect(result.totalSavings).toBeCloseTo(2.00); // 1.00 + 1.00
    });

    it('returns 0 savings when no market avg prices exist for the products', async () => {
        const parsedData = { products: [{ price: '2.00', quantity: '1', storeProductId: 10 }] };
        setupPoolWithSp(
            [{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [], // no avg rows → no cross-chain data
        );

        const result = await getUserStats('user1');
        expect(result.totalSavings).toBe(0);
    });

    it('skips items with zero or negative price', async () => {
        const parsedData = {
            products: [
                { price: '0',    quantity: '1' },
                { price: '-1.00', quantity: '1' },
                { price: '2.00', quantity: '1' }, // only this should count toward spending
            ],
        };
        setupPoolNoSp([{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }]);

        const result = await getUserStats('user1');
        const maxima = result.storeBreakdown.find((s: any) => s.chainName === 'Maxima');
        expect(maxima.total).toBeCloseTo(2.00);
    });

    it('excludes L1 categories (categoryName NULL) from categoryBreakdown', async () => {
        // sp10 maps to L1 (categoryName = null) — should not appear in categoryBreakdown
        // sp11 maps to L2 (categoryName = 'Pienas') — should appear
        const parsedData = {
            products: [
                { price: '5.00', quantity: '1', storeProductId: 10 },
                { price: '2.00', quantity: '1', storeProductId: 11 },
            ],
        };
        setupPoolWithSp(
            [{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [
                { spId: 10, productId: 100, categoryName: null },   // L1 → excluded
                { spId: 11, productId: 101, categoryName: 'Pienas' }, // L2 → included
            ],
            [],
        );

        const result = await getUserStats('user1');
        expect(result.categoryBreakdown).toHaveLength(1);
        expect(result.categoryBreakdown[0].categoryName).toBe('Pienas');
    });

    it('issues at most 3 pool queries for receipts with matched SPs', async () => {
        const parsedData = { products: [{ price: '1.00', quantity: '1', storeProductId: 10 }] };
        setupPoolWithSp(
            [{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [{ productId: 100, avg_price: '2.00' }],
        );

        await getUserStats('user1');

        // receipts + SP join + market avg = 3
        expect(mockPoolQuery).toHaveBeenCalledTimes(3);
    });

    it('issues only 1 pool query when there are no receipts', async () => {
        setupPoolNoSp([]);
        await getUserStats('user1');
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });
});
