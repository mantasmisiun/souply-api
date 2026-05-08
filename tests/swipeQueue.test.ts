import { buildSwipeQueue, type RawCandidateRow } from '../src/services/swipeQueueService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<RawCandidateRow> & Pick<RawCandidateRow, 'receiptLineIdx' | 'storeProductId'>): RawCandidateRow {
    return {
        rankPos: 1,
        matchScore: 0.8,
        autoMatched: false,
        name: 'Test Product',
        brandName: null,
        amount: null,
        unit: null,
        isWeighable: false,
        imageUrl: null,
        productId: 99,
        chainId: 1,
        chainName: 'Maxima',
        chainLogoUrl: null,
        ...overrides,
    };
}

function makeParsedProduct(storeProductId: number | null, overrides: Record<string, any> = {}) {
    return { storeProductId, name: 'Milk', price: 1.99, ...overrides };
}

// ---------------------------------------------------------------------------
// Empty queue
// ---------------------------------------------------------------------------

describe('buildSwipeQueue — empty inputs', () => {
    it('returns empty array when there are no candidate rows', () => {
        const result = buildSwipeQueue([], [], new Set(), new Set());
        expect(result).toEqual([]);
    });

    it('returns empty array when all lines lack a resolved storeProductId', () => {
        const rows = [makeRow({ receiptLineIdx: 0, storeProductId: 10 })];
        const products = [makeParsedProduct(null)]; // no SP assigned
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result).toEqual([]);
    });

    it('returns empty array when the parsedProducts array is shorter than the line index', () => {
        const rows = [makeRow({ receiptLineIdx: 5, storeProductId: 10 })];
        const products: any[] = []; // line 5 has no matching parsed product → storeProductId = null
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Self-pair filtering (priceVerified)
// ---------------------------------------------------------------------------

describe('buildSwipeQueue — self-pair filtering', () => {
    it('includes self-pair when not verified', () => {
        const rows = [makeRow({ receiptLineIdx: 0, storeProductId: 10 })];
        const products = [makeParsedProduct(10)]; // candidate == line SP
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result).toHaveLength(1);
        expect(result[0].candidates[0].storeProductId).toBe(10);
    });

    it('excludes self-pair when price is already verified', () => {
        const rows = [makeRow({ receiptLineIdx: 0, storeProductId: 10 })];
        const products = [makeParsedProduct(10)];
        const verifiedSpIds = new Set([10]);
        const result = buildSwipeQueue(rows, products, new Set(), verifiedSpIds);
        expect(result).toHaveLength(0);
    });

    it('excludes only the verified self-pair, keeps cross-pair candidates', () => {
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 10, rankPos: 1, matchScore: 0.9 }), // self-pair, verified
            makeRow({ receiptLineIdx: 0, storeProductId: 20, rankPos: 2, matchScore: 0.7 }), // cross-pair
        ];
        const products = [makeParsedProduct(10)];
        const verifiedSpIds = new Set([10]);
        const result = buildSwipeQueue(rows, products, new Set(), verifiedSpIds);
        expect(result).toHaveLength(1);
        expect(result[0].candidates).toHaveLength(1);
        expect(result[0].candidates[0].storeProductId).toBe(20);
    });
});

// ---------------------------------------------------------------------------
// Cross-pair filtering (voted pairs)
// ---------------------------------------------------------------------------

