import { jest } from '@jest/globals';

/**
 * One-shot mandatory queue: composition rules (Card-B first, slot cards behind,
 * top-up only when thin, Slot-2c only when still thin, cap 3) + the save-time
 * snapshot cache with revalidation-on-read (a vote can never resurrect a spent
 * card; a foreign user never reads another user's snapshot).
 */
const mockBuildItems = jest.fn<any>();
jest.unstable_mockModule('../src/controllers/swipeQueueController.js', () => ({
    buildSwipeQueueItems: mockBuildItems,
}));
const mockResolveCards = jest.fn<any>();
jest.unstable_mockModule('../src/services/receiptResolveQueueService.js', () => ({
    buildReceiptResolveCards: mockResolveCards,
}));
const mockBackfill = jest.fn<any>();
jest.unstable_mockModule('../src/services/slot2cBackfillService.js', () => ({
    buildSlot2cBackfill: mockBackfill,
}));
const mockResolved = jest.fn<any>();
jest.unstable_mockModule('../src/models/receiptLineResolutionModel.js', () => ({
    getResolvedLineIdxSet: mockResolved,
}));
const mockVoted = jest.fn<any>();
jest.unstable_mockModule('../src/models/receiptSwipeCandidateModel.js', () => ({
    getVotedPairKeysForUser: mockVoted,
}));
jest.unstable_mockModule('../src/config/db.js', () => ({ default: { query: jest.fn() } }));

const { getMandatoryQueue, prewarmMandatoryQueue, getServedResolveLineIdxs, _clearMandatoryQueueSnapshots } =
    await import('../src/services/mandatoryQueueService.js');

const pair = (id: string, slot: 1 | 2 | 3, a = 10, b = 20) => ({
    cardId: id, slot, score: 0.8,
    left: { spId: a }, right: { spId: b },
});
const cardB = (lineIdx: number) => ({
    cardKind: 'receipt', cardId: `rcpt:237:${lineIdx}`, receiptLineIdx: lineIdx,
    ocr: { name: 'x', cropUrl: 'u' }, region: null,
    matched: { spId: 5, name: 'm', imageUrl: null }, needsHuman: 0.5,
});

beforeEach(() => {
    _clearMandatoryQueueSnapshots();
    mockBuildItems.mockReset();
    mockResolveCards.mockReset();
    mockBackfill.mockReset();
    mockResolved.mockReset().mockResolvedValue(new Set());
    mockVoted.mockReset().mockResolvedValue(new Set());
    mockBackfill.mockResolvedValue([]);
});

describe('assembly composition', () => {
    it('Card-B cards lead, pair cards follow, capped at 3; no top-up when the receipt pool is full', async () => {
        mockBuildItems.mockResolvedValue({ items: [pair('a', 2, 1, 2), pair('b', 1, 3, 4), pair('c', 3, 5, 6)], slotCounts: { slot1: 1, slot2: 1, slot3: 1 } });
        mockResolveCards.mockResolvedValue({ cards: [cardB(1)], image: { width: 900, height: 3000 } });
        const q = await getMandatoryQueue('u1', 237);
        expect(q.cards).toHaveLength(3);
        expect(q.cards[0].cardKind).toBe('receipt');
        expect(q.image).toEqual({ width: 900, height: 3000 });
        expect(mockBuildItems).toHaveBeenCalledTimes(1); // receipt-anchored only — no global top-up
        expect(mockBackfill).not.toHaveBeenCalled();
    });

    it('thin receipt pool → relatedTo top-up; still thin → Slot-2c backfill fills to 3', async () => {
        mockBuildItems
            .mockResolvedValueOnce({ items: [pair('a', 2)], slotCounts: { slot1: 0, slot2: 1, slot3: 0 } })
            .mockResolvedValueOnce({ items: [pair('b', 1, 30, 40)], slotCounts: { slot1: 1, slot2: 0, slot3: 0 } });
        mockResolveCards.mockResolvedValue({ cards: [], image: null });
        mockBackfill.mockResolvedValue([{
            cardId: '50-60', slot: 2, score: 0.7, source: '2c', orphanSpId: 50, candidateSpId: 60,
            sameChain: false, conflictDetected: false,
            orphan: { productId: 5 }, candidate: { productId: 6 },
        }]);
        const q = await getMandatoryQueue('u1', 237);
        expect(q.cards.map((c: any) => c.cardId)).toEqual(['a', 'b', '50-60']);
        expect(mockBackfill).toHaveBeenCalledWith('u1', 237, 1, 'lt');
    });
});

