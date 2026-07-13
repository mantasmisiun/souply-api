import { jest } from '@jest/globals';

/**
 * Round-2.5 price-scoped rescue fishing (receipt-237 salmon): a line still UNLINKED
 * after Rounds 1+2 fishes same-chain SPs by its printed REGULAR price and re-scores
 * their names at the relaxed floor WITHIN that price-vetted pool. Survivors append
 * to altMatches flagged viaPrice — never auto-linked. The pool query is mocked; the
 * relaxed scorer is the REAL one (that is the part worth pinning).
 *
 * Also pins the Fix-4 promo-consistency gate: a promo-less (stale) price row can no
 * longer CONFIRM a line that visibly paid a discount — the receipt-237 wrong-link.
 */
const mockGetAsOfDatePrices = jest.fn<any>();
const mockFishPool = jest.fn<any>();
const mockCountNear = jest.fn<any>();
jest.unstable_mockModule('../src/models/priceModel.js', () => ({
    // Fishing selectivity pre-check — selective by default so fishing paths run in tests.
    countPriceRowsNearValue: mockCountNear,
    getAsOfDatePricesForCandidates: mockGetAsOfDatePrices,
    getChainSpsByRegularPrice: mockFishPool,
}));

const { applyPriceRound2Matching, fishPriceScopedCandidates } = await import('../src/services/priceRound2Matcher.js');

const RECEIPT_DATE = new Date('2026-06-11T18:07:00');

beforeEach(() => { mockGetAsOfDatePrices.mockReset(); mockFishPool.mockReset(); mockCountNear.mockReset().mockResolvedValue(0); });

const poolSp = (o: Record<string, any>) => ({
    storeProductId: 0, productId: 0, categoryId: null, categoryName: null, categoryL2Name: null,
    name: '', brandName: null, amount: null, unit: null, isWeighable: false, isCatalog: true, imageUrl: null,
    ...o,
});

const salmonLine = (o: Record<string, any> = {}) => ({
    name: 'ATLATINES LAŠISOSs BE GAL',
    storeProductId: null, matchConfidence: 0.69,
    price: 16.99, promoPrice: 9.99, quantity: 1.068, unit: 'kg', pricePerUnit: 16.99,
    isWeighable: false,
    altMatches: [{ storeProductId: 58876, confidence: 0.69, name: 'Atšaldytos skrostos atlantinės lašišos 4/6' }],
    ...o,
});

