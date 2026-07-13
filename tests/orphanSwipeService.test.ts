import { jest } from '@jest/globals';

// Use known threshold values so tests are not fragile against config changes.
const THRESHOLDS = {
    minDwellMsOrphan: 700,
    maxUserVotesPerMinute: 30,
    minDwellMs: 400,
    wilsonZ: 1.645,
    substitutionMinSimilarity: 0.80,
    promoteIdentical: { minVotes: 5, minWilsonLower: 0.70 },
    demoteIdentical: { minVotes: 5, maxWilsonLower: 0.30 },
    nepriskirtaCategoryId: 1,
};
jest.unstable_mockModule('../src/config/matchThresholds.js', () => ({
    MatchThresholds: THRESHOLDS,
}));

// ---------------------------------------------------------------------------
// DB pool — provides a connection with transaction lifecycle methods
// ---------------------------------------------------------------------------

const mockConn = {
    beginTransaction: jest.fn<any>(),
    commit: jest.fn<any>(),
    rollback: jest.fn<any>(),
    release: jest.fn<any>(),
};
const mockGetConnection = jest.fn<any>();
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { getConnection: mockGetConnection },
}));

// ---------------------------------------------------------------------------
// storeProductMatchModel
// ---------------------------------------------------------------------------

const mockCountRecentVotes = jest.fn<any>();
const mockUpsertMatchVote = jest.fn<any>();
const mockApplyAggregateDelta = jest.fn<any>();
const mockGetMatchAggregate = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeProductMatchModel.js', () => ({
    applyAggregateDelta: mockApplyAggregateDelta,
    countRecentVotes: mockCountRecentVotes,
    getMatchAggregate: mockGetMatchAggregate,
    // orderPair is a pure sort — provide the real behaviour inline.
    orderPair: (a: number, b: number) => ({ spIdA: Math.min(a, b), spIdB: Math.max(a, b) }),
    upsertMatchVote: mockUpsertMatchVote,
    // PLAIN function (not jest.fn — resetAllMocks would wipe the implementation):
    // mirrors the real helper's math, delegating to the mocked applyAggregateDelta so
    // existing per-test delta assertions keep observing the net effect.
    applyVoteTransitionDeltas: async (a: number, b: number, prev: any, prevAgg: any, newV: any, conn?: any) => {
        const counted = prev !== null && !!prevAgg;
        if (counted && prev !== newV) await mockApplyAggregateDelta(a, b, prev, -1, conn);
        if (newV !== null && !(counted && prev === newV)) await mockApplyAggregateDelta(a, b, newV, +1, conn);
    },
    deleteMatchVote: jest.fn(),
}));

// ---------------------------------------------------------------------------
// swipeVoteService (applyBaseProductLinkForVote + reevaluateMerge)
// ---------------------------------------------------------------------------

const mockApplyBaseProductLinkForVote = jest.fn<any>();
const mockReevaluateMerge = jest.fn<any>();
jest.unstable_mockModule('../src/services/swipeVoteService.js', () => ({
    applyBaseProductLinkForVote: mockApplyBaseProductLinkForVote,
    reevaluateMerge: mockReevaluateMerge,
    castSwipeVote: jest.fn(),
    undoSwipeVote: jest.fn(),
}));

// ---------------------------------------------------------------------------
// storeProductMergeService
// ---------------------------------------------------------------------------

const mockGetProductIdForStoreProduct = jest.fn<any>();
jest.unstable_mockModule('../src/services/storeProductMergeService.js', () => ({
    getProductIdForStoreProduct: mockGetProductIdForStoreProduct,
    getEffectiveBaseProductIdForStoreProduct: jest.fn(),
    promoteMergeByProductIds: jest.fn(),
    demoteMergeByProductIds: jest.fn(),
    resolveEffectiveProductId: jest.fn(),
}));

// ---------------------------------------------------------------------------
// orphanSwipeCandidateModel
// ---------------------------------------------------------------------------

const mockGetCandidatePair = jest.fn<any>();
jest.unstable_mockModule('../src/models/orphanSwipeCandidateModel.js', () => ({
    getCandidatePair: mockGetCandidatePair,
    markResolvedForProductPair: jest.fn(),
    replaceOrphanCandidates: jest.fn(),
    getOrphanCandidates: jest.fn(),
}));

