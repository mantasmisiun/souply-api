import { jest } from '@jest/globals';

// productModel and storeProductModel are imported by the resolver; mock them
// before the module is loaded so the resolver sees fakes from the start.
const mockCreateProduct = jest.fn<any>();
jest.unstable_mockModule('../src/models/productModel.js', () => ({
    createProduct: mockCreateProduct,
}));

const mockCreateStoreProduct = jest.fn<any>();
const mockFindExact = jest.fn<any>();
const mockMarkWeighable = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeProductModel.js', () => ({
    createStoreProduct: mockCreateStoreProduct,
    findExactMatchingStoreProduct: mockFindExact,
    markStoreProductWeighable: mockMarkWeighable,
}));

// db.js is only used as a fallback when no conn is passed; we always pass a
// mock conn in these tests so the module mock is just a safety net.
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: jest.fn() },
}));

let resolveReceiptLineStoreProduct: any;
let getUnassignedCategoryId: any;

beforeAll(async () => {
    const mod = await import('../src/services/receiptLineResolver.js');
    resolveReceiptLineStoreProduct = mod.resolveReceiptLineStoreProduct;
    getUnassignedCategoryId = mod.getUnassignedCategoryId;
});

beforeEach(() => {
    jest.clearAllMocks();
});

// A minimal ReceiptLineInput with safe defaults.
function makeLine(overrides: Record<string, any> = {}): any {
    return {
        storeProductId: null,
        name: 'Test Product',
        brandName: null,
        amount: null,
        unit: null,
        isWeighable: false,
        imageUrl: null,
        price: 2.00,
        altMatchProductId: null,
        ...overrides,
    };
}

