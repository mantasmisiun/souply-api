import { wilsonLowerBound } from '../src/utils/wilson.js';
import { MatchThresholds } from '../src/config/matchThresholds.js';

const Z = MatchThresholds.wilsonZ;

describe('wilsonLowerBound', () => {
    it('returns 0 for 0 trials', () => expect(wilsonLowerBound(0, 0, Z)).toBe(0));

    it('returns high lower bound for large unanimous positive sample', () => {
        const lb = wilsonLowerBound(20, 20, Z);
        expect(lb).toBeGreaterThan(0.8);
    });

    it('returns low lower bound for 50/50 split', () => {
        const lb = wilsonLowerBound(5, 10, Z);
        expect(lb).toBeLessThan(0.5);
    });

    it('is conservative with small samples (3/3 does not reach 0.80)', () => {
        // Wilson CI is wide for n=3; unanimous agreement still only gives lb≈0.44.
        // This is intentional — promotes require sustained signal, not a single user.
        const lb = wilsonLowerBound(3, 3, Z);
        expect(lb).toBeLessThan(MatchThresholds.promoteIdentical.minWilsonLower);
    });
});

describe('promote threshold', () => {
    it('promotes when 20 identical votes unanimously agree', () => {
        const votes = 20;
        const lb = wilsonLowerBound(votes, votes, Z);
        expect(votes).toBeGreaterThanOrEqual(MatchThresholds.promoteIdentical.minVotes);
        expect(lb).toBeGreaterThanOrEqual(MatchThresholds.promoteIdentical.minWilsonLower);
    });

    it('does not promote with 2 identical out of 3 total', () => {
        const lb = wilsonLowerBound(2, 3, Z);
        expect(lb).toBeLessThan(MatchThresholds.promoteIdentical.minWilsonLower);
    });
});

describe('demote threshold', () => {
    it('demotes when 3 votes are all different (identical lb reaches 0)', () => {
        const lb = wilsonLowerBound(0, 3, Z);
        expect(3).toBeGreaterThanOrEqual(MatchThresholds.demoteIdentical.minVotes);
        expect(lb).toBeLessThanOrEqual(MatchThresholds.demoteIdentical.maxWilsonLower);
    });
});
