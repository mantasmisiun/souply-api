import { jest } from '@jest/globals';

// undoSwipeVote reads the line SP (ReceiptItem), deletes the vote row (returning what it
// was), reverses aggregates, and — the piece under test — reverses the Price flip ONLY
// when the undone vote could have caused one (vote-aware revertLinePriceEffect).
const mockQuery = jest.fn<any>();
const mockConn = {
    query: mockQuery,
    beginTransaction: jest.fn<any>(async () => {}),
    commit: jest.fn<any>(async () => {}),
    rollback: jest.fn<any>(async () => {}),
    release: jest.fn(),
};
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: { query: mockQuery, getConnection: async () => mockConn },
}));

const mockGetReceiptItemKey = jest.fn<any>();
jest.unstable_mockModule('../src/models/receiptItemModel.js', () => ({
    getReceiptItemKey: mockGetReceiptItemKey,
    updateReceiptItem: jest.fn<any>(async () => 1),
}));
const mockFindLinePrimaryPrice = jest.fn<any>();
jest.unstable_mockModule('../src/models/priceModel.js', () => ({
    findLinePrimaryPrice: mockFindLinePrimaryPrice,
}));

const mockDeleteMatchVote = jest.fn<any>();
jest.unstable_mockModule('../src/models/storeProductMatchModel.js', () => ({
    orderPair: (a: number, b: number) => (a < b ? { spIdA: a, spIdB: b } : { spIdA: b, spIdB: a }),
    upsertMatchVote: jest.fn(),
    deleteMatchVote: mockDeleteMatchVote,
    applyAggregateDelta: jest.fn<any>(async () => {}),
    applyVoteTransitionDeltas: jest.fn<any>(async () => {}),
    getMatchAggregate: jest.fn<any>(async () => null),
    countRecentVotes: jest.fn<any>(async () => 0),
    getVoteHistory: jest.fn(),
}));
jest.unstable_mockModule('../src/models/baseProductLinkModel.js', () => ({
    applyBaseProductLinkDelta: jest.fn<any>(async () => {}),
}));
jest.unstable_mockModule('../src/services/storeProductMergeService.js', () => ({
    categoriseUncategorisedOnMerge: jest.fn(),
    demoteMergeByProductIds: jest.fn(),
    getEffectiveBaseProductIdForStoreProduct: jest.fn<any>(async () => null),
    getProductIdForStoreProduct: jest.fn<any>(async () => 1),
    promoteMergeByProductIds: jest.fn(),
}));
jest.unstable_mockModule('../src/models/orphanSwipeCandidateModel.js', () => ({
    markResolvedForProductPair: jest.fn<any>(async () => {}),
}));
jest.unstable_mockModule('../src/models/userEquivalenceModel.js', () => ({
    clearReverification: jest.fn<any>(async () => {}),
    upsertEquivalence: jest.fn<any>(async () => {}),
}));
jest.unstable_mockModule('../src/services/userPointsService.js', () => ({
    awardSwipePoint: jest.fn<any>(async () => {}),
}));
jest.unstable_mockModule('../src/services/swipeSessionService.js', () => ({
    isBurstSwipe: () => false,
}));

let undoSwipeVote: any;
beforeAll(async () => {
    const mod = await import('../src/services/swipeVoteService.js');
    undoSwipeVote = mod.undoSwipeVote;
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetReceiptItemKey.mockResolvedValue({ id: 900, matchedSpId: 10 }); // line row + SP
    mockFindLinePrimaryPrice.mockResolvedValue(null);
});

const INPUT = { userId: 'u1', receiptId: 5, receiptLineIdx: 0, candidateStoreProductId: 20 };
const setPriceRow = (verified: 0 | 1) => mockFindLinePrimaryPrice.mockResolvedValue({ id: 77, priceVerified: verified });
const priceFlips = () => mockQuery.mock.calls.filter((c: any) => /UPDATE Price SET priceVerified/.test(c[0]));

describe('undoSwipeVote — vote-aware price reversal', () => {
    it("undoing a 'similar' vote never touches priceVerified (old blind toggle verified it)", async () => {
        mockDeleteMatchVote.mockResolvedValue({ deletedVote: 'similar', deletedAggregated: true });
        setPriceRow(0 as 0 | 1);
        mockQuery.mockImplementation(async () => [{ affectedRows: 1 }]);

        await undoSwipeVote(INPUT);

        expect(priceFlips()).toHaveLength(0);
    });

    it('double-undo (no vote row deleted) is a no-op on priceVerified', async () => {
        mockDeleteMatchVote.mockResolvedValue({ deletedVote: null, deletedAggregated: false });
        setPriceRow(1 as 0 | 1);
        mockQuery.mockImplementation(async () => [{ affectedRows: 1 }]);

        await undoSwipeVote(INPUT);

        expect(priceFlips()).toHaveLength(0);
    });

    it("undoing an 'identical' unverifies a verified price", async () => {
        mockDeleteMatchVote.mockResolvedValue({ deletedVote: 'identical', deletedAggregated: true });
        setPriceRow(1 as 0 | 1);
        mockQuery.mockImplementation(async () => [{ affectedRows: 1 }]);

        await undoSwipeVote(INPUT);

        const flips = priceFlips();
        expect(flips).toHaveLength(1);
        expect(flips[0][0]).toContain('priceVerified = 0');
    });

    it("undoing a 'different' NEVER verifies — the original may have been a no-op, and a false verify feeds the baseline", async () => {
        mockDeleteMatchVote.mockResolvedValue({ deletedVote: 'different', deletedAggregated: true });
        setPriceRow(0 as 0 | 1);
        mockQuery.mockImplementation(async () => [{ affectedRows: 1 }]);

        await undoSwipeVote(INPUT);

        expect(priceFlips()).toHaveLength(0);
    });

    it('self-pair undo can only UNVERIFY — an unverified price stays unverified', async () => {
        mockGetReceiptItemKey.mockResolvedValue({ id: 900, matchedSpId: 20 }); // candidate === line SP → self-pair
        setPriceRow(0 as 0 | 1);
        mockQuery.mockImplementation(async () => [{ affectedRows: 1 }]);

        await undoSwipeVote(INPUT);

        expect(priceFlips()).toHaveLength(0); // never blind-verifies
    });
});
