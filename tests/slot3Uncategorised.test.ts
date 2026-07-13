import { jest } from '@jest/globals';

// Mock the DB pool so we can feed canned anchor/candidate rows and exercise the JS pairing.
const mockQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query: mockQuery } }));
// swipeLogger writes to a file on import — stub it.
jest.unstable_mockModule('../src/utils/swipeLogger.js', () => ({
    swipeLog: () => {}, resetSwipeLog: () => {},
}));

const { fetchSlot3UncategorisedRows, _clearSlot3UncatCache } = await import('../src/models/slot3CandidateModel.js');

// The pass caches per (chainIds, locale) — clear between tests so canned rows don't leak.
beforeEach(() => _clearSlot3UncatCache());

const anchor = (spId: number, productId: number, name: string) =>
    ({ spId, chainId: 3, productId, productName: name, displayName: name, brandName: null, imageUrl: 'photo.jpg' });
const cand = (spId: number, productId: number, name: string, categoryId: number) =>
    ({ spId, chainId: 3, productId, productName: name, displayName: name, brandName: null, imageUrl: 'c.jpg',
       categoryId, chainName: 'IKI', chainLogoUrl: null, categoryName: 'Duona' });

// The anchor query carries `p.categoryId = 688`; the candidate query carries `p.categoryId != 688`.
function setup(anchors: any[], cands: any[]) {
    mockQuery.mockImplementation(async (sql: string) => (/categoryId = 688/.test(sql) ? [anchors] : [cands]));
}

describe('fetchSlot3UncategorisedRows', () => {
    beforeEach(() => mockQuery.mockReset());

    it('pairs a 688-with-photo anchor with the best name-similar categorised candidate (≥0.75)', async () => {
        setup(
            [anchor(100, 1, 'Šviesi raikyta duona')],
            [cand(200, 2, 'Šviesi raikyta duona', 50), cand(201, 3, 'Bananai Cavendish', 99)],
        );
        const rows = await fetchSlot3UncategorisedRows([3]);
        expect(rows).toHaveLength(1);
        // one side stays uncategorised (688), the other is the categorised bread (cat 50)
        const cats = [rows[0].left.categoryId, rows[0].right.categoryId].sort((a, b) => a - b);
        expect(cats).toEqual([50, 688]);
        expect(rows[0].score).toBeGreaterThanOrEqual(0.75);
        // the 688 side keeps its photo (it's a real scraped product)
        const side688 = rows[0].left.categoryId === 688 ? rows[0].left : rows[0].right;
        expect(side688.imageUrl).toBeTruthy();
    });

    it('drops a pair whose best candidate scores < 0.75', async () => {
        setup([anchor(100, 1, 'Šviesi raikyta duona')], [cand(200, 2, 'Bananai Cavendish', 50)]);
        expect(await fetchSlot3UncategorisedRows([3])).toEqual([]);
    });

    it('returns empty when there are no 688-with-photo anchors', async () => {
        setup([], [cand(200, 2, 'Šviesi raikyta duona', 50)]);
        expect(await fetchSlot3UncategorisedRows([3])).toEqual([]);
    });

    it('returns empty (and runs no query) for empty chainIds', async () => {
        expect(await fetchSlot3UncategorisedRows([])).toEqual([]);
        expect(mockQuery).not.toHaveBeenCalled();
    });
});