// A minimal StoreProduct row as returned by getSpById.
function makeSpLookup(chainId: number, overrides: Record<string, any> = {}) {
    return {
        id: 10, productId: 100, chainId,
        amount: null, unit: null, imageUrl: null,
        brandName: null, isWeighable: false, storeProductName: 'Test SP',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// getUnassignedCategoryId — caching
// ---------------------------------------------------------------------------

describe('getUnassignedCategoryId', () => {
    it('queries the DB on first call and caches the result', async () => {
        const mockQuery = jest.fn<any>()
            .mockResolvedValue([[{ id: 99 }]]);
        const conn = { query: mockQuery };

        const id1 = await getUnassignedCategoryId(conn);
        const id2 = await getUnassignedCategoryId(conn);

        expect(id1).toBe(99);
        expect(id2).toBe(99);
        // After first call the cache is set, so DB is hit only once total.
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Same-chain SP — returned verbatim, no writes
// ---------------------------------------------------------------------------

describe('resolveReceiptLineStoreProduct — same-chain SP', () => {
    it('returns the supplied SP id when it belongs to the receipt chain', async () => {
        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[makeSpLookup(1)]]); // getSpById → chainId matches
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(1, makeLine({ storeProductId: 10 }), conn);

        expect(result).toEqual({ storeProductId: 10, source: 'reused' });
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
        expect(mockCreateProduct).not.toHaveBeenCalled();
    });

    it('does NOT reuse a same-chain PACKAGED SP for a by-WEIGHT line (falls through)', async () => {
        // Incoming SP 10 is packaged (isWeighable:false); line is by-weight. The
        // weighable mismatch must reject the reuse and fall through to dedup, which
        // here finds a proper weighable SP (60) — proving 10 was NOT reused.
        mockFindExact.mockResolvedValue(60);
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(1, { isWeighable: false })]]) };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, isWeighable: true, price: 3.49 }),
            conn,
        );

        expect(result).toEqual({ storeProductId: 60, source: 'reused' });
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
    });

    it('reuses a WEIGHABLE catalog SP verbatim for a by-weight line — never falls through to a same-name orphan', async () => {
        // Receipt-112 pomidorai regression: once the parser flags the weighed line
        // isWeighable:true, line and the weighable catalog SP agree (no mismatch) so
        // the SP is reused VERBATIM. The exact-name dedup (which here would return a
        // garbled same-name ORPHAN, 97663) must NOT be consulted at all.
        mockFindExact.mockResolvedValue(97663); // the orphan trap — must stay untouched
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(3, { id: 60161, isWeighable: true, amount: 1, unit: 'kg', imageUrl: 'http://img' })]]) };

        const result = await resolveReceiptLineStoreProduct(
            3,
            makeLine({ storeProductId: 60161, isWeighable: true, unit: 'kg', price: 3.99, matchConfidence: 0.9 }),
            conn,
        );

        expect(result).toEqual({ storeProductId: 60161, source: 'reused' });
        expect(mockFindExact).not.toHaveBeenCalled();      // never reached the orphan dedup
        expect(mockMarkWeighable).not.toHaveBeenCalled();  // already weighable, no heal needed
    });

    it('SELF-HEAL: a STRONG by-weight match to a "1 kg" packaged SP flips it weighable and reuses it', async () => {
        // SP 10 is a bulk-weight (kg) row flagged isWeighable:false — a mislabeled
        // weighable produce. A strong (0.9) by-weight match corrects it.
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(1, { isWeighable: false, amount: 1, unit: 'kg' })]]) };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, isWeighable: true, price: 1.85, matchConfidence: 0.9 }),
            conn,
        );

        expect(mockMarkWeighable).toHaveBeenCalledWith(10, conn);
        expect(result).toEqual({ storeProductId: 10, source: 'reused' }); // reused, NOT duplicated
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
    });

    it('SELF-HEAL: a STRONG by-weight match to a UNIT-LESS catalog SP (BON VIA per kg) flips it weighable and reuses it', async () => {
        // "Raudonosios paprikos BON VIA" is sold per kg but the name has no "kg", so the
        // scraper left amount/unit null. A strong by-weight match must flip+reuse it
        // (it has no FIXED pack form) — NOT fall through to the garbled same-name orphan.
        mockFindExact.mockResolvedValue(97666); // the orphan trap — must NOT be reached
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(3, { id: 58857, isWeighable: false, amount: null, unit: null, imageUrl: 'http://img' })]]) };

        const result = await resolveReceiptLineStoreProduct(
            3,
            makeLine({ storeProductId: 58857, isWeighable: true, unit: 'kg', price: 3.49, matchConfidence: 0.95 }),
            conn,
        );

        expect(mockMarkWeighable).toHaveBeenCalledWith(58857, conn);
        expect(result).toEqual({ storeProductId: 58857, source: 'reused' });
        expect(mockFindExact).not.toHaveBeenCalled(); // reused the catalog SP, never dedup'd to an orphan
    });

    it('does NOT self-heal a PER-ITEM (vnt) SP even on a strong match (BON VIA sold per item)', async () => {
        mockFindExact.mockResolvedValue(60);
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(1, { isWeighable: false, amount: 1, unit: 'vnt' })]]) };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, isWeighable: true, price: 1.85, matchConfidence: 0.95 }),
            conn,
        );

        expect(mockMarkWeighable).not.toHaveBeenCalled(); // per-item is never weighable
        expect(result).toEqual({ storeProductId: 60, source: 'reused' });
    });

    it('does NOT self-heal a packaged SP with a FIXED pack size (180 g) even on a strong match', async () => {
        mockFindExact.mockResolvedValue(60);
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(1, { isWeighable: false, amount: 180, unit: 'g' })]]) };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, isWeighable: true, price: 1.85, matchConfidence: 0.95 }),
            conn,
        );

        expect(mockMarkWeighable).not.toHaveBeenCalled();
        expect(result).toEqual({ storeProductId: 60, source: 'reused' }); // fell through, not flipped
    });

    it('does NOT self-heal on a WEAK by-weight match (below the self-heal confidence)', async () => {
        mockFindExact.mockResolvedValue(60);
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(1, { isWeighable: false, amount: 1, unit: 'kg' })]]) };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, isWeighable: true, price: 1.85, matchConfidence: 0.6 }),
            conn,
        );

        expect(mockMarkWeighable).not.toHaveBeenCalled();
        expect(result).toEqual({ storeProductId: 60, source: 'reused' });
    });
});

// ---------------------------------------------------------------------------
// Cross-chain SP — bootstrap gate logic
// ---------------------------------------------------------------------------