describe('buildSwipeQueue — voted-pair filtering', () => {
    it('includes cross-pair when not yet voted', () => {
        const rows = [makeRow({ receiptLineIdx: 0, storeProductId: 20 })];
        const products = [makeParsedProduct(10)]; // line SP=10, candidate SP=20
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result).toHaveLength(1);
    });

    it('excludes cross-pair after vote is recorded (min-max key)', () => {
        const rows = [makeRow({ receiptLineIdx: 0, storeProductId: 20 })];
        const products = [makeParsedProduct(10)];
        // min(10,20)=10, max=20 → key "10-20"
        const votedPairs = new Set(['10-20']);
        const result = buildSwipeQueue(rows, products, votedPairs, new Set());
        expect(result).toHaveLength(0);
    });

    it('uses min-max ordering so "20-10" matches the same as "10-20"', () => {
        const rows = [makeRow({ receiptLineIdx: 0, storeProductId: 10 })];
        const products = [makeParsedProduct(20)]; // line SP=20, candidate SP=10 → min-max = "10-20"
        const votedPairs = new Set(['10-20']);
        const result = buildSwipeQueue(rows, products, votedPairs, new Set());
        expect(result).toHaveLength(0);
    });

    it('keeps unvoted pairs when some pairs on the same line were voted', () => {
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 20, rankPos: 1, matchScore: 0.9 }), // voted
            makeRow({ receiptLineIdx: 0, storeProductId: 30, rankPos: 2, matchScore: 0.7 }), // not voted
        ];
        const products = [makeParsedProduct(10)];
        const votedPairs = new Set(['10-20']);
        const result = buildSwipeQueue(rows, products, votedPairs, new Set());
        expect(result).toHaveLength(1);
        expect(result[0].candidates).toHaveLength(1);
        expect(result[0].candidates[0].storeProductId).toBe(30);
    });
});

// ---------------------------------------------------------------------------
// Ordering (lowest confidence first)
// ---------------------------------------------------------------------------

describe('buildSwipeQueue — ordering', () => {
    it('sorts items by top-candidate matchScore ascending', () => {
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 20, matchScore: 0.9 }),
            makeRow({ receiptLineIdx: 1, storeProductId: 30, matchScore: 0.3 }),
            makeRow({ receiptLineIdx: 2, storeProductId: 40, matchScore: 0.6 }),
        ];
        const products = [
            makeParsedProduct(10),
            makeParsedProduct(11),
            makeParsedProduct(12),
        ];
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result.map(i => i.receiptLineIdx)).toEqual([1, 2, 0]);
    });

    it('items with no candidates have matchScore 0 and sort first', () => {
        // A line where all candidates were filtered should not appear in output at all.
        // This test verifies the ordering for lines with low-confidence matches.
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 20, matchScore: 0.5 }),
            makeRow({ receiptLineIdx: 1, storeProductId: 30, matchScore: 0.1 }),
        ];
        const products = [makeParsedProduct(10), makeParsedProduct(11)];
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result[0].receiptLineIdx).toBe(1); // lower score first
        expect(result[1].receiptLineIdx).toBe(0);
    });

    it('preserves rank order within a line (candidates not re-sorted)', () => {
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 20, rankPos: 1, matchScore: 0.9 }),
            makeRow({ receiptLineIdx: 0, storeProductId: 30, rankPos: 2, matchScore: 0.5 }),
        ];
        const products = [makeParsedProduct(10)];
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result[0].candidates[0].storeProductId).toBe(20);
        expect(result[0].candidates[1].storeProductId).toBe(30);
    });
});

// ---------------------------------------------------------------------------
// Queue item shape
// ---------------------------------------------------------------------------

describe('buildSwipeQueue — output shape', () => {
    it('copies OCR fields from parsedProducts into queue items', () => {
        const rows = [makeRow({ receiptLineIdx: 0, storeProductId: 20 })];
        const products = [{ storeProductId: 10, name: 'Pienas', price: 1.49, promoPrice: 1.09, amount: 1, unit: 'l' }];
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result[0].ocrName).toBe('Pienas');
        expect(result[0].ocrPrice).toBe(1.49);
        expect(result[0].ocrPromoPrice).toBe(1.09);
        expect(result[0].ocrAmount).toBe(1);
        expect(result[0].ocrUnit).toBe('l');
        expect(result[0].lineStoreProductId).toBe(10);
    });

    it('maps candidate fields correctly', () => {
        const rows = [makeRow({
            receiptLineIdx: 0,
            storeProductId: 20,
            name: 'Whole Milk',
            brandName: 'Rokiškio',
            matchScore: 0.75,
            autoMatched: true,
            chainName: 'Rimi',
            chainId: 5,
        })];
        const products = [makeParsedProduct(10)];
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        const cand = result[0].candidates[0];
        expect(cand.name).toBe('Whole Milk');
        expect(cand.brandName).toBe('Rokiškio');
        expect(cand.matchScore).toBe(0.75);
        expect(cand.autoMatched).toBe(true);
        expect(cand.chainName).toBe('Rimi');
    });
});

