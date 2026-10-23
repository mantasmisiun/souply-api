import { jest } from '@jest/globals';

/**
 * Slot-2a "reject → next candidate": a 'different' vote on an orphan's rank-1 OSC pair
 * must NOT hide the orphan forever — it should advance to the orphan's next-ranked
 * candidate. fetchAllSlot2Rows fetches ranks 1..K and, per orphan, serves the lowest
 * unvoted rank. We mock the DB pool and route by SQL: the OSC query returns the seeded
 * ranked rows; every other query (the slot-2b anchor pass) returns empty so 2b is a
 * no-op and only 2a's behaviour is under test.
 */

const mockQuery = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query: mockQuery } }));

const { fetchAllSlot2Rows } = await import('../src/models/slot2CandidateModel.js');

// One orphan (SP 100) with two ranked OSC candidates: rank-1 → SP 200, rank-2 → SP 201.
const mkRow = (orphanSpId: number, candidateSpId: number, rankPos: number, score: number) => ({
    orphanSpId, candidateSpId, score, rankPos, sameChain: 0,
    orphanProductId: orphanSpId * 10, orphanName: `O${orphanSpId}`, orphanBrandName: null,
    orphanImageUrl: null, orphanUnit: null, orphanChainId: 1, orphanChainName: 'IKI',
    orphanChainLogoUrl: null, orphanCategoryId: 688, orphanCategoryName: 'Nepriskirta',
    candidateProductId: candidateSpId * 10, candidateName: `C${candidateSpId}`, candidateBrandName: null,
    candidateImageUrl: null, candidateUnit: null, candidateChainId: 2, candidateChainName: 'Rimi',
    candidateChainLogoUrl: null, candidateCategoryId: 10, candidateCategoryName: 'X',
});

// rows are grouped by orphan (osp.id) and ordered by rankPos ASC — mirror what the ORDER BY produces.
const RANKED_ROWS = [
    mkRow(100, 200, 1, 0.90),
    mkRow(100, 201, 2, 0.80),
];

function routeQuery(rows: any[]) {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) =>
        /OrphanSwipeCandidate/.test(sql) ? [rows] : [[]],
    );
}

const canonical = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;

describe('fetchSlot2a reject → next candidate', () => {
    it('serves the rank-1 candidate when nothing is voted', async () => {
        routeQuery(RANKED_ROWS);
        const rows = await fetchAllSlot2Rows('u', undefined, 'lt', new Set<string>());
        expect(rows).toHaveLength(1);
        expect(rows[0].candidateSpId).toBe(200);
    });

    it('advances to the rank-2 candidate after the rank-1 pair is rejected (voted)', async () => {
        routeQuery(RANKED_ROWS);
        const rows = await fetchAllSlot2Rows('u', undefined, 'lt', new Set([canonical(100, 200)]));
        expect(rows).toHaveLength(1);
        expect(rows[0].candidateSpId).toBe(201);
    });

    it('hides the orphan only once EVERY ranked candidate has been voted', async () => {
        routeQuery(RANKED_ROWS);
        const rows = await fetchAllSlot2Rows(
            'u', undefined, 'lt', new Set([canonical(100, 200), canonical(100, 201)]),
        );
        expect(rows).toHaveLength(0);
    });

    it('serves at most ONE card per orphan (no rank spam) — the best unvoted', async () => {
        routeQuery([
            mkRow(100, 200, 1, 0.90),
            mkRow(100, 201, 2, 0.80),
            mkRow(300, 400, 1, 0.70), // a second orphan, single candidate
        ]);
        const rows = await fetchAllSlot2Rows('u', undefined, 'lt', new Set<string>());
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.orphanSpId).sort()).toEqual([100, 300]);
        // Orphan 100 keeps its rank-1 (200), not both ranks.
        expect(rows.find((r) => r.orphanSpId === 100)!.candidateSpId).toBe(200);
    });

    it('bounds the OSC fetch to ranks 1..5 (SLOT2A_MAX_RANK) via the query param', async () => {
        routeQuery(RANKED_ROWS);
        await fetchAllSlot2Rows('u', undefined, 'lt', new Set<string>());
        const oscCall = mockQuery.mock.calls.find((c: any[]) => /OrphanSwipeCandidate/.test(c[0]));
        expect(oscCall).toBeDefined();
        // First bound param is the rank cap (rankPos <= ?).
        expect((oscCall as any[])[1][0]).toBe(5);
    });
});
