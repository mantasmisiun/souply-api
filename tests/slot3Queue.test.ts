import { buildSlot3Queue, type RawSlot3Row } from '../src/services/slot3QueueBuilder.js';

const defaultSide: RawSlot3Row['left'] = {
    productId: 1,
    name: 'Pienas',
    brandName: null,
    imageUrl: null,
    chainId: 1,
    chainName: 'Rimi',
    chainLogoUrl: null,
    categoryId: 10,
    categoryName: 'Pieno produktai',
};

function makeRow(overrides: Partial<RawSlot3Row> = {}): RawSlot3Row {
    return {
        spIdA: 10,
        spIdB: 20,
        score: 0.85,
        left: { ...defaultSide },
        right: { ...defaultSide, productId: 2, name: 'Pienas 1L', chainId: 2, chainName: 'IKI' },
        ...overrides,
    };
}

describe('buildSlot3Queue', () => {
    it('returns empty when rows is empty', () => {
        expect(buildSlot3Queue([], new Set())).toEqual([]);
    });

    it('excludes pair with score 0.749', () => {
        const row = makeRow({ score: 0.749 });
        expect(buildSlot3Queue([row], new Set())).toHaveLength(0);
    });

    it('includes pair with score exactly 0.75', () => {
        const row = makeRow({ score: 0.75 });
        expect(buildSlot3Queue([row], new Set())).toHaveLength(1);
    });

    it('includes pair with score above 0.75', () => {
        const row = makeRow({ score: 0.90 });
        expect(buildSlot3Queue([row], new Set())).toHaveLength(1);
    });

    it('deduplicates symmetric pair (A-B same as B-A)', () => {
        const rowAB = makeRow({ spIdA: 10, spIdB: 20 });
        const rowBA = makeRow({ spIdA: 20, spIdB: 10 });
        const result = buildSlot3Queue([rowAB, rowBA], new Set());
        expect(result).toHaveLength(1);
    });

    it('excludes already-voted pair by canonical key', () => {
        const row = makeRow({ spIdA: 10, spIdB: 20 });
        expect(buildSlot3Queue([row], new Set(['10-20']))).toHaveLength(0);
    });

    it('excludes voted pair regardless of key orientation', () => {
        const row = makeRow({ spIdA: 7, spIdB: 3 });
        expect(buildSlot3Queue([row], new Set(['3-7']))).toHaveLength(0);
    });

    it('sorts descending by score', () => {
        const rows = [
            makeRow({ spIdA: 1, spIdB: 2, score: 0.75 }),
            makeRow({ spIdA: 3, spIdB: 4, score: 0.92 }),
            makeRow({ spIdA: 5, spIdB: 6, score: 0.81 }),
        ];
        const result = buildSlot3Queue(rows, new Set());
        expect(result.map(r => r.score)).toEqual([0.92, 0.81, 0.75]);
    });

    it('cardId is always min-max ordered', () => {
        const row = makeRow({ spIdA: 9, spIdB: 2 });
        const result = buildSlot3Queue([row], new Set());
        expect(result[0].cardId).toBe('2-9');
    });
});
