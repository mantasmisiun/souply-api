import { jest } from '@jest/globals';

// ── Thresholds ───────────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/config/matchThresholds.js', () => ({
    MatchThresholds: {
        minDwellMsOrphan: 700,
        maxUserVotesPerMinute: 40,
        minDwellMs: 100,
        wilsonZ: 1.96,
        promoteIdentical: { minVotes: 3, minWilsonLower: 0.80 },
        demoteIdentical: { minVotes: 3, maxWilsonLower: 0.50 },
        promoteSimilar: { minVotes: 3, minWilsonLower: 0.70 },
        demoteSimilar: { minVotes: 3, maxWilsonLower: 0.40 },
        substitutionMinSimilarity: 0.75,
        nepriskirtaCategoryId: 688,
    },
}));

// ── DB pool ───────────────────────────────────────────────────────────────────

const mockConn = {
    beginTransaction: jest.fn<any>(),
    commit: jest.fn<any>(),
    rollback: jest.fn<any>(),
    release: jest.fn<any>(),
};
const mockGetConnection = jest.fn<any>();

jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: jest.fn<any>(), getConnection: mockGetConnection },
}));

// ── storeProductMatchModel ────────────────────────────────────────────────────

const mockCountRecentVotes = jest.fn<any>();
const mockUpsertMatchVote = jest.fn<any>();
const mockApplyAggregateDelta = jest.fn<any>();
const mockGetMatchAggregate = jest.fn<any>();

jest.unstable_mockModule('../src/models/storeProductMatchModel.js', () => ({
    countRecentVotes: mockCountRecentVotes,
    upsertMatchVote: mockUpsertMatchVote,
    // PLAIN function (not jest.fn — resetAllMocks would wipe the implementation):
    // mirrors the real helper's math, delegating to the mocked applyAggregateDelta so
    // existing per-test delta assertions keep observing the net effect.
    applyVoteTransitionDeltas: async (a: number, b: number, prev: any, prevAgg: any, newV: any, conn?: any) => {
        const counted = prev !== null && !!prevAgg;
        if (counted && prev !== newV) await mockApplyAggregateDelta(a, b, prev, -1, conn);
        if (newV !== null && !(counted && prev === newV)) await mockApplyAggregateDelta(a, b, newV, +1, conn);
    },
    applyAggregateDelta: mockApplyAggregateDelta,
    getMatchAggregate: mockGetMatchAggregate,
    orderPair: (a: number, b: number) => ({ spIdA: Math.min(a, b), spIdB: Math.max(a, b) }),
    deleteMatchVote: jest.fn<any>(),
}));

// ── swipeVoteService ──────────────────────────────────────────────────────────

const mockApplyBaseProductLinkForVote = jest.fn<any>();
const mockReevaluateMerge = jest.fn<any>();

jest.unstable_mockModule('../src/services/swipeVoteService.js', () => ({
    applyBaseProductLinkForVote: mockApplyBaseProductLinkForVote,
    reevaluateMerge: mockReevaluateMerge,
    castSwipeVote: jest.fn<any>(),
    undoSwipeVote: jest.fn<any>(),
}));

// ── storeProductMergeService ──────────────────────────────────────────────────

const mockGetProductIdForStoreProduct = jest.fn<any>();

jest.unstable_mockModule('../src/services/storeProductMergeService.js', () => ({
    getProductIdForStoreProduct: mockGetProductIdForStoreProduct,
    getEffectiveBaseProductIdForStoreProduct: jest.fn<any>(),
    promoteMergeByProductIds: jest.fn<any>(),
    demoteMergeByProductIds: jest.fn<any>(),
    resolveEffectiveProductId: jest.fn<any>(),
}));

// ── orphanSwipeCandidateModel ─────────────────────────────────────────────────

const mockGetCandidatePair = jest.fn<any>();

jest.unstable_mockModule('../src/models/orphanSwipeCandidateModel.js', () => ({
    getCandidatePair: mockGetCandidatePair,
    markResolvedForProductPair: jest.fn<any>(),
    replaceOrphanCandidates: jest.fn<any>(),
    getOrphanCandidates: jest.fn<any>(),
}));

// ── userPointsService ─────────────────────────────────────────────────────────

const mockAwardSwipePoint = jest.fn<any>();

jest.unstable_mockModule('../src/services/userPointsService.js', () => ({
    awardSwipePoint: mockAwardSwipePoint,
    awardReceiptPoints: jest.fn<any>(),
}));

// ── Load module under test ────────────────────────────────────────────────────

let castOrphanSwipeVote: any;

beforeAll(async () => {
    const mod = await import('../src/services/orphanSwipeService.js');
    castOrphanSwipeVote = mod.castOrphanSwipeVote;
});

beforeEach(() => {
    jest.resetAllMocks();

    mockGetConnection.mockResolvedValue(mockConn);
    mockConn.beginTransaction.mockResolvedValue(undefined);
    mockConn.commit.mockResolvedValue(undefined);
    mockConn.rollback.mockResolvedValue(undefined);
    mockConn.release.mockReturnValue(undefined);

    mockCountRecentVotes.mockResolvedValue(0);
    mockGetCandidatePair.mockResolvedValue({ orphanSpId: 10, candidateSpId: 20 });
    mockUpsertMatchVote.mockResolvedValue({ previousVote: null, previousAggregated: false });
    mockApplyAggregateDelta.mockResolvedValue(undefined);
    mockGetProductIdForStoreProduct.mockResolvedValue(100);
    mockApplyBaseProductLinkForVote.mockResolvedValue(undefined);
    mockGetMatchAggregate.mockResolvedValue(null);
    mockReevaluateMerge.mockResolvedValue(undefined);
    mockAwardSwipePoint.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Slot 3 vote — smoke test', () => {
    it('castOrphanSwipeVote returns ok:true with vote-recorded effect for a valid vote', async () => {
        const result = await castOrphanSwipeVote({
            userId: 'user1',
            candidateId: 42,
            vote: 'identical',
            dwellMs: 1000,
        });

        expect(result.ok).toBe(true);
        expect(result.effect).toBe('vote-recorded');
    });
});
