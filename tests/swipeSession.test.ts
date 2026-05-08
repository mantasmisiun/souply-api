import { isBurstSwipe, BURST_DWELL_MS, MANDATORY_SWIPES_PER_RECEIPT } from '../src/services/swipeSessionService.js';

describe('isBurstSwipe', () => {
    it('flags swipes under threshold as burst', () => {
        expect(isBurstSwipe(0)).toBe(true);
        expect(isBurstSwipe(999)).toBe(true);
        expect(isBurstSwipe(BURST_DWELL_MS - 1)).toBe(true);
    });

    it('does not flag swipes at or above threshold', () => {
        expect(isBurstSwipe(BURST_DWELL_MS)).toBe(false);
        expect(isBurstSwipe(1500)).toBe(false);
        expect(isBurstSwipe(5000)).toBe(false);
    });
});

describe('constants', () => {
    it('BURST_DWELL_MS is 1000ms', () => expect(BURST_DWELL_MS).toBe(1000));
    it('MANDATORY_SWIPES_PER_RECEIPT is 3', () => expect(MANDATORY_SWIPES_PER_RECEIPT).toBe(3));
});
