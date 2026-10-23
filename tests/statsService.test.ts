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
    // Query order (post-ReceiptItem-cutover, perf audit #14):
    //   1. Receipts query (always — NO parsedData column anymore)
    //   2. ReceiptItem batch query (when any receipts exist)
    //   3. LEGACY BLOB fetch: parsedData for ONLY the receipts with no
    //      ReceiptItem rows (skipped entirely when every receipt has rows)
    //   4. SP→productId+category join (when any item has storeProductId)
    //   5. Market avg query for savings (when spPriceList is non-empty)
    //
    // Items come from ReceiptItem rows; the blob products/items is ONLY the
    // legacy fallback for receipts that have no rows. Receipts need an `id`
    // for the item grouping AND the blob linkage — helpers assign one when a
    // fixture omits it (production rows always have ids).

    // Queue the conditional legacy-blob fetch: the fixture keeps parsedData on
    // the receipt row for authoring convenience; production serves it from the
    // dedicated id-scoped query this mocks.
    function queueLegacyBlobFetch(receipts: any[], itemRows: any[]) {
        receipts.forEach((r: any, i: number) => { if (r.id == null) r.id = i + 1; });
        const withRows = new Set(itemRows.map((r: any) => Number(r.receiptId)));
        const legacy = receipts.filter((r: any) => !withRows.has(Number(r.id)));
        if (legacy.length > 0) {
            mockPoolQuery.mockResolvedValueOnce([
                legacy.map((r: any) => ({ id: r.id, parsedData: r.parsedData })),
            ]);
        }
    }

    // Helper: receipts whose items carry no storeProductId (SP + avg queries skipped).
    // itemRows defaults to [] = legacy blob fallback path.
    function setupPoolNoSp(receipts: any[], itemRows: any[] = []) {
        mockPoolQuery.mockResolvedValueOnce([receipts]);
        if (receipts.length > 0) {
            mockPoolQuery.mockResolvedValueOnce([itemRows]);
            queueLegacyBlobFetch(receipts, itemRows);
        }
    }

    // Helper: receipts WITH storeProductId items.
    function setupPoolWithSp(
        receipts: any[],
        spRows: any[],
        avgRows: any[],
        itemRows: any[] = [],
    ) {
        mockPoolQuery
            .mockResolvedValueOnce([receipts])  // receipts
            .mockResolvedValueOnce([itemRows]); // ReceiptItem batch
        queueLegacyBlobFetch(receipts, itemRows);
        mockPoolQuery
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

    it('savingsLastMonth is clamped to the same period last month (MTD baseline)', async () => {
        // Three receipts on the same product (avg 2.00):
        //   A: THIS month day 2      → saved 0.50 (this-month bucket)
        //   B: LAST month day 1      → saved 0.30 (always inside the MTD window)
        //   C: LAST month, final day → saved 0.20 (inside only when the cutoff
        //      reaches the end of last month, i.e. today is month-end-ish)
        const now = new Date();
        const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const daysInLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
        const cutoff = Math.min(now.getDate(), daysInLastMonth);
        const d = (base: Date, day: number) =>
            `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

        const mk = (id: number, date: string, price: string) => ({
            id,
            receiptDate: date,
            parsedData: { products: [{ price, quantity: '1', storeProductId: 10 }] },
            chainName: 'Maxima',
        });
        setupPoolWithSp(
            [
                mk(1, d(now, 2), '1.50'),
                mk(2, d(lastM, 1), '1.70'),
                mk(3, d(lastM, daysInLastMonth), '1.80'),
            ],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [{ productId: 100, avg_price: '2.00' }],
        );

        const result = await getUserStats('user1');
        expect(result.savingsThisMonth).toBeCloseTo(0.50);
        const expected = 0.30 + (cutoff >= daysInLastMonth ? 0.20 : 0);
        expect(result.savingsLastMonth).toBeCloseTo(expected);
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

    it('buckets uncategorised (categoryName NULL) into Nepriskirta, not dropped', async () => {
        // sp10 maps to L1 (categoryName = null) — must NOT be dropped: it lands in
        // the "Nepriskirta" bucket so the donut total reconciles with the spend.
        // sp11 maps to L2 (categoryName = 'Pienas').
        const parsedData = {
            products: [
                { price: '5.00', quantity: '1', storeProductId: 10 },
                { price: '2.00', quantity: '1', storeProductId: 11 },
            ],
        };
        setupPoolWithSp(
            [{ receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [
                { spId: 10, productId: 100, categoryName: null },   // L1 → Nepriskirta
                { spId: 11, productId: 101, categoryName: 'Pienas' }, // L2 → included
            ],
            [],
        );

        const result = await getUserStats('user1');
        expect(result.categoryBreakdown).toHaveLength(2);
        const byName = Object.fromEntries(result.categoryBreakdown.map((c: any) => [c.categoryName, c.total]));
        expect(byName['Pienas']).toBeCloseTo(2.00);
        expect(byName['Nepriskirta']).toBeCloseTo(5.00);
        // The breakdown now sums to the full spend (nothing dropped).
        const sum = result.categoryBreakdown.reduce((s: number, c: any) => s + c.total, 0);
        expect(sum).toBeCloseTo(7.00);
    });

    it('issues at most 4 pool queries for row-backed receipts (no blob fetch)', async () => {
        // Post-cutover receipt: items come from ReceiptItem rows, so the
        // conditional legacy-blob query must NOT run.
        setupPoolWithSp(
            [{ id: 1, receiptDate: '2026-05-01', parsedData: { products: [] }, chainName: 'Maxima' }],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [{ productId: 100, avg_price: '2.00' }],
            [{ receiptId: 1, storeProductId: 10, price: '1.00', promoPrice: null, quantity: '1' }],
        );

        await getUserStats('user1');

        // receipts + ReceiptItem batch + SP join + market avg = 4
        expect(mockPoolQuery).toHaveBeenCalledTimes(4);
    });

    it('adds exactly ONE extra query when legacy blob-only receipts are present', async () => {
        const parsedData = { products: [{ price: '1.00', quantity: '1', storeProductId: 10 }] };
        setupPoolWithSp(
            [{ id: 1, receiptDate: '2026-05-01', parsedData, chainName: 'Maxima' }],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [{ productId: 100, avg_price: '2.00' }],
        );

        await getUserStats('user1');

        // receipts + ReceiptItem batch + LEGACY BLOB + SP join + market avg = 5
        expect(mockPoolQuery).toHaveBeenCalledTimes(5);
    });

    it('issues only 1 pool query when there are no receipts', async () => {
        setupPoolNoSp([]);
        await getUserStats('user1');
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    // ── ReceiptItem cutover: rows are the item source, the blob is empty ──

    it('aggregates from ReceiptItem rows when the blob products[] is empty (post-cutover receipts)', async () => {
        // The P0 regression this guards: post-cutover blobs store products: [],
        // so a blob-only read reports zero spending/savings for every new receipt.
        setupPoolWithSp(
            [{ id: 42, receiptDate: '2026-05-01', parsedData: { products: [] }, chainName: 'Maxima' }],
            [{ spId: 10, productId: 100, categoryName: 'Pienas' }],
            [{ productId: 100, avg_price: '2.00' }],
            [{ receiptId: 42, storeProductId: 10, price: '1.50', promoPrice: null, quantity: '2' }],
        );

        const result = await getUserStats('user1');

        const maxima = result.storeBreakdown.find((s: any) => s.chainName === 'Maxima');
        expect(maxima.total).toBeCloseTo(3.00);          // 1.50 × 2 from the ROWS
        expect(result.totalSavings).toBeCloseTo(1.00);   // (2.00 − 1.50) × 2
        const pienas = result.categoryBreakdown.find((c: any) => c.categoryName === 'Pienas');
        expect(pienas.total).toBeCloseTo(3.00);
    });

    it('uses promoPrice from ReceiptItem rows when set (what the user actually paid)', async () => {
        setupPoolNoSp(
            [{ id: 7, receiptDate: '2026-05-01', parsedData: { products: [] }, chainName: 'Lidl' }],
            [{ receiptId: 7, storeProductId: null, price: '2.00', promoPrice: '1.20', quantity: '1' }],
        );

        const result = await getUserStats('user1');
        const lidl = result.storeBreakdown.find((s: any) => s.chainName === 'Lidl');
        expect(lidl.total).toBeCloseTo(1.20);
    });

    it('mixes row-backed and legacy blob-backed receipts in one aggregation', async () => {
        // Receipt 1 (post-cutover): rows only, blob empty. Receipt 2 (legacy): blob only, no rows.
        setupPoolNoSp(
            [
                { id: 1, receiptDate: '2026-05-01', parsedData: { products: [] }, chainName: 'Maxima' },
                { id: 2, receiptDate: '2026-05-02', parsedData: { products: [{ price: '5.00', quantity: '1' }] }, chainName: 'Rimi' },
            ],
            [{ receiptId: 1, storeProductId: null, price: '2.00', promoPrice: null, quantity: '1' }],
        );

        const result = await getUserStats('user1');
        expect(result.storeBreakdown.find((s: any) => s.chainName === 'Maxima').total).toBeCloseTo(2.00);
        expect(result.storeBreakdown.find((s: any) => s.chainName === 'Rimi').total).toBeCloseTo(5.00);
    });
});
