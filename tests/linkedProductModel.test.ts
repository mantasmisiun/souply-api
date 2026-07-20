import { jest } from '@jest/globals';

const mockPoolQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query: mockPoolQuery } }));

const mockGetPersonalComponent = jest.fn<any>();
jest.unstable_mockModule('../src/models/userEquivalenceModel.js', () => ({
    getPersonalComponentForProduct: mockGetPersonalComponent,
}));

const mockResolveEffective = jest.fn<any>();
jest.unstable_mockModule('../src/services/storeProductMergeService.js', () => ({
    resolveEffectiveProductId: mockResolveEffective,
}));

let fetchLinkedSets: any;
beforeAll(async () => {
    fetchLinkedSets = (await import('../src/models/linkedProductModel.js')).fetchLinkedSets;
});
beforeEach(() => {
    jest.resetAllMocks();
    // Default: no merge graph (each product is its own root, no siblings).
    mockResolveEffective.mockImplementation((pid: number) => Promise.resolve(pid));
    mockPoolQuery.mockResolvedValue([[]]);
});

describe('fetchLinkedSets', () => {
    it('returns empty sets for every product id and skips personal without a userId', async () => {
        mockPoolQuery.mockResolvedValueOnce([[{ id: 100, mergedIntoId: null }]]);
        const { personal, merge } = await fetchLinkedSets([100], undefined);
        expect(mockGetPersonalComponent).not.toHaveBeenCalled();
        expect([...personal.get(100)]).toEqual([]);
        expect([...merge.get(100)]).toEqual([]);
    });

    it('personal: collects the viewer "same" component, excluding the item itself', async () => {
        // getPersonalComponentForProduct includes the product itself + linked ids.
        mockGetPersonalComponent.mockResolvedValue([100, 200, 300]);
        const { personal } = await fetchLinkedSets([100], 'user-1');
        expect(mockGetPersonalComponent).toHaveBeenCalledWith('user-1', 100);
        expect([...personal.get(100)].sort()).toEqual([200, 300]);
    });

    it('merge: groups products sharing the effective mergedIntoId root', async () => {
        // 100 is the root; 300 & 400 are merged into it.
        mockResolveEffective.mockResolvedValue(100);
        mockPoolQuery.mockResolvedValueOnce([[
            { id: 100, mergedIntoId: null },
            { id: 300, mergedIntoId: 100 },
            { id: 400, mergedIntoId: 100 },
        ]]);
        const { merge } = await fetchLinkedSets([100], undefined);
        expect([...merge.get(100)].sort()).toEqual([300, 400]);
    });

    it('is best-effort: a merge-graph query error degrades to empty sets, no throw', async () => {
        mockResolveEffective.mockResolvedValue(100);
        mockPoolQuery.mockRejectedValueOnce(new Error('db down'));
        const { merge } = await fetchLinkedSets([100], undefined);
        expect([...merge.get(100)]).toEqual([]);
    });
});
