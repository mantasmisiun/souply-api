import { computeNeedsHuman, isCardEligible, type NeedsHumanInput } from '../src/services/queueRanking.js';

const base: NeedsHumanInput = {
    band: 'S3',
    gapToRunnerUp: 0,
    candidateCount: 1,
    hasVeto: false,
    source: 'reused',
    lineTotalEur: 5,
};
const mk = (o: Partial<NeedsHumanInput>) => computeNeedsHuman({ ...base, ...o });

describe('computeNeedsHuman', () => {
    it('S1 (confident) lines are never carded → score 0', () => {
        expect(mk({ band: 'S1' })).toBe(0);
    });

    it('S3 scores higher than S2 for the same line (more uncertain)', () => {
        expect(mk({ band: 'S3' })).toBeGreaterThan(mk({ band: 'S2' }));
    });

    it('a close call (small gap, ≥2 candidates) beats a clear winner', () => {
        const close = mk({ candidateCount: 3, gapToRunnerUp: 0.02 });
        const clear = mk({ candidateCount: 3, gapToRunnerUp: 0.5 });
        expect(close).toBeGreaterThan(clear);
    });

    it('a veto raises the score (the match is independently suspect)', () => {
        expect(mk({ hasVeto: true })).toBeGreaterThan(mk({ hasVeto: false }));
    });

    it('a more expensive line scores higher (bigger price impact)', () => {
        expect(mk({ lineTotalEur: 20 })).toBeGreaterThan(mk({ lineTotalEur: 1 }));
    });

    it('a cheap item still scores > 0 (price floor keeps real ambiguity alive)', () => {
        expect(mk({ lineTotalEur: 0.1 })).toBeGreaterThan(0);
    });

    it('a LONE freshly-created product is damped vs one with real alternatives', () => {
        const lone = mk({ source: 'created', candidateCount: 1 });
        const withAlts = mk({ source: 'created', candidateCount: 3, gapToRunnerUp: 0.02 });
        expect(withAlts).toBeGreaterThan(lone);
    });

    it('score stays within [0,1]', () => {
        const hi = mk({ band: 'S3', candidateCount: 3, gapToRunnerUp: 0, hasVeto: true, lineTotalEur: 100 });
        expect(hi).toBeGreaterThan(0);
        expect(hi).toBeLessThanOrEqual(1);
    });
});

describe('isCardEligible', () => {
    it('S2 and S3 are eligible, S1 is not', () => {
        expect(isCardEligible('S2')).toBe(true);
        expect(isCardEligible('S3')).toBe(true);
        expect(isCardEligible('S1')).toBe(false);
    });
});
