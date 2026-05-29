import {
    qualifiesForAutoTemplate,
    selectDefaultTemplateProducts,
    computeItemDelta,
    MAX_ITEMS,
    type UserProductSignal,
    type ReceiptSummary,
} from '../src/services/defaultTemplateService.js';

function r(chainId: number | null): ReceiptSummary { return { chainId }; }
function s(productId: number, score: number, interactionCount: number): UserProductSignal {
    return { productId, score, interactionCount };
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
        // A receipt with no matched store/chain shouldn't contribute to
        // the diversity check — otherwise an unmatched receipt would
        // count as "another chain" and lower the bar artificially.
        expect(qualifiesForAutoTemplate([r(1), r(1), r(null)])).toBe(false);
        expect(qualifiesForAutoTemplate([r(1), r(2), r(null)])).toBe(true);
    });

    it('rejects empty list', () => {
        expect(qualifiesForAutoTemplate([])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// selectDefaultTemplateProducts
// ---------------------------------------------------------------------------

describe('selectDefaultTemplateProducts', () => {
    const noTopProducts = new Set<number>();

    it('excludes products with zero or negative score', () => {
        expect(selectDefaultTemplateProducts([
            s(1, 0, 5),
            s(2, -0.1, 3),
        ], noTopProducts)).toEqual([]);
    });

    it('includes products with interactionCount ≥ 2', () => {
        const out = selectDefaultTemplateProducts([
            s(1, 1.5, 2),
            s(2, 1.0, 3),
        ], noTopProducts);
        expect(out).toEqual([1, 2]);
    });

    it('excludes single-touch products that are not in the global top set', () => {
        const out = selectDefaultTemplateProducts([
            s(1, 1.5, 1),
        ], noTopProducts);
        expect(out).toEqual([]);
    });

    it('includes single-touch products when they ARE in the global top set (bulk-buyer carve-out)', () => {
        const topSet = new Set([42]);
        const out = selectDefaultTemplateProducts([
            s(42, 0.8, 1),  // single touch but universally bought (e.g. toilet paper)
            s(99, 0.8, 1),  // single touch and not popular → excluded
        ], topSet);
        expect(out).toEqual([42]);
    });

    it('sorts by score descending', () => {
        const out = selectDefaultTemplateProducts([
            s(1, 0.5, 5),
            s(2, 2.0, 3),
            s(3, 1.0, 4),
        ], noTopProducts);
        expect(out).toEqual([2, 3, 1]);
    });

    it('breaks score ties by interactionCount', () => {
        const out = selectDefaultTemplateProducts([
            s(1, 1.0, 2),
            s(2, 1.0, 5),
            s(3, 1.0, 3),
        ], noTopProducts);
        expect(out).toEqual([2, 3, 1]);
    });

    it('caps the result at MAX_ITEMS', () => {
        const many: UserProductSignal[] = Array.from({ length: 50 }, (_, i) =>
            s(i + 1, 100 - i, 2)
        );
        const out = selectDefaultTemplateProducts(many, noTopProducts);
        expect(out.length).toBe(MAX_ITEMS);
        // Should be the top-25 by score; with descending input, that's ids 1..25
        expect(out[0]).toBe(1);
        expect(out[MAX_ITEMS - 1]).toBe(MAX_ITEMS);
    });

    it('returns empty when input is empty', () => {
        expect(selectDefaultTemplateProducts([], noTopProducts)).toEqual([]);
    });

    it('mixes habitual + bulk-buyer products in one selection', () => {
        const topSet = new Set([7]);
        const out = selectDefaultTemplateProducts([
            s(1, 3.0, 5),    // habitual
            s(7, 0.5, 1),    // bulk-buyer carve-out
            s(8, 2.0, 1),    // single-touch, not in top → excluded
            s(2, 2.5, 3),    // habitual
        ], topSet);
        expect(out).toEqual([1, 2, 7]);
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
        // Removed: 1, 4. Added: 5, 6. Total: 4.
        expect(computeItemDelta([1, 2, 3, 4], [2, 3, 5, 6])).toBe(4);
    });

    it('handles empty inputs', () => {
        expect(computeItemDelta([], [])).toBe(0);
        expect(computeItemDelta([], [1, 2, 3])).toBe(3);
        expect(computeItemDelta([1, 2, 3], [])).toBe(3);
    });

    it('ignores duplicate ids in input arrays', () => {
        // Same productId twice in either side shouldn't inflate the delta —
        // template items are deduped at the Product level by spec.
        expect(computeItemDelta([1, 1, 2], [1, 2, 2])).toBe(0);
    });
});
