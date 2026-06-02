import {
    qualifiesForAutoTemplate,
    computeItemDelta,
    decayWeight,
    median,
    roundQuantity,
    rankDefaultTemplateItems,
    MAX_ITEMS,
    MIN_ITEMS,
    DECAY_HALF_LIFE_DAYS,
    type ReceiptSummary,
    type PurchaseSignal,
} from '../src/services/defaultTemplateService.js';

function r(chainId: number | null): ReceiptSummary { return { chainId }; }

function sig(p: Partial<PurchaseSignal> & { productId: number }): PurchaseSignal {
    return {
        decayedScore: 1,
        freq: 2,
        quantity: 1,
        chainCount: 1,
        available: true,
        ...p,
    };
}

// ---------------------------------------------------------------------------
// qualifiesForAutoTemplate
// ---------------------------------------------------------------------------

describe('qualifiesForAutoTemplate', () => {
    it('rejects when fewer than 3 receipts', () => {
        expect(qualifiesForAutoTemplate([r(1), r(2)])).toBe(false);
    });

    it('rejects 3+ receipts that are all from the same chain', () => {
        expect(qualifiesForAutoTemplate([r(1), r(1), r(1), r(1)])).toBe(false);
    });

    it('accepts 3 receipts across 2 chains', () => {
        expect(qualifiesForAutoTemplate([r(1), r(2), r(1)])).toBe(true);
    });

    it('accepts 3 receipts across 3 chains', () => {
        expect(qualifiesForAutoTemplate([r(1), r(2), r(3)])).toBe(true);
    });

    it('ignores null chainIds when counting distinct chains', () => {
        expect(qualifiesForAutoTemplate([r(1), r(1), r(null)])).toBe(false);
        expect(qualifiesForAutoTemplate([r(1), r(2), r(null)])).toBe(true);
    });

    it('rejects empty list', () => {
        expect(qualifiesForAutoTemplate([])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// decayWeight
// ---------------------------------------------------------------------------

describe('decayWeight', () => {
    it('gives full weight to a same-day purchase', () => {
        expect(decayWeight(0)).toBe(1);
    });

    it('halves at one half-life', () => {
        expect(decayWeight(DECAY_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 6);
    });

    it('quarters at two half-lives', () => {
        expect(decayWeight(DECAY_HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 6);
    });

    it('decreases monotonically with age', () => {
        expect(decayWeight(10)).toBeGreaterThan(decayWeight(20));
        expect(decayWeight(20)).toBeGreaterThan(decayWeight(200));
    });

    it('treats negative / non-finite ages as full weight', () => {
        expect(decayWeight(-5)).toBe(1);
        expect(decayWeight(NaN)).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

describe('median', () => {
    it('returns 0 for empty', () => {
        expect(median([])).toBe(0);
    });

    it('returns the middle of an odd-length list', () => {
        expect(median([3, 1, 2])).toBe(2);
    });

    it('averages the two middles of an even-length list', () => {
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    it('ignores non-finite values', () => {
        expect(median([2, NaN, 4])).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// roundQuantity
// ---------------------------------------------------------------------------

describe('roundQuantity', () => {
    it('rounds piece items to whole units', () => {
        expect(roundQuantity(1.4, false)).toBe(1);
        expect(roundQuantity(2.6, false)).toBe(3);
    });

    it('rounds weighable items to 0.1', () => {
        expect(roundQuantity(0.452, true)).toBe(0.5);
        expect(roundQuantity(1.23, true)).toBe(1.2);
    });

    it('never returns below 1 for pieces or 0.1 for weighable', () => {
        expect(roundQuantity(0, false)).toBe(1);
        expect(roundQuantity(0.01, true)).toBe(0.1);
    });

    it('clamps absurd amounts (garbled OCR)', () => {
        expect(roundQuantity(999, false)).toBe(50);
        expect(roundQuantity(999, true)).toBe(20);
    });
});

// ---------------------------------------------------------------------------
// rankDefaultTemplateItems
// ---------------------------------------------------------------------------

describe('rankDefaultTemplateItems', () => {
    it('orders by recency-weighted score, not raw frequency', () => {
        // The headline scenario: an old high-frequency product loses to a
        // recent low-frequency one once decay is applied upstream.
        const out = rankDefaultTemplateItems([
            sig({ productId: 1, decayedScore: 0.08, freq: 8 }), // old Rimi staple
            sig({ productId: 2, decayedScore: 1.85, freq: 2 }), // last-week Norfa staple
        ]);
        expect(out.map(o => o.productId)).toEqual([2, 1]);
    });

    it('drops unavailable and zero-score products', () => {
        const out = rankDefaultTemplateItems([
            sig({ productId: 1, decayedScore: 2, available: false }),
            sig({ productId: 2, decayedScore: 0 }),
            sig({ productId: 3, decayedScore: 1 }),
        ]);
        expect(out.map(o => o.productId)).toEqual([3]);
    });

    it('breaks score ties by chain count (comparability), then frequency', () => {
        const out = rankDefaultTemplateItems([
            sig({ productId: 1, decayedScore: 1, chainCount: 1, freq: 5 }),
            sig({ productId: 2, decayedScore: 1, chainCount: 3, freq: 2 }),
        ]);
        expect(out.map(o => o.productId)).toEqual([2, 1]);
    });

    it('holds back one-off buys until MIN_ITEMS is needed', () => {
        // Two habitual + several one-offs. With MIN_ITEMS=3 we keep the two
        // habituals plus one backfill; the rest of the one-offs are dropped.
        const out = rankDefaultTemplateItems(
            [
                sig({ productId: 1, decayedScore: 3, freq: 4 }),
                sig({ productId: 2, decayedScore: 2, freq: 3 }),
                sig({ productId: 3, decayedScore: 1.9, freq: 1 }),
                sig({ productId: 4, decayedScore: 1.8, freq: 1 }),
            ],
            { minItems: 3 },
        );
        expect(out.map(o => o.productId)).toEqual([1, 2, 3]);
    });

    it('keeps only habituals when there are already enough of them', () => {
        const out = rankDefaultTemplateItems(
            [
                sig({ productId: 1, decayedScore: 3, freq: 4 }),
                sig({ productId: 2, decayedScore: 2, freq: 3 }),
                sig({ productId: 3, decayedScore: 5, freq: 1 }), // one-off, high score
            ],
            { minItems: 2 },
        );
        expect(out.map(o => o.productId)).toEqual([1, 2]);
    });

    it('carries the per-item quantity through', () => {
        const out = rankDefaultTemplateItems([
            sig({ productId: 1, decayedScore: 2, quantity: 0.5 }),
            sig({ productId: 2, decayedScore: 1, quantity: 3 }),
        ]);
        expect(out).toEqual([
            { productId: 1, quantity: 0.5 },
            { productId: 2, quantity: 3 },
        ]);
    });

    it('caps the result at MAX_ITEMS', () => {
        const many: PurchaseSignal[] = Array.from({ length: 50 }, (_, i) =>
            sig({ productId: i + 1, decayedScore: 100 - i, freq: 3 }),
        );
        const out = rankDefaultTemplateItems(many);
        expect(out.length).toBe(MAX_ITEMS);
        expect(out[0].productId).toBe(1);
        expect(out[MAX_ITEMS - 1].productId).toBe(MAX_ITEMS);
    });

    it('returns empty for empty input', () => {
        expect(rankDefaultTemplateItems([])).toEqual([]);
    });

    it('defaults MIN_ITEMS sanely (constant exported)', () => {
        expect(MIN_ITEMS).toBeGreaterThan(0);
        expect(MIN_ITEMS).toBeLessThanOrEqual(MAX_ITEMS);
    });
});

// ---------------------------------------------------------------------------
// computeItemDelta
// ---------------------------------------------------------------------------

describe('computeItemDelta', () => {
    it('returns 0 for identical sets', () => {
        expect(computeItemDelta([1, 2, 3], [3, 2, 1])).toBe(0);
    });

    it('counts pure additions', () => {
        expect(computeItemDelta([1, 2], [1, 2, 3, 4])).toBe(2);
    });

    it('counts pure removals', () => {
        expect(computeItemDelta([1, 2, 3, 4], [1, 2])).toBe(2);
    });

    it('counts adds + removes together', () => {
        expect(computeItemDelta([1, 2, 3, 4], [2, 3, 5, 6])).toBe(4);
    });

    it('handles empty inputs', () => {
        expect(computeItemDelta([], [])).toBe(0);
        expect(computeItemDelta([], [1, 2, 3])).toBe(3);
        expect(computeItemDelta([1, 2, 3], [])).toBe(3);
    });

    it('ignores duplicate ids in input arrays', () => {
        expect(computeItemDelta([1, 1, 2], [1, 2, 2])).toBe(0);
    });
});