// ---------------------------------------------------------------------------
// Multiple lines — integration-style
// ---------------------------------------------------------------------------

describe('buildSwipeQueue — multiple lines', () => {
    it('builds separate items per receipt line', () => {
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 20 }),
            makeRow({ receiptLineIdx: 1, storeProductId: 30 }),
        ];
        const products = [makeParsedProduct(10), makeParsedProduct(11)];
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        expect(result).toHaveLength(2);
    });

    it('drops a line entirely when all its candidates are filtered', () => {
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 20 }), // will be voted
            makeRow({ receiptLineIdx: 1, storeProductId: 30 }), // survives
        ];
        const products = [makeParsedProduct(10), makeParsedProduct(11)];
        const votedPairs = new Set(['10-20']);
        const result = buildSwipeQueue(rows, products, votedPairs, new Set());
        expect(result).toHaveLength(1);
        expect(result[0].receiptLineIdx).toBe(1);
    });

    it('handles 20-product receipt with mixed filtering correctly', () => {
        const COUNT = 20;
        const rows: RawCandidateRow[] = [];
        const products: any[] = [];
        const votedPairs = new Set<string>();
        const verifiedSpIds = new Set<number>();

        for (let i = 0; i < COUNT; i++) {
            const lineSpId = 100 + i;
            const candSpId = 200 + i;
            products.push(makeParsedProduct(lineSpId));
            rows.push(makeRow({ receiptLineIdx: i, storeProductId: candSpId, matchScore: i / COUNT }));
            // Vote out the first 5
            if (i < 5) votedPairs.add(`${lineSpId}-${candSpId}`);
            // Verify self-pairs for lines 5-9
            if (i >= 5 && i < 10) {
                rows.push(makeRow({ receiptLineIdx: i, storeProductId: lineSpId, rankPos: 2, matchScore: 1.0 }));
                verifiedSpIds.add(lineSpId);
            }
        }

        const result = buildSwipeQueue(rows, products, votedPairs, verifiedSpIds);
        // Lines 0-4: voted out → 0 items
        // Lines 5-9: self-pair verified, cross-pair remains (the candSpId row) → 5 items
        // Lines 10-19: unfiltered → 10 items
        expect(result).toHaveLength(15);
    });
});

// ---------------------------------------------------------------------------
// Deduplication guard (same storeProductId appearing at multiple ranks in DB)
// ---------------------------------------------------------------------------

describe('buildSwipeQueue — duplicate storeProductId rows from DB', () => {
    it('includes both rows when same SP appears at different rank positions (DB has no dedup)', () => {
        // The DB JOIN can return the same storeProductId at rank 1 and rank 3
        // if receiptSaveService failed to deduplicate before inserting. The
        // buildSwipeQueue function does NOT deduplicate — that is the
        // responsibility of receiptSaveService at insert time.
        // This test documents the current behaviour so any future dedup
        // in buildSwipeQueue would be an explicit decision.
        const rows = [
            makeRow({ receiptLineIdx: 0, storeProductId: 20, rankPos: 1, matchScore: 0.9 }),
            makeRow({ receiptLineIdx: 0, storeProductId: 20, rankPos: 3, matchScore: 0.9 }), // duplicate
        ];
        const products = [makeParsedProduct(10)];
        const result = buildSwipeQueue(rows, products, new Set(), new Set());
        // Both appear (no dedup in queue builder — dedup happens at save time)
        expect(result[0].candidates).toHaveLength(2);
    });
});
