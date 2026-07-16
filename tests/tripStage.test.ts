import { deriveTripStage, contributesToDot, autoArchiveAfterHours, slotClosed, type TripSlotFacts } from '../src/services/tripStageService.js';

const slot = (over: Partial<TripSlotFacts> = {}): TripSlotFacts => ({
    listStatus: 'active',
    hasReceipt: false,
    receiptSkipped: false,
    ...over,
});

describe('deriveTripStage', () => {
    it('stage 1: basket forming, no calc, no lists', () => {
        expect(deriveTripStage({ isAdHoc: false, basketCalculated: false, slots: [] })).toBe(1);
    });

    it('stage 2: calculated but no lists yet', () => {
        expect(deriveTripStage({ isAdHoc: false, basketCalculated: true, slots: [] })).toBe(2);
    });

    it('stage 3: any list still active', () => {
        expect(deriveTripStage({
            isAdHoc: false, basketCalculated: true,
            slots: [slot({ listStatus: 'completed' }), slot()],
        })).toBe(3);
    });

    it('stage 4: all lists completed, a receipt slot open', () => {
        expect(deriveTripStage({
            isAdHoc: false, basketCalculated: true,
            slots: [slot({ listStatus: 'completed', hasReceipt: true }), slot({ listStatus: 'completed' })],
        })).toBe(4);
    });

    it('stage 5: every slot filled or skipped', () => {
        expect(deriveTripStage({
            isAdHoc: false, basketCalculated: true,
            slots: [
                slot({ listStatus: 'completed', hasReceipt: true }),
                slot({ listStatus: 'completed', receiptSkipped: true }),
            ],
        })).toBe(5);
    });

    it('ad-hoc trips are born stage 5 regardless of slots', () => {
        expect(deriveTripStage({ isAdHoc: true, basketCalculated: false, slots: [] })).toBe(5);
    });

    it('per-store mini-cycle: receipt on a completed slot while another shops → still stage 3', () => {
        // The slot-level upload is allowed by the UI; trip stage stays a summary.
        expect(deriveTripStage({
            isAdHoc: false, basketCalculated: true,
            slots: [slot({ listStatus: 'completed', hasReceipt: true }), slot({ listStatus: 'active' })],
        })).toBe(3);
    });
});

describe('dot + auto-archive policies', () => {
    it('stages 1-4 unarchived drive the dot; stage 5 and archived never do', () => {
        expect(contributesToDot(1, null)).toBe(true);
        expect(contributesToDot(4, null)).toBe(true);
        expect(contributesToDot(5, null)).toBe(false);
        expect(contributesToDot(3, new Date())).toBe(false);
    });

    it('48h for forming/searched, 7d for planned, never for stage 5', () => {
        expect(autoArchiveAfterHours(1)).toBe(48);
        expect(autoArchiveAfterHours(2)).toBe(48);
        expect(autoArchiveAfterHours(3)).toBe(168);
        expect(autoArchiveAfterHours(4)).toBe(168);
        expect(autoArchiveAfterHours(5)).toBeNull();
    });

    it('slotClosed = receipt attached OR explicitly skipped', () => {
        expect(slotClosed(slot())).toBe(false);
        expect(slotClosed(slot({ hasReceipt: true }))).toBe(true);
        expect(slotClosed(slot({ receiptSkipped: true }))).toBe(true);
    });
});
