import { jest } from '@jest/globals';

/**
 * GAP 1 — the VOLUNTARY swipe queue must include the receipt-scoped Slot-2c orphan
 * backfill (the receipt's OWN 688 orphan lines), the same buildSlot2cBackfill the
 * mandatory queue uses. Two guarantees:
 *   • getSwipeQueue's voluntary branch APPENDS the slot-2c card(s) to the receipt pool;
 *   • getVoluntaryQueueCount COUNTS them, so the CTA badge equals what actually opens.
 * capVoluntaryQueue (real, pure) enforces the 10-card cap downstream.
 */

// Slot pools are empty so buildSwipeQueueItems yields no pair cards — the only cards
// come from the mocked slot-2c backfill (an unresolved 688 orphan paired to a
// categorised candidate).
const mockVoted = jest.fn<any>();
jest.unstable_mockModule('../src/models/votedPairsModel.js', () => ({ fetchVotedPairKeys: mockVoted }));
jest.unstable_mockModule('../src/models/slot1CandidateModel.js', () => ({ fetchSlot1Rows: jest.fn<any>(async () => []) }));
const mockSlot2Rows = jest.fn<any>(async () => []);
jest.unstable_mockModule('../src/models/slot2CandidateModel.js', () => ({ fetchAllSlot2Rows: mockSlot2Rows }));
jest.unstable_mockModule('../src/models/slot3CandidateModel.js', () => ({ fetchSlot3Rows: jest.fn<any>(async () => []) }));
jest.unstable_mockModule('../src/services/receiptRelatednessService.js', () => ({
    getReceiptRelatednessScope: jest.fn<any>(async () => ({ categoryIds: new Set(), lineNames: [], chainIds: new Set() })),
    isCardRelated: jest.fn<any>(() => true),
}));
const mockResolveCards = jest.fn<any>(async () => ({ cards: [], image: null }));
jest.unstable_mockModule('../src/services/receiptResolveQueueService.js', () => ({ buildReceiptResolveCards: mockResolveCards }));
const mockBackfill = jest.fn<any>();
jest.unstable_mockModule('../src/services/slot2cBackfillService.js', () => ({ buildSlot2cBackfill: mockBackfill }));
jest.unstable_mockModule('../src/services/orphanRefillService.js', () => ({ refillUserOrphansIfMissing: jest.fn<any>(async () => 0) }));
jest.unstable_mockModule('../src/config/db.js', () => ({
    default: {
        query: jest.fn<any>(async () => [[]]),
        getConnection: jest.fn<any>(async () => ({ query: jest.fn<any>(async () => [[]]), release: () => {} })),
    },
}));

const { getSwipeQueue, getVoluntaryQueueCount, buildVoluntarySlot2cCards } =
    await import('../src/controllers/swipeQueueController.js');

const USER = 'vol-user';
const RECEIPT = 237;

// One receipt-scoped orphan-rescue pair: 688 orphan SP 50 ⇄ categorised candidate SP 60.
const backfillItem = {
    cardId: '50-60', source: '2c', orphanSpId: 50, candidateSpId: 60, score: 0.71,
    sameChain: false, conflictDetected: false,
    orphan: { productId: 5, name: 'ORPHAN', chainName: 'IKI', categoryId: 10 },
    candidate: { productId: 6, name: 'CAND', chainName: 'Rimi', categoryId: 10 },
};

function makeRes() {
    const res: any = {};
    res.status = jest.fn<any>(() => res);
    res.json = jest.fn<any>(() => res);
    return res;
}
const req = (query: Record<string, string>): any => ({ params: { userId: USER }, query, locale: 'lt', body: {} });

beforeEach(() => {
    mockVoted.mockReset().mockResolvedValue(new Set());
    mockResolveCards.mockClear();
    mockSlot2Rows.mockReset().mockResolvedValue([]);
    mockBackfill.mockReset().mockResolvedValue([backfillItem]);
});

