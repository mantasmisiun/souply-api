import { jest } from '@jest/globals';
import {
    getReceiptRelatednessScope,
    isCardRelated,
    isCardRelatedByCategory,
    tokenJaccard,
    type RelatednessScope,
} from '../src/services/receiptRelatednessService.js';

// The parsedData read is `FROM Receipt`; the sibling expansion is `SELECT id FROM Category`.
const makeConn = (parsedData: any, siblings: number[] = []) => ({
    query: jest.fn(async (sql: string) =>
        /FROM Category/.test(sql)
            ? [siblings.map((id) => ({ id }))]
            : [[{ parsedData: JSON.stringify(parsedData) }]],
    ),
});

describe('tokenJaccard', () => {
    it('shares a noun → positive; disjoint → 0; diacritics folded', () => {
        expect(tokenJaccard('Kekiniai pomidorai', 'Lietuviški pomidorai')).toBeGreaterThan(0);
        expect(tokenJaccard('Bananai', 'Plaukų dažai')).toBe(0);
        expect(tokenJaccard('pienas', 'PIENAS')).toBe(1);
    });
});

describe('getReceiptRelatednessScope', () => {
    it('collects categories of matched lines, the line names, and the chain', async () => {
        const parsed = {
            header: { chainId: 3 },
            products: [
                { name: 'Lietuviški pomidorai', storeProductId: 60161, altMatches: [{ storeProductId: 60161, categoryId: 2 }] },
                { name: 'Pusriebis pienas', storeProductId: 55852, altMatches: [{ storeProductId: 55852, categoryId: 24 }] },
                { name: 'Unmatched line', storeProductId: null, altMatches: [] },
            ],
        };
        const scope = await getReceiptRelatednessScope(108, makeConn(parsed));
        expect(scope.categoryIds.has(2)).toBe(true);
        expect(scope.categoryIds.has(24)).toBe(true);
        expect(scope.chainIds.has(3)).toBe(true);
        expect(scope.lineNames).toContain('Lietuviški pomidorai');
        expect(scope.lineNames).toContain('Unmatched line'); // names collected even when unmatched
    });

    it('expands to SIBLING leaf categories under the same parent (curd ↔ curd)', async () => {
        const parsed = { products: [{ name: 'ŽEMAITIJOS varškė', storeProductId: 1, altMatches: [{ storeProductId: 1, categoryId: 63 }] }] };
        // the DB returns all leaves under category 63's parent: 63 (matched) + 64,65 (siblings).
        const scope = await getReceiptRelatednessScope(108, makeConn(parsed, [63, 64, 65]));
        expect(scope.categoryIds.has(63)).toBe(true); // the matched leaf
        expect(scope.categoryIds.has(64)).toBe(true); // a sibling curd leaf → now in scope
        expect(scope.categoryIds.has(65)).toBe(true);
    });
});

describe('isCardRelated', () => {
    const scope: RelatednessScope = {
        categoryIds: new Set([2, 24]),
        lineNames: ['Lietuviški pomidorai', 'Pusriebis pienas'],
        chainIds: new Set([3]),
    };

    it('related: same category as something bought (name NOT required)', () => {
        expect(isCardRelated({ categoryId: 2, name: 'Kekiniai pomidorai' }, scope)).toBe(true);
    });

    it('NOT related: wrong category (the hair-dye guard)', () => {
        expect(isCardRelated({ categoryId: 99, name: 'Plaukų dažai' }, scope)).toBe(false);
    });

    it('related: same category even with NO name overlap (a varškė dedup pair for a varškė buy)', () => {
        // "ŽEMAITIJOS varškė" vs "Rokiškio varškė" share only "varške" → Jaccard < floor, but
        // both are curd cheese: the category IS the relatedness, the name floor was too strict.
        expect(isCardRelated({ categoryId: 2, name: 'Bananai' }, scope)).toBe(true);
    });
});

describe('isCardRelated — uncategorised real products (Nepriskirta 688 + photo)', () => {
    const scope: RelatednessScope = {
        categoryIds: new Set([2, 24]),
        lineNames: ['Lietuviški pomidorai', 'Pusriebis pienas'],
        chainIds: new Set([3]),
    };

    it('admits a name-related UNCATEGORISED item that has a photo', () => {
        // 688, not in the receipt's categories, but name-related to "…pomidorai" AND has a photo.
        expect(isCardRelated({ categoryId: 688, name: 'Kekiniai pomidorai', imageUrl: 'p.jpg' }, scope)).toBe(true);
    });

    it('rejects an uncategorised item with NO photo (not a confirmed real product)', () => {
        expect(isCardRelated({ categoryId: 688, name: 'Kekiniai pomidorai', imageUrl: null }, scope)).toBe(false);
    });

    it('rejects an uncategorised item that is NOT name-related (688 still needs a name link)', () => {
        // 688 is never in scope's categories, so it relies on the name relation — and this has none.
        expect(isCardRelated({ categoryId: 688, name: 'Plaukų dažai', imageUrl: 'p.jpg' }, scope)).toBe(false);
    });

    it('isCardRelatedByCategory is the bare category check (no leak across categories)', () => {
        expect(isCardRelatedByCategory({ categoryId: 2 }, scope)).toBe(true);
        expect(isCardRelatedByCategory({ categoryId: 99 }, scope)).toBe(false);
    });
});