describe('snapshot cache', () => {
    it('prewarm → snapshot serve without rebuilding; revalidation drops voted/resolved cards', async () => {
        mockBuildItems.mockResolvedValue({ items: [pair('a', 2, 1, 2), pair('b', 1, 3, 4)], slotCounts: { slot1: 1, slot2: 1, slot3: 0 } });
        mockResolveCards.mockResolvedValue({ cards: [cardB(1)], image: null });
        await prewarmMandatoryQueue('u1', 237);
        mockBuildItems.mockClear();

        // Vote consumed the pair (1,2) and the user resolved line 1 since the snapshot.
        mockVoted.mockResolvedValue(new Set(['1-2']));
        mockResolved.mockResolvedValue(new Set([1]));
        const q = await getMandatoryQueue('u1', 237);
        expect(q.fromSnapshot).toBe(true);
        expect(q.cards.map((c: any) => c.cardId)).toEqual(['b']); // Card-B(L1) + pair a dropped
        expect(mockBuildItems).not.toHaveBeenCalled(); // no rebuild
    });

    it('fully-consumed snapshot falls through to a live rebuild', async () => {
        mockBuildItems.mockResolvedValue({ items: [pair('a', 2, 1, 2)], slotCounts: { slot1: 0, slot2: 1, slot3: 0 } });
        mockResolveCards.mockResolvedValue({ cards: [], image: null });
        await prewarmMandatoryQueue('u1', 237);
        mockVoted.mockResolvedValue(new Set(['1-2']));
        mockBuildItems.mockClear();
        // top-up path will also be exercised by the rebuild (thin pool) — feed it too
        mockBuildItems.mockResolvedValue({ items: [pair('fresh', 2, 7, 8)], slotCounts: { slot1: 0, slot2: 1, slot3: 0 } });
        const q = await getMandatoryQueue('u1', 237);
        expect(q.fromSnapshot).toBe(false);
        expect(q.cards.map((c: any) => c.cardId)).toEqual(['fresh']);
    });

    it("another user's request never reads a foreign snapshot", async () => {
        mockBuildItems.mockResolvedValue({ items: [pair('a', 2, 1, 2), pair('b', 1, 3, 4), pair('c', 3, 5, 6)], slotCounts: { slot1: 1, slot2: 1, slot3: 1 } });
        mockResolveCards.mockResolvedValue({ cards: [], image: null });
        await prewarmMandatoryQueue('u1', 237);
        mockBuildItems.mockClear();
        mockBuildItems.mockResolvedValue({ items: [pair('other', 2, 9, 10), pair('o2', 1, 11, 12), pair('o3', 3, 13, 14)], slotCounts: { slot1: 1, slot2: 1, slot3: 1 } });
        const q = await getMandatoryQueue('u2', 237);
        expect(q.fromSnapshot).toBe(false);
    });
});

// GAP 2 — the served set POST /complete-swipes marks 'asked' comes from THIS snapshot
// (the exact card set the client received), never a fresh recompute that would burn
// unseen lines.
describe('getServedResolveLineIdxs', () => {
    it('returns the snapshot Card-B (receipt) line indices for the owning user', async () => {
        mockBuildItems.mockResolvedValue({ items: [pair('a', 2, 1, 2)], slotCounts: { slot1: 0, slot2: 1, slot3: 0 } });
        mockResolveCards.mockResolvedValue({ cards: [cardB(1), cardB(4)], image: null });
        await prewarmMandatoryQueue('u1', 237);
        expect(getServedResolveLineIdxs('u1', 237)).toEqual([1, 4]);
    });

    it('never leaks a foreign user\'s served set, and is null when no snapshot exists', async () => {
        mockBuildItems.mockResolvedValue({ items: [], slotCounts: { slot1: 0, slot2: 0, slot3: 0 } });
        mockResolveCards.mockResolvedValue({ cards: [cardB(2)], image: null });
        await prewarmMandatoryQueue('u1', 237);
        expect(getServedResolveLineIdxs('u2', 237)).toBeNull(); // foreign user
        expect(getServedResolveLineIdxs('u1', 999)).toBeNull();  // no snapshot
    });

    it('returns [] (not null) for a session that served no Card-B lines', async () => {
        mockBuildItems.mockResolvedValue({ items: [pair('a', 2, 1, 2)], slotCounts: { slot1: 0, slot2: 1, slot3: 0 } });
        mockResolveCards.mockResolvedValue({ cards: [], image: null });
        await prewarmMandatoryQueue('u1', 237);
        expect(getServedResolveLineIdxs('u1', 237)).toEqual([]);
    });
});