describe('resolveReceiptLineStoreProduct — cross-chain bootstrap', () => {
    it('reuses an existing same-chain SP when gates pass and one exists', async () => {
        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[makeSpLookup(2)]])   // getSpById → different chain
            .mockResolvedValueOnce([[{ price: '2.00' }]]) // getLatestPriceForSp → in band (line.price=2.00, ratio=1)
            .mockResolvedValueOnce([[{ id: 20 }]]);       // findSpByChainProductSize → found
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, price: 2.00 }),
            conn
        );

        expect(result).toEqual({ storeProductId: 20, source: 'reused', crossChainBootstrap: true });
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
    });

    it('creates a new SP in the receipt chain when gates pass and no existing SP', async () => {
        mockCreateStoreProduct.mockResolvedValue(30);

        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[makeSpLookup(2)]])   // getSpById → cross-chain
            .mockResolvedValueOnce([[{ price: '2.00' }]]) // price in band
            .mockResolvedValueOnce([[]]);                  // no existing SP in chain
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, price: 2.00 }),
            conn
        );

        expect(result).toEqual({ storeProductId: 30, source: 'bootstrapped', crossChainBootstrap: true });
        expect(mockCreateStoreProduct).toHaveBeenCalledTimes(1);
        expect(mockCreateProduct).not.toHaveBeenCalled();
    });

    it('passes open (bootstraps) when the alt SP has no price history', async () => {
        mockCreateStoreProduct.mockResolvedValue(30);

        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[makeSpLookup(2)]]) // cross-chain
            .mockResolvedValueOnce([[]])                 // no price → fail open
            .mockResolvedValueOnce([[]]);                // no existing in chain
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, price: 2.00 }),
            conn
        );

        expect(result.source).toBe('bootstrapped');
        expect(result.crossChainBootstrap).toBe(true);
    });

    it('rejects and creates fresh product when line price is out of band (< 60% of alt price)', async () => {
        // line.price=1.00, alt SP latest price=10.00 → ratio=0.10 < 0.60 → reject
        mockCreateProduct.mockResolvedValue(200);
        mockCreateStoreProduct.mockResolvedValue(300);

        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[makeSpLookup(2)]])    // getSpById → cross-chain
            .mockResolvedValueOnce([[{ price: '10.00' }]]) // getLatestPriceForSp → out of band
            .mockResolvedValueOnce([[]]);                   // findSpByChainProductSize (parallel, discarded on reject)
        // unassignedCategoryIdCache already set from earlier test — no extra pool.query
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, price: 1.00 }),
            conn
        );

        expect(result.source).toBe('created');
        expect(result.rejectReason).toBe('price_out_of_band');
        expect(mockCreateStoreProduct).toHaveBeenCalledTimes(1);
    });

    it('rejects and creates fresh product when amounts mismatch', async () => {
        // line.amount=0.5 kg, alt SP amount=1.0 kg → mismatch
        mockCreateProduct.mockResolvedValue(200);
        mockCreateStoreProduct.mockResolvedValue(300);

        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[makeSpLookup(2, { amount: 1.0, unit: 'kg' })]])
            .mockResolvedValueOnce([[{ price: '2.00' }]]) // getLatestPriceForSp → price in band (ratio=1)
            .mockResolvedValueOnce([[]]);                  // findSpByChainProductSize (parallel, discarded on reject)
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, price: 2.00, amount: 0.5, unit: 'kg' }),
            conn
        );

        expect(result.source).toBe('created');
        expect(result.rejectReason).toBe('amount_mismatch');
    });

    it('on gate rejection, does NOT reuse altMatchProductId — creates a fresh Product instead', async () => {
        // Regression guard for the cross-chain bootstrap inconsistency:
        // previously the rejection path fell through to
        // createFreshProductAndSp, which silently reused
        // line.altMatchProductId, leaking the rejected cross-chain
        // Product identity into the new SP. The fix passes
        // skipAltMatchProductReuse=true on rejection, forcing a new
        // Product so the gate decision sticks at the Product level too.
        mockCreateProduct.mockResolvedValue(777);
        mockCreateStoreProduct.mockResolvedValue(888);

        const mockQuery = jest.fn<any>()
            // getSpById → cross-chain SP (chainId=2, receipt is chainId=1)
            .mockResolvedValueOnce([[makeSpLookup(2)]])
            // getLatestPriceForSp → 10.00, line is 1.00 → ratio 0.10, out of band
            .mockResolvedValueOnce([[{ price: '10.00' }]])
            // findSpByChainProductSize (parallel, discarded on reject)
            .mockResolvedValueOnce([[]]);
        // No altMatchProductId DB lookup should fire — that's the whole
        // point of the fix. If it does, we'd need a fourth mock and the
        // test would still fail because of the expectations below.
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({
                storeProductId: 10,
                price: 1.00,
                altMatchProductId: 555, // cross-chain Product the matcher surfaced
            }),
            conn
        );

        // A fresh Product was created (proves altMatchProductId was NOT reused).
        expect(mockCreateProduct).toHaveBeenCalledTimes(1);
        // The new SP points at the freshly-created Product, NOT at 555.
        expect(mockCreateStoreProduct).toHaveBeenCalledWith(
            777,            // freshly-created productId, not altMatchProductId
            1,              // receipt's chain
            'Test Product', // line.name
            null, false, null, null, null,
            conn
        );
        expect(result.source).toBe('created');
        expect(result.rejectReason).toBe('price_out_of_band');
    });
});

// ---------------------------------------------------------------------------
// No SP supplied — dedup / create path
// ---------------------------------------------------------------------------