// ---------------------------------------------------------------------------
// userPointsService
// ---------------------------------------------------------------------------

const mockAwardSwipePoint = jest.fn<any>();
jest.unstable_mockModule('../src/services/userPointsService.js', () => ({
    awardSwipePoint: mockAwardSwipePoint,
    awardReceiptPoints: jest.fn(),
    getUserLevel: jest.fn(),
    getPointsToNextLevel: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Load the module under test
// ---------------------------------------------------------------------------

let castOrphanSwipeVote: any;

beforeAll(async () => {
    const mod = await import('../src/services/orphanSwipeService.js');
    castOrphanSwipeVote = mod.castOrphanSwipeVote;
});

beforeEach(() => {
    jest.resetAllMocks();

    // Restore connection mock (resetAllMocks clears implementations).
    mockGetConnection.mockResolvedValue(mockConn);
    mockConn.beginTransaction.mockResolvedValue(undefined);
    mockConn.commit.mockResolvedValue(undefined);
    mockConn.rollback.mockResolvedValue(undefined);
    mockConn.release.mockReturnValue(undefined);

    // Safe defaults so tests only override what they care about.
    mockCountRecentVotes.mockResolvedValue(0);
    // getCandidatePair: orphan=10, candidate=20 → after orderPair: spIdA=10, spIdB=20
    mockGetCandidatePair.mockResolvedValue({ orphanSpId: 10, candidateSpId: 20 });
    mockUpsertMatchVote.mockResolvedValue({ previousVote: null, previousAggregated: false });
    mockApplyAggregateDelta.mockResolvedValue(undefined);
    mockGetProductIdForStoreProduct.mockResolvedValue(100);
    mockApplyBaseProductLinkForVote.mockResolvedValue(undefined);
    mockGetMatchAggregate.mockResolvedValue(null);
    mockReevaluateMerge.mockResolvedValue(undefined);
    mockAwardSwipePoint.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Pre-flight guards — no transaction opened
// ---------------------------------------------------------------------------

describe('castOrphanSwipeVote — pre-flight guards', () => {
    it('drops vote when dwellMs is below minDwellMsOrphan', async () => {
        const result = await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 100,
        });

        expect(result).toEqual({ ok: true, effect: 'dropped-burst' });
        expect(mockGetConnection).not.toHaveBeenCalled();
        expect(mockCountRecentVotes).not.toHaveBeenCalled();
    });

    it('drops vote when user hits the per-minute rate limit', async () => {
        mockCountRecentVotes.mockResolvedValue(THRESHOLDS.maxUserVotesPerMinute);

        const result = await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000,
        });

        expect(result).toEqual({ ok: true, effect: 'dropped-rate-limit' });
        expect(mockGetConnection).not.toHaveBeenCalled();
    });

    it('returns no-candidate when the candidate pair row does not exist', async () => {
        mockGetCandidatePair.mockResolvedValue(null);

        const result = await castOrphanSwipeVote({
            userId: 'u1', candidateId: 99, vote: 'identical', dwellMs: 1000,
        });

        expect(result).toEqual({ ok: true, effect: 'no-candidate' });
        expect(mockGetConnection).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Aggregate delta logic
// ---------------------------------------------------------------------------

describe('castOrphanSwipeVote — aggregate delta', () => {
    it('applies +1 delta for the new vote when there was no previous vote', async () => {
        mockUpsertMatchVote.mockResolvedValue({ previousVote: null, previousAggregated: false });

        await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000,
        });

        expect(mockApplyAggregateDelta).toHaveBeenCalledTimes(1);
        expect(mockApplyAggregateDelta).toHaveBeenCalledWith(10, 20, 'identical', +1, mockConn);
    });

    it('applies -1 for old vote then +1 for new vote when changing the vote', async () => {
        mockUpsertMatchVote.mockResolvedValue({ previousVote: 'identical', previousAggregated: true });

        await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'similar', dwellMs: 1000,
        });

        expect(mockApplyAggregateDelta).toHaveBeenCalledTimes(2);
        expect(mockApplyAggregateDelta).toHaveBeenCalledWith(10, 20, 'identical', -1, mockConn);
        expect(mockApplyAggregateDelta).toHaveBeenCalledWith(10, 20, 'similar', +1, mockConn);
    });

    it('applies no aggregate deltas when re-casting the same vote', async () => {
        mockUpsertMatchVote.mockResolvedValue({ previousVote: 'similar', previousAggregated: true });

        await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'similar', dwellMs: 1000,
        });

        expect(mockApplyAggregateDelta).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('castOrphanSwipeVote — success path', () => {
    it('returns vote-recorded effect with merge decision from reevaluateMerge', async () => {
        const mockMerge = { type: 'promoted', productIdA: 1, productIdB: 2 };
        mockReevaluateMerge.mockResolvedValue(mockMerge);

        const result = await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000,
        });

        expect(result).toEqual({ ok: true, effect: 'vote-recorded', merge: mockMerge });
    });

    it('passes null receiptId to upsertMatchVote (orphan votes have no receipt)', async () => {
        await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000,
        });

        expect(mockUpsertMatchVote).toHaveBeenCalledWith(
            'u1', 10, 20, 'identical', 1000, null, true, mockConn
        );
    });

    it('passes pre-fetched productIds to applyBaseProductLinkForVote', async () => {
        mockGetProductIdForStoreProduct
            .mockResolvedValueOnce(200)  // spIdA=10 → Product 200
            .mockResolvedValueOnce(300); // spIdB=20 → Product 300

        await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'similar', dwellMs: 1000,
        });

        expect(mockApplyBaseProductLinkForVote).toHaveBeenCalledWith(
            10, 20, null, 'similar', mockConn, 200, 300
        );
    });

    it('awards a swipe point AFTER commit (fire-and-forget, no connection arg)', async () => {
        // Points UPDATE used to live inside the transaction, which held the
        // User row's X-lock for the duration of the vote pipeline and caused
        // `/users/:id/profile` requests to time out. Now it's a post-commit
        // fire-and-forget call with no connection — the pool handles its
        // own brief lock window.
        await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000,
        });

        expect(mockAwardSwipePoint).toHaveBeenCalledTimes(1);
        expect(mockAwardSwipePoint).toHaveBeenCalledWith('u1'); // no connection arg
        // Commit must already have happened before the points UPDATE runs.
        const commitOrder = mockConn.commit.mock.invocationCallOrder[0];
        const awardOrder = mockAwardSwipePoint.mock.invocationCallOrder[0];
        expect(awardOrder).toBeGreaterThan(commitOrder);
    });

    it('points-award failure post-commit is swallowed (vote still succeeds)', async () => {
        // The .catch on the fire-and-forget call must absorb the error —
        // otherwise an unhandled rejection would propagate and Node would
        // crash the API process under load.
        mockAwardSwipePoint.mockRejectedValueOnce(new Error('User lock timeout'));

        await expect(
            castOrphanSwipeVote({ userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000 }),
        ).resolves.toMatchObject({ ok: true });
        // Let the rejected promise's catch handler run.
        await new Promise((r) => setImmediate(r));
    });
});