describe('fishPriceScopedCandidates', () => {
    it('appends price-anchored candidates that clear the relaxed name floor, flagged viaPrice', async () => {
        mockFishPool.mockResolvedValue([
            poolSp({ storeProductId: 97839, productId: 97538, name: 'Atšaldytos skrostos atlantinių lašišų gabalai' }),
            poolSp({ storeProductId: 55580, name: 'Degtinė ABSOLUT 40%' }),          // price twin, unrelated name
            poolSp({ storeProductId: 61167, name: 'Karštai rūkyti vaivorykštinio upėtakio gabalai' }), // different fish
        ]);
        const line = salmonLine();
        const fished = await fishPriceScopedCandidates([line], 3, RECEIPT_DATE, 237, {} as any);
        expect(fished).toBe(1);
        const added = line.altMatches.filter((a: any) => a.viaPrice);
        expect(added.map((a: any) => a.storeProductId)).toEqual([97839]);
        expect(added[0].confidence).toBeGreaterThanOrEqual(0.45);
        // original Round-1 candidates untouched, in front
        expect(line.altMatches[0].storeProductId).toBe(58876);
    });

    it('a DISCOUNTED line requires promo-bearing anchors (requirePromo flows to the pool query)', async () => {
        mockFishPool.mockResolvedValue([]);
        await fishPriceScopedCandidates([salmonLine()], 3, RECEIPT_DATE, 237, {} as any);
        // getChainSpsByRegularPrice(chainId, reg, tol, date, window, receiptId, excl, limit, requirePromo, conn)
        expect(mockFishPool.mock.calls[0][8]).toBe(true);
        mockFishPool.mockClear();
        mockFishPool.mockResolvedValue([]);
        await fishPriceScopedCandidates([salmonLine({ promoPrice: null })], 3, RECEIPT_DATE, 237, {} as any);
        expect(mockFishPool.mock.calls[0][8]).toBe(false);
    });

    it('weighed lines anchor on €/kg (pricePerUnit), and Round-1 candidates are excluded from the pool', async () => {
        mockFishPool.mockResolvedValue([]);
        await fishPriceScopedCandidates([salmonLine()], 3, RECEIPT_DATE, 237, {} as any);
        const [, reg, , , , , excludeIds] = mockFishPool.mock.calls[0];
        expect(reg).toBe(16.99);
        expect(excludeIds).toEqual([58876]);
    });

    it('NON-SELECTIVE anchors skip fishing entirely (the 1.99 save-hang class)', async () => {
        // 500k+ Price rows share the value → no identity signal AND the expensive query
        // shape (receipt-238: two such pool queries pushed the save past the client
        // timeout). The bounded count gates it before the pool query ever runs.
        mockCountNear.mockResolvedValue(150_001);
        mockFishPool.mockResolvedValue([poolSp({ storeProductId: 1, name: 'irrelevant' })]);
        const line = salmonLine({ promoPrice: null, price: 1.99, pricePerUnit: 1.99 });
        const fished = await fishPriceScopedCandidates([line], 3, RECEIPT_DATE, 238, {} as any);
        expect(fished).toBe(0);
        expect(mockFishPool).not.toHaveBeenCalled();
    });

    it('LINKED lines and price-less lines never fish', async () => {
        mockFishPool.mockResolvedValue([]);
        const fished = await fishPriceScopedCandidates([
            salmonLine({ storeProductId: 61591 }),
            salmonLine({ price: 0, pricePerUnit: 0, unit: null }),
        ], 3, RECEIPT_DATE, 237, {} as any);
        expect(fished).toBe(0);
        expect(mockFishPool).not.toHaveBeenCalled();
    });
});

describe('Round-2 promo-consistency (Fix 4 — the receipt-237 wrong link)', () => {
    it('a promo-less stale row can NOT confirm a line that visibly paid a discount', async () => {
        // 58876's April snapshot: regular 16.99, no promo — exact regular match, but the
        // line paid 9.99/kg on discount. Before the gate this promoted + priceVerified.
        mockGetAsOfDatePrices.mockResolvedValue(new Map([
            [58876, { price: 16.99, promoPrice: null, promoEnd: null }],
        ]));
        const line = salmonLine();
        const res = await applyPriceRound2Matching([line], 3, RECEIPT_DATE, 237, {} as any);
        expect(res.confirmed).toBe(0);
        expect(line.storeProductId).toBeNull();
        expect(line.priceVerified).toBeFalsy();
    });

    it('an ACTIVE promo still confirms a discounted line (regular match + promo present)', async () => {
        mockGetAsOfDatePrices.mockResolvedValue(new Map([
            [58876, { price: 16.99, promoPrice: 9.99, promoEnd: new Date('2026-06-15') }],
        ]));
        const line = salmonLine();
        const res = await applyPriceRound2Matching([line], 3, RECEIPT_DATE, 237, {} as any);
        expect(res.confirmed).toBe(1);
        expect(line.storeProductId).toBe(58876);
        expect(line.priceVerified).toBe(true);
    });

    it('undiscounted lines keep confirming on the regular price alone', async () => {
        mockGetAsOfDatePrices.mockResolvedValue(new Map([
            [58876, { price: 16.99, promoPrice: null, promoEnd: null }],
        ]));
        const line = salmonLine({ promoPrice: null });
        const res = await applyPriceRound2Matching([line], 3, RECEIPT_DATE, 237, {} as any);
        expect(res.confirmed).toBe(1);
        expect(line.storeProductId).toBe(58876);
    });
});
