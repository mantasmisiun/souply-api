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

    // Slot 3's design intentionally has no minimum-score floor — see the
    // comment in slot3CandidateModel.ts ("Keep only the single best match
    // per anchor — no score floor"). The goal is "always anchor a card to
    // the receipt" even when no pair scores above the older 0.75 threshold,
    // so a low-confidence card beats zero cards.
    it('includes pair regardless of score — no floor in v2', () => {
        expect(buildSlot3Queue([makeRow({ score: 0.10 })], new Set())).toHaveLength(1);
        expect(buildSlot3Queue([makeRow({ score: 0.749 })], new Set())).toHaveLength(1);
        expect(buildSlot3Queue([makeRow({ score: 0.75 })], new Set())).toHaveLength(1);
        expect(buildSlot3Queue([makeRow({ score: 0.99 })], new Set())).toHaveLength(1);
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
        // makeRow's defaults assign left.productId=1 / right.productId=2 on
        // every row — buildSlot3Queue dedupes by canonical product-pair, so
        // multiple rows sharing the same product pair would collapse to one
        // card. Give each row a distinct product pair so all three survive
        // dedup and the test exercises the actual sort.
        const distinctPair = (leftPid: number, rightPid: number): RawSlot3Row['left'] => ({
            ...defaultSide,
            productId: leftPid,
        });
        const rowFor = (n: number, score: number): RawSlot3Row => ({
            spIdA: n * 10,
            spIdB: n * 10 + 1,
            score,
            left: distinctPair(n * 100, n * 100 + 1),
            right: { ...defaultSide, productId: n * 100 + 1, name: `R${n}`, chainId: 2, chainName: 'IKI' },
        });
        const rows = [rowFor(1, 0.75), rowFor(2, 0.92), rowFor(3, 0.81)];
        const result = buildSlot3Queue(rows, new Set());
        expect(result.map(r => r.score)).toEqual([0.92, 0.81, 0.75]);
    });

    it('cardId is always min-max ordered', () => {
        const row = makeRow({ spIdA: 9, spIdB: 2 });
        const result = buildSlot3Queue([row], new Set());
        expect(result[0].cardId).toBe('2-9');
    });
});
