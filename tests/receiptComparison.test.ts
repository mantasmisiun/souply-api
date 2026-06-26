import { jest } from '@jest/globals';

const mockPoolQuery = jest.fn<any>();

jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockPoolQuery },
}));

const mockGetReceiptById = jest.fn<any>();
jest.unstable_mockModule('../src/models/receiptModel.js', () => ({
    getReceiptById: mockGetReceiptById,
}));

const mockGetStoreById = jest.fn<any>();
const mockGetClosestStorePerChainToStore = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeModel.js', () => ({
    getStoreById: mockGetStoreById,
    getClosestStorePerChainToStore: mockGetClosestStorePerChainToStore,
}));

let getReceiptComparison: (id: number) => Promise<any>;

beforeAll(async () => {
    const mod = await import('../src/services/receiptComparisonService.js');
    getReceiptComparison = (mod as any).getReceiptComparison;
});

beforeEach(() => {
    jest.clearAllMocks();
});

const MAXIMA = {
    id: 1, name: 'Maxima', address: 'Algirdo 29',
    chainId: 1, chainName: 'Maxima', logoUrl: null,
};
const RIMI_ALT = {
    storeId: 2, storeName: 'Rimi', storeAddress: 'Naugarduko 20',
    chainId: 2, chainName: 'Rimi', chainLogoUrl: null, distance: 0.5,
};
const NORFA_ALT = {
    storeId: 3, storeName: 'Norfa', storeAddress: 'Jonavos 1',
    chainId: 3, chainName: 'Norfa', chainLogoUrl: null, distance: 1.2,
};

function setReceipt(products: any[]) {
    mockGetReceiptById.mockResolvedValue({ id: 1, storeId: 1, parsedData: { products } });
}

function setStore(altStores: any[] = [RIMI_ALT]) {
    mockGetStoreById.mockResolvedValue([MAXIMA]);
    mockGetClosestStorePerChainToStore.mockResolvedValue(altStores);
}

// Queue the SP-lookup result (SELECT id, productId FROM StoreProduct WHERE id IN (?))
function setSpLookup(rows: { id: number; productId: number }[]) {
    mockPoolQuery.mockResolvedValueOnce([rows]);
}

// Queue the batch price result (the ROW_NUMBER window function query)
function setBatchPrices(rows: any[]) {
    mockPoolQuery.mockResolvedValueOnce([rows]);
}

// ---------------------------------------------------------------------------
// Batch-query behaviour
// ---------------------------------------------------------------------------