describe('resolveReceiptLineStoreProduct — no SP (dedup / create)', () => {
    it('reuses an existing SP when exact name+amount+unit match found', async () => {
        mockFindExact.mockResolvedValue(40);
        const conn = { query: jest.fn() };

        const result = await resolveReceiptLineStoreProduct(1, makeLine(), conn);

        expect(result).toEqual({ storeProductId: 40, source: 'reused' });
        expect(mockCreateProduct).not.toHaveBeenCalled();
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
    });

    it('creates a new Product + SP when no exact match exists', async () => {
        mockFindExact.mockResolvedValue(null);
        mockCreateProduct.mockResolvedValue(200);
        mockCreateStoreProduct.mockResolvedValue(300);
        // unassignedCategoryIdCache is set from earlier test — no pool.query needed
        const conn = { query: jest.fn() };

        const result = await resolveReceiptLineStoreProduct(1, makeLine(), conn);

        expect(result).toEqual({ storeProductId: 300, source: 'created' });
        expect(mockCreateProduct).toHaveBeenCalledTimes(1);
        expect(mockCreateStoreProduct).toHaveBeenCalledTimes(1);
    });

    it('reuses the existing Product when altMatchProductId resolves successfully', async () => {
        mockFindExact.mockResolvedValue(null);
        mockCreateStoreProduct.mockResolvedValue(300);

        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[{ id: 999, categoryId: 5 }]]); // altMatchProductId lookup
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ altMatchProductId: 999 }),
            conn
        );

        // createProduct should NOT be called — existing Product 999 was reused
        expect(mockCreateProduct).not.toHaveBeenCalled();
        expect(mockCreateStoreProduct).toHaveBeenCalledWith(999, 1, 'Test Product', null, false, null, null, null, conn);
        expect(result.source).toBe('created');
    });

    it('does NOT cluster under altMatchProductId when its confidence is below the threshold — borrows the categoryId, mints a FRESH Product (apples@0.51 must not file under potatoes)', async () => {
        mockFindExact.mockResolvedValue(null);
        mockCreateProduct.mockResolvedValue(778);
        mockCreateStoreProduct.mockResolvedValue(301);

        const mockQuery = jest.fn<any>()
            .mockResolvedValueOnce([[{ id: 999, categoryId: 5 }]]); // altMatch lookup — categoryId borrowed, Product NOT reused
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ altMatchProductId: 999, altMatchConfidence: 0.51 }),
            conn
        );

        // A FRESH Product (778) was created under the BORROWED category 5 — never clustered under 999.
        expect(mockCreateProduct).toHaveBeenCalledWith(5, null, 'Test Product', conn);
        expect(mockCreateStoreProduct).toHaveBeenCalledWith(778, 1, 'Test Product', null, false, null, null, null, conn);
        expect(result.source).toBe('created');
    });

    it('throws when SP row is deleted and line has no name', async () => {
        const conn = { query: jest.fn<any>().mockResolvedValueOnce([[]])}; // getSpById → not found

        await expect(
            resolveReceiptLineStoreProduct(
                1,
                makeLine({ storeProductId: 10, name: '' }),
                conn
            )
        ).rejects.toThrow('Cannot resolve receipt line without a name');
    });

    it('throws when no SP provided and line name is empty', async () => {
        mockFindExact.mockResolvedValue(null);
        const conn = { query: jest.fn() };

        await expect(
            resolveReceiptLineStoreProduct(1, makeLine({ name: '   ' }), conn)
        ).rejects.toThrow('Cannot resolve receipt line without a name');
    });
});

// ---------------------------------------------------------------------------
// allowCreate=false (price-less / garbled line) — never mint a fresh SP
// ---------------------------------------------------------------------------

describe('resolveReceiptLineStoreProduct — allowCreate=false (garbled, price ≤ 0)', () => {
    it('does NOT create an SP when no existing match and creation is disallowed', async () => {
        mockFindExact.mockResolvedValue(null); // no dedup match
        const conn = { query: jest.fn() };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: null, price: 0 }),
            conn,
            false, // allowCreate
        );

        expect(result).toEqual({ storeProductId: null, source: 'skipped_unpriced' });
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
        expect(mockCreateProduct).not.toHaveBeenCalled();
    });

    it('still REUSES an existing same-chain SP even when creation is disallowed', async () => {
        const mockQuery = jest.fn<any>().mockResolvedValueOnce([[makeSpLookup(1)]]); // getSpById → same chain
        const conn = { query: mockQuery };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: 10, price: 0 }),
            conn,
            false, // allowCreate
        );

        expect(result).toEqual({ storeProductId: 10, source: 'reused' });
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
    });

    it('still REUSES a dedup match (exact name+size) when creation is disallowed', async () => {
        mockFindExact.mockResolvedValue(55); // dedup hit
        const conn = { query: jest.fn() };

        const result = await resolveReceiptLineStoreProduct(
            1,
            makeLine({ storeProductId: null, price: 0 }),
            conn,
            false,
        );

        expect(result).toEqual({ storeProductId: 55, source: 'reused' });
        expect(mockCreateStoreProduct).not.toHaveBeenCalled();
    });
});
