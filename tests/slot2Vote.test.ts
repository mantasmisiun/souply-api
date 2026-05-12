import { jest } from '@jest/globals';

// ── Thresholds ───────────────────────────────────────────────────────────────

const THRESHOLDS = {
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
};

jest.unstable_mockModule('../src/config/matchThresholds.js', () => ({
    MatchThresholds: THRESHOLDS,
}));

// ── DB pool ──────────────────────────────────────────────────────────────────

const mockConn = {
    beginTransaction: jest.fn<any>(),
    commit: jest.fn<any>(),
    rollback: jest.fn<any>(),
    release: jest.fn<any>(),
    query: jest.fn<any>(),
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
    applyAggregateDelta: mockApplyAggregateDelta,
    getMatchAggregate: mockGetMatchAggregate,
    orderPair: (a: number, b: number) => ({ spIdA: Math.min(a, b), spIdB: Math.max(a, b) }),
}));

// ── userEquivalenceModel ──────────────────────────────────────────────────────

const mockUpsertEquivalence = jest.fn<any>();

jest.unstable_mockModule('../src/models/userEquivalenceModel.js', () => ({
    upsertEquivalence: mockUpsertEquivalence,
}));

// ── userPointsService ─────────────────────────────────────────────────────────

const mockAwardSwipePoint = jest.fn<any>();

jest.unstable_mockModule('../src/services/userPointsService.js', () => ({
    awardSwipePoint: mockAwardSwipePoint,
}));

// ── storeProductMergeService ──────────────────────────────────────────────────

const mockGetProductIdForStoreProduct = jest.fn<any>();

jest.unstable_mockModule('../src/services/storeProductMergeService.js', () => ({
    getProductIdForStoreProduct: mockGetProductIdForStoreProduct,
    getEffectiveBaseProductIdForStoreProduct: jest.fn<any>(),
    promoteMergeByProductIds: jest.fn<any>(),
    demoteMergeByProductIds: jest.fn<any>(),
}));

// ── swipeVoteService (applyBaseProductLinkForVote) ────────────────────────────

const mockApplyBaseProductLinkForVote = jest.fn<any>();

jest.unstable_mockModule('../src/services/swipeVoteService.js', () => ({
    applyBaseProductLinkForVote: mockApplyBaseProductLinkForVote,
    reevaluateMerge: jest.fn<any>(),
    castSwipeVote: jest.fn<any>(),
    undoSwipeVote: jest.fn<any>(),
}));

// ── wilson ────────────────────────────────────────────────────────────────────

const mockWilsonLowerBound = jest.fn<any>();

jest.unstable_mockModule('../src/utils/wilson.js', () => ({
    wilsonLowerBound: mockWilsonLowerBound,
}));

// ── Load module under test ────────────────────────────────────────────────────

let castSlot2Vote: any;