describe('batchGetLatestVerifiedPricesForStores', () => {
    it('issues exactly 2 pool.query calls regardless of item count', async () => {
        setReceipt([
            { storeProductId: 10, quantity: 1, price: 2.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
            { storeProductId: 11, quantity: 2, price: 3.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
            { storeProductId: 12, quantity: 1, price: 1.50, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([
            { id: 10, productId: 100 },
            { id: 11, productId: 101 },
            { id: 12, productId: 102 },
        ]);
        setBatchPrices([
            { productId: 100, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 1.80, promoPrice: null },
            { productId: 101, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 2.80, promoPrice: null },
            { productId: 102, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 1.30, promoPrice: null },
        ]);

        await getReceiptComparison(1);

        // 1 SP-lookup + 1 batch price query — not 3×1 = 3 individual calls
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    });

    it('skips pool.query entirely when all items are unrecognised', async () => {
        setReceipt([
            { storeProductId: null, quantity: 1, price: 5.00, promoPrice: null, matchConfirmed: false, unit: 'vnt' },
        ]);
        setStore();

        await getReceiptComparison(1);

        expect(mockPoolQuery).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// calculateItemTotalSync — pricing logic
// ---------------------------------------------------------------------------

describe('item total calculation', () => {
    it('uses price × quantity for non-weighable unit items', async () => {
        setReceipt([
            { storeProductId: 10, quantity: 3, price: 2.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        setBatchPrices([
            { productId: 100, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 1.80, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        expect(rimi.total).toBe(5.40); // 3 × 1.80
    });

    it('uses price-per-unit × quantity for weighable items', async () => {
        setReceipt([
            { storeProductId: 10, quantity: 0.5, price: 1.50, promoPrice: null, matchConfirmed: true, unit: 'kg' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        // Rimi: weighable, 2.80 per kg
        setBatchPrices([
            { productId: 100, isWeighable: 1, amount: 1, unit: 'kg', storeId: 2, price: 2.80, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        expect(rimi.total).toBe(1.40); // 0.5 × 2.80
    });

    it('applies pack math (ceil) for multi-pack SPs', async () => {
        // quantity=3 single items, alt sells in 2-packs
        setReceipt([
            { storeProductId: 10, quantity: 3, price: 4.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        setBatchPrices([
            { productId: 100, isWeighable: 0, amount: 2, unit: 'vnt', storeId: 2, price: 3.50, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        expect(rimi.total).toBe(7.00); // ceil(3/2)=2 packs × 3.50
    });

    it('uses promoPrice as the effective price when present', async () => {
        setReceipt([
            { storeProductId: 10, quantity: 2, price: 2.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        setBatchPrices([
            { productId: 100, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 3.00, promoPrice: 2.50 },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        expect(rimi.total).toBe(5.00); // 2 × 2.50
    });

    it('selects the cheapest per-unit SP when a chain offers multiple sizes', async () => {
        setReceipt([
            { storeProductId: 10, quantity: 1, price: 3.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        // 2.00/1-pack (2.00/unit) vs 3.60/2-pack (1.80/unit) — 2-pack wins
        setBatchPrices([
            { productId: 100, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 2.00, promoPrice: null },
            { productId: 100, isWeighable: 0, amount: 2, unit: 'vnt', storeId: 2, price: 3.60, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        // 1 item → ceil(1/2)=1 pack × 3.60
        expect(rimi.total).toBe(3.60);
    });
});

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

describe('unit conversion', () => {
    it('converts kg to g when store unit is grams', async () => {
        // 0.5 kg purchased; alt sells at 0.004 per gram (weighable)
        setReceipt([
            { storeProductId: 10, quantity: 0.5, price: 2.50, promoPrice: null, matchConfirmed: true, unit: 'kg' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        setBatchPrices([
            { productId: 100, isWeighable: 1, amount: 1, unit: 'g', storeId: 2, price: 0.004, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        // 0.5 kg = 500 g, pricePerUnit = 0.004/g, total = 500 × 0.004 = 2.00
        expect(rimi.total).toBe(2.00);
    });

    it('converts g to kg when store unit is kilograms', async () => {
        // 500 g purchased; alt sells at 3.00 per kg (weighable)
        setReceipt([
            { storeProductId: 10, quantity: 500, price: 1.80, promoPrice: null, matchConfirmed: true, unit: 'g' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        setBatchPrices([
            { productId: 100, isWeighable: 1, amount: 1, unit: 'kg', storeId: 2, price: 3.00, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        // 500 g = 0.5 kg, pricePerUnit = 3.00/kg, total = 0.5 × 3.00 = 1.50
        expect(rimi.total).toBe(1.50);
    });
});

// ---------------------------------------------------------------------------
// Basket composition — imputation, flat items, savings
// ---------------------------------------------------------------------------

describe('basket composition', () => {
    it('imputes average when an alt store does not carry a recognised item', async () => {
        setReceipt([
            { storeProductId: 10, quantity: 1, price: 2.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore([RIMI_ALT, NORFA_ALT]);
        setSpLookup([{ id: 10, productId: 100 }]);
        // Rimi carries it at 1.60; Norfa has no entry
        setBatchPrices([
            { productId: 100, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 1.60, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi  = result.alternatives.find((a: any) => a.chainId === 2);
        const norfa = result.alternatives.find((a: any) => a.chainId === 3);

        expect(rimi.total).toBe(1.60);
        expect(rimi.knownItems).toBe(1);
        expect(norfa.imputedItems).toBe(1);
        // imputed = avg(current 2.00, rimi 1.60) = 1.80
        expect(norfa.total).toBe(1.80);
    });

    it('adds unrecognised items flat to every store basket', async () => {
        setReceipt([
            { storeProductId: null, quantity: 1, price: 5.00, promoPrice: null, matchConfirmed: false, unit: 'vnt' },
        ]);
        setStore();

        const result = await getReceiptComparison(1);

        expect(result.currentChain.total).toBe(5.00);
        expect(result.currentChain.flatItems).toBe(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        expect(rimi.total).toBe(5.00);
        expect(rimi.flatItems).toBe(1);
    });

    it('computes savings as current total minus alt total', async () => {
        setReceipt([
            { storeProductId: 10, quantity: 2, price: 2.00, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 100 }]);
        setBatchPrices([
            { productId: 100, isWeighable: 0, amount: 1, unit: 'vnt', storeId: 2, price: 1.50, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);

        expect(result.currentChain.total).toBe(4.00); // 2 × 2.00
        expect(rimi.total).toBe(3.00);                // 2 × 1.50
        expect(rimi.savings).toBe(1.00);              // 4.00 - 3.00
    });
});

// ---------------------------------------------------------------------------
// Guard conditions
// ---------------------------------------------------------------------------

describe('guard conditions', () => {
    it('throws 404 when receipt is not found', async () => {
        mockGetReceiptById.mockResolvedValue(null);
        await expect(getReceiptComparison(999)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 400 when receipt has no resolved storeId', async () => {
        mockGetReceiptById.mockResolvedValue({ id: 1, storeId: null, parsedData: { products: [] } });
        await expect(getReceiptComparison(1)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns empty comparison when no valid items exist', async () => {
        mockGetReceiptById.mockResolvedValue({
            id: 1, storeId: 1,
            parsedData: { products: [{ price: 0, quantity: 1, matchConfirmed: true }] },
        });
        // Should return early before hitting the DB or store lookups
        const result = await getReceiptComparison(1);
        expect(result.alternatives).toHaveLength(0);
        expect(result.currentChain.total).toBe(0);
    });
});

describe('item total calculation — unit-family guard (Šafranas 0.010 g blow-up)', () => {
    it('does not divide a count quantity into sub-gram weight packs', async () => {
        // Receipt "Airanas": 1 vnt @ €1.19. The alt store carries the (mis-
        // clustered) product only as a 0.010 g Šafranas pack. Before the guard
        // this priced ceil(1 / 0.010) = 100 packs × €2.29 = €229. Must be 1 pack.
        setReceipt([
            { storeProductId: 10, quantity: 1, price: 1.19, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([{ id: 10, productId: 5125 }]);
        setBatchPrices([
            { productId: 5125, isWeighable: 0, amount: 0.010, unit: 'g', storeId: 2, price: 2.29, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        expect(rimi.total).toBe(2.29); // 1 pack, not 100
    });

    it('still applies pack division within the same unit family (egg trays)', async () => {
        // 12 vnt requested, sold as 10-vnt trays → ceil(12 / 10) = 2 trays.
        setReceipt([
            { storeProductId: 11, quantity: 12, price: 0.20, promoPrice: null, matchConfirmed: true, unit: 'vnt' },
        ]);
        setStore();
        setSpLookup([{ id: 11, productId: 200 }]);
        setBatchPrices([
            { productId: 200, isWeighable: 0, amount: 10, unit: 'vnt', storeId: 2, price: 1.50, promoPrice: null },
        ]);

        const result = await getReceiptComparison(1);
        const rimi = result.alternatives.find((a: any) => a.chainId === 2);
        expect(rimi.total).toBe(3.00); // 2 × 1.50
    });
});
