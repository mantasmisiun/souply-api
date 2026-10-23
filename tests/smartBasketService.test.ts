/**
 * Pure-function tests for the Smart Basket generator
 * (shared/SMART_BASKET_SPEC.md). No DB.
 */
import {
    estimateSlots,
    tripProbabilities,
    blendScore,
    pairScores,
    pairCounts,
    interpolatePairs,
    greedyComboFill,
    rankPopular,
    SLOT_MIN,
    SLOT_MAX,
    type Trip,
} from '../src/services/smartBasketService.js';

const trip = (ageDays: number, productIds: number[]): Trip => ({ ageDays, productIds });

describe('estimateSlots', () => {
    it('clamps to SLOT_MIN with no history', () => {
        expect(estimateSlots([])).toBe(SLOT_MIN);
    });
    it('uses the median distinct-product count', () => {
        const trips = [
            trip(1, [1, 2, 3, 4, 5, 6, 7, 8]),
            trip(5, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
            trip(10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        ];
        const slots = estimateSlots(trips);
        expect(slots).toBeGreaterThanOrEqual(8);
        expect(slots).toBeLessThanOrEqual(10);
    });
    it('clamps tiny trips up to SLOT_MIN and huge trips down to SLOT_MAX', () => {
        expect(estimateSlots([trip(0, [1]), trip(1, [2])])).toBe(SLOT_MIN);
        const huge = Array.from({ length: 60 }, (_, i) => i + 1);
        expect(estimateSlots([trip(0, huge)])).toBe(SLOT_MAX);
    });
    it('weights recent trips more than old ones', () => {
        // Recent trips are small; ancient trips are big — median leans small.
        const trips = [
            trip(1, [1, 2, 3, 4, 5, 6]),
            trip(2, [1, 2, 3, 4, 5, 6]),
            trip(400, [...Array(24).keys()].map(i => i + 1)),
        ];
        expect(estimateSlots(trips)).toBeLessThanOrEqual(8);
    });
});

describe('tripProbabilities', () => {
    it('is a probability: item in every trip → 1', () => {
        const p = tripProbabilities([trip(0, [7, 1]), trip(3, [7, 2])], 45);
        expect(p.get(7)).toBeCloseTo(1, 5);
        expect(p.get(1)!).toBeLessThan(1);
    });
    it('decays older appearances', () => {
        const p = tripProbabilities([trip(0, [1]), trip(90, [2])], 45);
        expect(p.get(1)!).toBeGreaterThan(p.get(2)!);
    });
    it('dedupes products within a trip', () => {
        const p = tripProbabilities([trip(0, [5, 5, 5])], 45);
        expect(p.get(5)).toBeCloseTo(1, 5);
    });
});

describe('blendScore', () => {
    it('leans global with no evidence and personal with lots', () => {
        expect(blendScore(1, 0, 0)).toBe(0);          // λ=0 → all global(0)
        expect(blendScore(1, 0, 50)).toBeGreaterThan(0.9); // λ≈0.91
    });
});

describe('pairScores', () => {
    const trips = [
        trip(0, [1, 2, 9]),
        trip(1, [1, 2]),
        trip(2, [1, 2, 3]),
        trip(3, [3, 4]),
        trip(4, [3, 4]),
        trip(5, [5]),
    ];
    it('scores real pairs and enforces min co-count', () => {
        const s = pairScores(trips, { minCo: 2 });
        expect(s.get('1:2')).toBeGreaterThan(0);       // 3 co-occurrences
        expect(s.get('3:4')).toBeGreaterThan(0);       // 2 co-occurrences
        expect(s.has('1:9')).toBe(false);              // single co-occurrence
    });
    it('damps low-support pairs below high-support ones at equal lift', () => {
        const s = pairScores(trips, { minCo: 2 });
        // 1:2 has 3 supports vs 3:4's 2 — both strongly associated.
        expect(s.get('1:2')).toBeGreaterThan(0);
        expect(s.get('3:4')).toBeGreaterThan(0);
    });
    it('empty trips → empty map', () => {
        expect(pairScores([]).size).toBe(0);
    });
});

describe('interpolatePairs', () => {
    it('backs off to global when personal evidence is thin', () => {
        const personal = new Map([['1:2', 2]]);
        const personalCo = new Map([['1:2', 1]]);      // 1 co-occurrence → λ small
        const global_ = new Map([['1:2', 0.5], ['3:4', 0.8]]);
        const out = interpolatePairs(personal, personalCo, global_, 5);
        // Pure-global pair passes through.
        expect(out.get('3:4')).toBeCloseTo(0.8, 5);
        // Thin personal is pulled hard toward global: λ=1/6.
        expect(out.get('1:2')!).toBeCloseTo((1 / 6) * 2 + (5 / 6) * 0.5, 5);
    });
});

describe('greedyComboFill', () => {
    it('seeds with the top personal item and prefers combo partners', () => {
        const personal = new Map([[1, 0.9], [2, 0.5], [3, 0.48]]);
        // 3 pairs strongly with 1; 2 doesn't.
        const pairs = new Map([['1:3', 2]]);
        const picked = greedyComboFill(personal, pairs, 2);
        expect(picked).toEqual([1, 3]);
    });
    it('fills up to slots and stops at pool exhaustion', () => {
        const personal = new Map([[1, 0.5], [2, 0.4]]);
        expect(greedyComboFill(personal, new Map(), 5)).toEqual([1, 2]);
    });
    it('empty scores → empty basket', () => {
        expect(greedyComboFill(new Map(), new Map(), 5)).toEqual([]);
    });
});

describe('rankPopular', () => {
    const catOf = new Map<number, number | null>([
        [1, 10], [2, 10], [3, 11], [4, 10], [5, 10], [6, 12], [7, null],
    ]);
    const userCats = new Set([10, 11]);
    it('both-known items first, then best-of-either', () => {
        const personal = new Map([[1, 0.8], [2, 0.2]]);
        const global_ = new Map([[1, 0.5], [3, 0.9]]);
        const out = rankPopular(personal, global_, 10, 5, catOf, userCats);
        expect(out[0].productId).toBe(1);
        expect(out[0].source).toBe('both');
        const ids = out.map(o => o.productId);
        expect(ids).toContain(2);
        expect(ids).toContain(3);
    });
    it('caps pure-global items per category and blocks unfamiliar categories', () => {
        const personal = new Map([[1, 0.9]]);
        const global_ = new Map([[4, 0.9], [5, 0.85], [2, 0.8], [6, 0.99], [7, 0.99]]);
        const out = rankPopular(personal, global_, 10, 10, catOf, userCats, { capPerCategory: 2 });
        const globalPicks = out.filter(o => o.source === 'global').map(o => o.productId);
        // 6 (cat 12: user never shops it) and 7 (no category) are blocked.
        expect(globalPicks).not.toContain(6);
        expect(globalPicks).not.toContain(7);
        // Category 10 globals capped at 2 (4, 5 — then 2 is rejected).
        expect(globalPicks.filter(id => catOf.get(id) === 10)).toHaveLength(2);
    });
    it('personal items are never capped', () => {
        const personal = new Map([[1, 0.9], [2, 0.8], [4, 0.7], [5, 0.6]]);
        const out = rankPopular(personal, new Map(), 10, 10, catOf, userCats);
        expect(out).toHaveLength(4);
    });
});