// ---------------------------------------------------------------------------
// Transaction lifecycle
// ---------------------------------------------------------------------------

describe('castOrphanSwipeVote — transaction', () => {
    it('begins, commits, and releases the connection on success', async () => {
        await castOrphanSwipeVote({
            userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000,
        });

        expect(mockConn.beginTransaction).toHaveBeenCalled();
        expect(mockConn.commit).toHaveBeenCalled();
        expect(mockConn.rollback).not.toHaveBeenCalled();
        expect(mockConn.release).toHaveBeenCalled();
    });

    it('rolls back, releases, and rethrows when an error occurs inside the transaction', async () => {
        // Pick a mock that runs INSIDE the transaction. (awardSwipePoint used to
        // be in-transaction; it now fires post-commit and a rejection there
        // would NOT trigger rollback — covered by the dedicated test above.)
        mockUpsertMatchVote.mockRejectedValueOnce(new Error('DB failure'));

        await expect(
            castOrphanSwipeVote({ userId: 'u1', candidateId: 1, vote: 'identical', dwellMs: 1000 })
        ).rejects.toThrow('DB failure');

        expect(mockConn.rollback).toHaveBeenCalled();
        expect(mockConn.commit).not.toHaveBeenCalled();
        expect(mockConn.release).toHaveBeenCalled();
    });
});