beforeAll(async () => {
    const mod = await import('../src/services/slot2VoteService.js');
    castSlot2Vote = mod.castSlot2Vote;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_INPUT = {
    userId: 'user1',
    orphanSpId: 10,
    candidateSpId: 20,
    vote: 'identical' as const,
    dwellMs: 800,
    conflictDetected: false,
    sameChain: false,
};

/** Aggregate that sits exactly at the identical promotion threshold. */
const PROMOTE_AGG = { identicalVotes: 3, similarVotes: 0, differentVotes: 0 };
/** Aggregate that falls short of any threshold. */
const BELOW_AGG = { identicalVotes: 1, similarVotes: 0, differentVotes: 0 };

/** Simulate executeRescue queries: orphan with categoryId=688, candidate with new category+image, orphan SP imageUrl=null */
function setupRescueQueries(orphanImageUrl: string | null = null) {
    // 1. orphan Product row
    mockConn.query.mockResolvedValueOnce([[{ productId: 100, categoryId: 688 }]]);
    // 2. candidate Product row
    mockConn.query.mockResolvedValueOnce([[{ categoryId: 50, candidateImageUrl: 'http://img.jpg' }]]);
    // 3. UPDATE Product SET categoryId
    mockConn.query.mockResolvedValueOnce([{}]);
    // 4. orphan SP imageUrl lookup
    mockConn.query.mockResolvedValueOnce([[{ imageUrl: orphanImageUrl }]]);
    // 5. UPDATE StoreProduct SET imageUrl (only called when orphanImageUrl is null)
    mockConn.query.mockResolvedValueOnce([{}]);
}

beforeEach(() => {
    jest.resetAllMocks();

    // Restore connection mock.
    mockGetConnection.mockResolvedValue(mockConn);
    mockConn.beginTransaction.mockResolvedValue(undefined);
    mockConn.commit.mockResolvedValue(undefined);
    mockConn.rollback.mockResolvedValue(undefined);
    mockConn.release.mockReturnValue(undefined);

    // Safe defaults.
    mockCountRecentVotes.mockResolvedValue(0);
    mockAwardSwipePoint.mockResolvedValue(undefined);
    mockUpsertEquivalence.mockResolvedValue(undefined);
    mockUpsertMatchVote.mockResolvedValue({ previousVote: null });
    mockApplyAggregateDelta.mockResolvedValue(undefined);
    mockGetProductIdForStoreProduct.mockResolvedValue(100);
    mockApplyBaseProductLinkForVote.mockResolvedValue(undefined);
    mockGetMatchAggregate.mockResolvedValue(null);
    mockWilsonLowerBound.mockReturnValue(0.0);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('castSlot2Vote', () => {
    it('dropped-rate-limit when rate limit exceeded', async () => {
        mockCountRecentVotes.mockResolvedValue(40);
        const result = await castSlot2Vote(BASE_INPUT);
        expect(result).toMatchObject({ ok: true, effect: 'dropped-rate-limit' });
        expect(mockGetConnection).not.toHaveBeenCalled();
    });

    it('burst: awards point but skips equivalence and aggregate', async () => {
        const result = await castSlot2Vote({ ...BASE_INPUT, dwellMs: 100 });
        expect(mockAwardSwipePoint).toHaveBeenCalledTimes(1);
        expect(mockUpsertMatchVote).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, effect: 'vote-recorded', isBurst: true });
    });

    it('non-burst right vote: records equivalence as same', async () => {
        mockGetMatchAggregate.mockResolvedValue(BELOW_AGG);
        await castSlot2Vote({ ...BASE_INPUT, vote: 'identical' });
        expect(mockUpsertEquivalence).toHaveBeenCalledWith(
            'user1', 10, 20, 'same', mockConn,
        );
    });

    it('non-burst different vote: records equivalence as different', async () => {
        mockGetMatchAggregate.mockResolvedValue(BELOW_AGG);
        await castSlot2Vote({ ...BASE_INPUT, vote: 'different' });
        expect(mockUpsertEquivalence).toHaveBeenCalledWith(
            'user1', 10, 20, 'different', mockConn,
        );
    });

    it('non-burst similar vote: records equivalence as different', async () => {
        mockGetMatchAggregate.mockResolvedValue(BELOW_AGG);
        await castSlot2Vote({ ...BASE_INPUT, vote: 'similar' });
        expect(mockUpsertEquivalence).toHaveBeenCalledWith(
            'user1', 10, 20, 'different', mockConn,
        );
    });

    it('below threshold: no rescue executed', async () => {
        mockGetMatchAggregate.mockResolvedValue(BELOW_AGG);
        mockWilsonLowerBound.mockReturnValue(0.20);
        await castSlot2Vote(BASE_INPUT);
        // No SELECT queries on conn for rescue
        expect(mockConn.query).not.toHaveBeenCalled();
    });

    it('threshold crossed, no conflict: updates category and image', async () => {
        mockGetMatchAggregate.mockResolvedValue(PROMOTE_AGG);
        mockWilsonLowerBound.mockReturnValue(0.85);

        // executeRescue queries: orphan SP imageUrl = null so image update fires
        mockConn.query
            .mockResolvedValueOnce([[{ productId: 100, categoryId: 688 }]])   // orphan Product
            .mockResolvedValueOnce([[{ categoryId: 50, candidateImageUrl: 'http://img.jpg' }]]) // candidate
            .mockResolvedValueOnce([{}])  // UPDATE Product
            .mockResolvedValueOnce([[{ imageUrl: null }]])  // orphan SP imageUrl
            .mockResolvedValueOnce([{}]); // UPDATE StoreProduct

        const result = await castSlot2Vote({ ...BASE_INPUT, conflictDetected: false });
        expect(result).toMatchObject({ ok: true, effect: 'vote-recorded' });

        const calls = mockConn.query.mock.calls.map((c: any) => c[0] as string);
        expect(calls.some(q => q.includes('UPDATE Product SET categoryId'))).toBe(true);
        expect(calls.some(q => q.includes('UPDATE StoreProduct SET imageUrl'))).toBe(true);
    });

    it('threshold crossed, conflict detected: updates category only', async () => {
        mockGetMatchAggregate.mockResolvedValue(PROMOTE_AGG);
        mockWilsonLowerBound.mockReturnValue(0.85);

        mockConn.query
            .mockResolvedValueOnce([[{ productId: 100, categoryId: 688 }]])
            .mockResolvedValueOnce([[{ categoryId: 50, candidateImageUrl: 'http://img.jpg' }]])
            .mockResolvedValueOnce([{}]); // UPDATE Product only

        await castSlot2Vote({ ...BASE_INPUT, conflictDetected: true });

        const calls = mockConn.query.mock.calls.map((c: any) => c[0] as string);
        expect(calls.some(q => q.includes('UPDATE Product SET categoryId'))).toBe(true);
        expect(calls.some(q => q.includes('UPDATE StoreProduct SET imageUrl'))).toBe(false);
    });

    it('threshold crossed but orphan already rescued (categoryId≠688): no update', async () => {
        mockGetMatchAggregate.mockResolvedValue(PROMOTE_AGG);
        mockWilsonLowerBound.mockReturnValue(0.85);

        // orphan categoryId is already 50 — not 688
        mockConn.query.mockResolvedValueOnce([[{ productId: 100, categoryId: 50 }]]);

        await castSlot2Vote(BASE_INPUT);

        const calls = mockConn.query.mock.calls.map((c: any) => c[0] as string);
        expect(calls.some(q => q.includes('UPDATE Product'))).toBe(false);
    });

    it('threshold crossed, same-chain right: logs OCR flag', async () => {
        mockGetMatchAggregate.mockResolvedValue(PROMOTE_AGG);
        mockWilsonLowerBound.mockReturnValue(0.85);

        mockConn.query
            .mockResolvedValueOnce([[{ productId: 100, categoryId: 688 }]])
            .mockResolvedValueOnce([[{ categoryId: 50, candidateImageUrl: 'http://img.jpg' }]])
            .mockResolvedValueOnce([{}])  // UPDATE Product
            .mockResolvedValueOnce([[{ imageUrl: null }]])
            .mockResolvedValueOnce([{}])  // UPDATE StoreProduct
            .mockResolvedValueOnce([{}]); // INSERT AdminReviewFlag

        await castSlot2Vote({ ...BASE_INPUT, sameChain: true, receiptId: 99 });

        const calls = mockConn.query.mock.calls.map((c: any) => c[0] as string);
        expect(calls.some(q => q.includes('AdminReviewFlag'))).toBe(true);
    });

    it('threshold crossed, cross-chain: no OCR flag', async () => {
        mockGetMatchAggregate.mockResolvedValue(PROMOTE_AGG);
        mockWilsonLowerBound.mockReturnValue(0.85);

        mockConn.query
            .mockResolvedValueOnce([[{ productId: 100, categoryId: 688 }]])
            .mockResolvedValueOnce([[{ categoryId: 50, candidateImageUrl: 'http://img.jpg' }]])
            .mockResolvedValueOnce([{}])
            .mockResolvedValueOnce([[{ imageUrl: null }]])
            .mockResolvedValueOnce([{}]);

        await castSlot2Vote({ ...BASE_INPUT, sameChain: false });

        const calls = mockConn.query.mock.calls.map((c: any) => c[0] as string);
        expect(calls.some(q => q.includes('AdminReviewFlag'))).toBe(false);
    });

    it('similar vote threshold crossed: category-only rescue', async () => {
        const similarAgg = { identicalVotes: 0, similarVotes: 3, differentVotes: 0 };
        mockGetMatchAggregate.mockResolvedValue(similarAgg);
        mockWilsonLowerBound.mockReturnValue(0.75);

        mockConn.query
            .mockResolvedValueOnce([[{ productId: 100, categoryId: 688 }]])
            .mockResolvedValueOnce([[{ categoryId: 50, candidateImageUrl: 'http://img.jpg' }]])
            .mockResolvedValueOnce([{}]); // UPDATE Product only — no imageUrl update

        await castSlot2Vote({ ...BASE_INPUT, vote: 'similar', conflictDetected: false });

        const calls = mockConn.query.mock.calls.map((c: any) => c[0] as string);
        expect(calls.some(q => q.includes('UPDATE Product SET categoryId'))).toBe(true);
        // Similar rescue is always category-only regardless of conflictDetected.
        expect(calls.some(q => q.includes('UPDATE StoreProduct SET imageUrl'))).toBe(false);
    });
});
