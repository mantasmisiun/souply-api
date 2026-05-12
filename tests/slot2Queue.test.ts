import { buildSlot2Queue, type RawSlot2Row } from '../src/services/slot2QueueBuilder.js';

const defaultOrphan: RawSlot2Row['orphan'] = {
    productId: 1,
    name: 'Pienas',
    brandName: null,
    imageUrl: null,
    unit: 'g',
    chainId: 1,
    chainName: 'Rimi',
    chainLogoUrl: null,
    categoryId: 688,
    categoryName: 'Nepriskirta',
};

const defaultCandidate: RawSlot2Row['candidate'] = {
    productId: 2,
    name: 'Pienas 1L',
    brandName: null,
    imageUrl: null,
    unit: 'g',
    chainId: 2,
    chainName: 'IKI',
    chainLogoUrl: null,
    categoryId: 10,
    categoryName: 'Pieno produktai',
};

function makeRow(overrides: Partial<RawSlot2Row> & { orphan?: Partial<RawSlot2Row['orphan']>; candidate?: Partial<RawSlot2Row['candidate']> } = {}): RawSlot2Row {
    const { orphan: orphanOverrides, candidate: candidateOverrides, ...rest } = overrides;
    return {
        source: '2a',
        orphanSpId: 10,
        candidateSpId: 20,
        score: 0.85,
        sameChain: false,
        orphan: { ...defaultOrphan, ...orphanOverrides },
        candidate: { ...defaultCandidate, ...candidateOverrides },
        ...rest,
    };
}

describe('buildSlot2Queue', () => {
    it('returns empty array when rows is empty', () => {
        expect(buildSlot2Queue([], new Set())).toEqual([]);
    });

    it('returns empty array when all pairs are voted', () => {
        const row = makeRow({ orphanSpId: 3, candidateSpId: 7 });
        const result = buildSlot2Queue([row], new Set(['3-7']));
        expect(result).toEqual([]);
    });

    it('2a wins over 2b for same pair', () => {
        const rowA = makeRow({ source: '2a', orphanSpId: 10, candidateSpId: 20, score: 0.80 });
        const rowB = makeRow({ source: '2b', orphanSpId: 10, candidateSpId: 20, score: 0.90 });
        const result = buildSlot2Queue([rowB, rowA], new Set());
        expect(result).toHaveLength(1);
        expect(result[0].source).toBe('2a');
    });

    it('2b wins when only 2b is present', () => {
        const row = makeRow({ source: '2b', orphanSpId: 5, candidateSpId: 15 });
        const result = buildSlot2Queue([row], new Set());
        expect(result).toHaveLength(1);
        expect(result[0].source).toBe('2b');
    });

    it('deduplicates symmetric pairs (spA-spB same as spB-spA)', () => {
        const rowAB = makeRow({ source: '2a', orphanSpId: 10, candidateSpId: 20 });
        const rowBA = makeRow({ source: '2a', orphanSpId: 20, candidateSpId: 10 });
        const result = buildSlot2Queue([rowAB, rowBA], new Set());
        expect(result).toHaveLength(1);
    });

    it('filters voted pair by canonical key', () => {
        const row = makeRow({ orphanSpId: 3, candidateSpId: 7 });
        const result = buildSlot2Queue([row], new Set(['3-7']));
        expect(result).toHaveLength(0);
    });

    it('filters voted pair regardless of key orientation', () => {
        const row = makeRow({ orphanSpId: 7, candidateSpId: 3 });
        const result = buildSlot2Queue([row], new Set(['3-7']));
        expect(result).toHaveLength(0);
    });

    it('sets conflictDetected=true for g vs ml', () => {
        const row = makeRow({ orphan: { unit: 'g' }, candidate: { unit: 'ml' } });
        const result = buildSlot2Queue([row], new Set());
        expect(result[0].conflictDetected).toBe(true);
    });

    it('sets conflictDetected=false for g vs kg', () => {
        const row = makeRow({ orphan: { unit: 'g' }, candidate: { unit: 'kg' } });
        const result = buildSlot2Queue([row], new Set());
        expect(result[0].conflictDetected).toBe(false);
    });

    it('sets conflictDetected=false when orphan.unit is null', () => {
        const row = makeRow({ orphan: { unit: null }, candidate: { unit: 'g' } });
        const result = buildSlot2Queue([row], new Set());
        expect(result[0].conflictDetected).toBe(false);
    });

    it('sorts descending by score', () => {
        const rows = [
            makeRow({ orphanSpId: 1, candidateSpId: 2, score: 0.70 }),
            makeRow({ orphanSpId: 3, candidateSpId: 4, score: 0.90 }),
            makeRow({ orphanSpId: 5, candidateSpId: 6, score: 0.80 }),
        ];
        const result = buildSlot2Queue(rows, new Set());
        expect(result.map(r => r.score)).toEqual([0.90, 0.80, 0.70]);
    });
});
