import { jest } from '@jest/globals';

const mockPoolQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query: mockPoolQuery } }));

let fetchLinkedSets: any;
beforeAll(async () => {
    fetchLinkedSets = (await import('../src/models/linkedProductModel.js')).fetchLinkedSets;
});
beforeEach(() => {
    jest.resetAllMocks();
    // Default: no merge graph and no personal edges (each product is its own root).
    mockPoolQuery.mockResolvedValue([[]]);
});

// Query order in fetchLinkedSets:
//   with userId:    (1) personal edges  (2) merge-root CTE  (3) merge members
//   without userId: (1) merge-root CTE  (2) merge members

describe('fetchLinkedSets', () => {
    it('skips the personal query entirely when there is no userId', async () => {
        // (1) merge CTE — product 100 is its own root; (2) members — just itself.
        mockPoolQuery.mockResolvedValueOnce([[{ seed: 100, node: 100, depth: 0 }]]);
        mockPoolQuery.mockResolvedValueOnce([[{ id: 100, mergedIntoId: null }]]);
        const { personal, merge } = await fetchLinkedSets([100], undefined);
        expect(mockPoolQuery).toHaveBeenCalledTimes(2); // no personal-edges query
        expect([...personal.get(100)]).toEqual([]);
        expect([...merge.get(100)]).toEqual([]);
    });

    it('personal: union-finds the viewer "same" component, excluding the item itself', async () => {
        // (1) personal edges: 100–200 and 200–300 → one component {100,200,300}.
        mockPoolQuery.mockResolvedValueOnce([[{ a: 100, b: 200 }, { a: 200, b: 300 }]]);
        // (2) merge CTE, (3) members — no merge graph.
        mockPoolQuery.mockResolvedValueOnce([[{ seed: 100, node: 100, depth: 0 }]]);
        mockPoolQuery.mockResolvedValueOnce([[{ id: 100, mergedIntoId: null }]]);
        const { personal } = await fetchLinkedSets([100], 'user-1');
        expect([...personal.get(100)].sort((a, b) => a - b)).toEqual([200, 300]);
    });

    it('merge: groups products sharing the effective mergedIntoId root', async () => {
        // (1) CTE: 100 is the root (depth 0). (2) members: 300 & 400 merged into 100.
        mockPoolQuery.mockResolvedValueOnce([[{ seed: 100, node: 100, depth: 0 }]]);
        mockPoolQuery.mockResolvedValueOnce([[
            { id: 100, mergedIntoId: null },
            { id: 300, mergedIntoId: 100 },
            { id: 400, mergedIntoId: 100 },
        ]]);
        const { merge } = await fetchLinkedSets([100], undefined);
        expect([...merge.get(100)].sort((a, b) => a - b)).toEqual([300, 400]);
    });

    it('merge: a loser seed resolves UP to its root and gets the siblings', async () => {
        // Seed 300 is a loser; the CTE walks 300 → 100 (depth 1 is deepest = root).
        mockPoolQuery.mockResolvedValueOnce([[
            { seed: 300, node: 300, depth: 0 },
            { seed: 300, node: 100, depth: 1 },
        ]]);
        mockPoolQuery.mockResolvedValueOnce([[
            { id: 100, mergedIntoId: null },
            { id: 300, mergedIntoId: 100 },
        ]]);
        const { merge } = await fetchLinkedSets([300], undefined);
        expect([...merge.get(300)]).toEqual([100]); // sibling root, self excluded
    });

    it('is best-effort: a merge-graph query error degrades to empty sets, no throw', async () => {
        mockPoolQuery.mockRejectedValueOnce(new Error('db down')); // the CTE fails
        const { merge } = await fetchLinkedSets([100], undefined);
        expect([...merge.get(100)]).toEqual([]);
    });
});