describe('buildVoluntarySlot2cCards', () => {
    it('shapes the receipt-scoped backfill into a slot-2 SwipeQueueCard', async () => {
        const cards = await buildVoluntarySlot2cCards(USER, RECEIPT, 'lt');
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ cardId: '50-60', slot: 2, left: { spId: 50 }, right: { spId: 60 } });
    });

    it('dedups against a pair already in the pool, and fails open on backfill error', async () => {
        expect(await buildVoluntarySlot2cCards(USER, RECEIPT, 'lt', new Set(['50-60']))).toEqual([]);
        mockBackfill.mockRejectedValueOnce(new Error('boom'));
        expect(await buildVoluntarySlot2cCards(USER, RECEIPT, 'lt')).toEqual([]);
    });
});

describe('getSwipeQueue voluntary branch', () => {
    it('appends the receipt-scoped slot-2c card to the receipt pool', async () => {
        const res = makeRes();
        await getSwipeQueue(req({ receiptId: String(RECEIPT), voluntary: '1' }), res, jest.fn());
        const body = (res.json as any).mock.calls.at(-1)[0];
        expect(body.items.map((c: any) => c.cardId)).toContain('50-60');
        expect(mockBackfill).toHaveBeenCalledWith(USER, RECEIPT, 5, 'lt');
    });

    it('does NOT run slot-2c for the ungated global pool (no receiptId)', async () => {
        const res = makeRes();
        await getSwipeQueue(req({ voluntary: '1' }), res, jest.fn());
        expect(mockBackfill).not.toHaveBeenCalled();
    });

    it('does NOT run slot-2c for a non-voluntary (mandatory-anchored) fetch', async () => {
        const res = makeRes();
        await getSwipeQueue(req({ receiptId: String(RECEIPT) }), res, jest.fn());
        expect(mockBackfill).not.toHaveBeenCalled();
    });

    it('ranks the receipt slot-2c seed AHEAD of the precomputed 2a slot-2 card', async () => {
        // A precomputed 2a orphan pair (SP 70 ⇄ SP 80) alongside the receipt's OWN
        // slot-2c seed (SP 50 ⇄ SP 60). Both are slot-2 cards; the receipt's own
        // uncategorised rescue must come first so it can never be crowded out.
        mockSlot2Rows.mockResolvedValueOnce([{
            source: '2a', orphanSpId: 70, candidateSpId: 80, score: 0.95, sameChain: false,
            orphan: { productId: 7, name: 'OSC-ORPHAN', brandName: null, imageUrl: null, unit: null, chainId: 1, chainName: 'IKI', chainLogoUrl: null, categoryId: 688, categoryName: 'Nepriskirta' },
            candidate: { productId: 8, name: 'OSC-CAND', brandName: null, imageUrl: null, unit: null, chainId: 2, chainName: 'Rimi', chainLogoUrl: null, categoryId: 10, categoryName: 'X' },
        }]);
        const res = makeRes();
        await getSwipeQueue(req({ receiptId: String(RECEIPT), voluntary: '1' }), res, jest.fn());
        const ids = ((res.json as any).mock.calls.at(-1)[0].items as any[]).map((c) => c.cardId);
        expect(ids).toContain('50-60'); // slot-2c seed
        expect(ids).toContain('70-80'); // precomputed 2a
        expect(ids.indexOf('50-60')).toBeLessThan(ids.indexOf('70-80'));
    });
});

describe('getVoluntaryQueueCount', () => {
    it('counts the slot-2c card so the badge equals what opens', async () => {
        const res = makeRes();
        await getVoluntaryQueueCount(req({ receiptId: String(RECEIPT) }), res, jest.fn());
        const body = (res.json as any).mock.calls.at(-1)[0];
        // Empty slot pools + 0 Card-B → the lone counted card IS the slot-2c backfill.
        expect(body.count).toBe(1);
        expect(mockBackfill).toHaveBeenCalledWith(USER, RECEIPT, 5, 'lt');
    });

    it('is 0 when there is no backfill and no other cards', async () => {
        mockBackfill.mockResolvedValue([]);
        const res = makeRes();
        await getVoluntaryQueueCount(req({ receiptId: String(RECEIPT) }), res, jest.fn());
        expect((res.json as any).mock.calls.at(-1)[0].count).toBe(0);
    });
});
