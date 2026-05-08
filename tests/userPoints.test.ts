import { cumulativePointsForLevel, levelForPoints, levelProgress } from '../src/services/userPointsService.js';

describe('cumulativePointsForLevel', () => {
    it('returns correct cumulative thresholds', () => {
        expect(cumulativePointsForLevel(1)).toBe(10);
        expect(cumulativePointsForLevel(2)).toBe(30);
        expect(cumulativePointsForLevel(3)).toBe(60);
        expect(cumulativePointsForLevel(4)).toBe(100);
        expect(cumulativePointsForLevel(5)).toBe(150);
    });
});

// Level boundaries: L1=0-10, L2=11-30, L3=31-60, L4=61-100, L5=101-150
describe('levelForPoints', () => {
    it('places 0 points at level 1', () => expect(levelForPoints(0)).toBe(1));
    it('places 10 points at level 1 (inclusive boundary)', () => expect(levelForPoints(10)).toBe(1));
    it('places 11 points at level 2', () => expect(levelForPoints(11)).toBe(2));
    it('places 30 points at level 2 (inclusive boundary)', () => expect(levelForPoints(30)).toBe(2));
    it('places 31 points at level 3', () => expect(levelForPoints(31)).toBe(3));
    it('places 60 points at level 3 (inclusive boundary)', () => expect(levelForPoints(60)).toBe(3));
    it('places 61 points at level 4', () => expect(levelForPoints(61)).toBe(4));
    it('places 100 points at level 4 (inclusive boundary)', () => expect(levelForPoints(100)).toBe(4));
    it('places 101 points at level 5', () => expect(levelForPoints(101)).toBe(5));
});

describe('levelProgress', () => {
    it('returns correct fraction at level 1 midpoint (5 pts)', () => {
        const p = levelProgress(5);
        expect(p.level).toBe(1);
        expect(p.pointsIntoLevel).toBe(5);
        expect(p.pointsNeededForNext).toBe(10);
        expect(p.progressFraction).toBeCloseTo(0.5);
    });

    it('returns fraction 1.0 at L1 boundary (10 pts)', () => {
        const p = levelProgress(10);
        expect(p.level).toBe(1);
        expect(p.progressFraction).toBeCloseTo(1.0);
    });

    it('returns small fraction at L2 start (11 pts)', () => {
        const p = levelProgress(11);
        expect(p.level).toBe(2);
        expect(p.pointsIntoLevel).toBe(1);
        expect(p.pointsNeededForNext).toBe(20);
        expect(p.progressFraction).toBeCloseTo(1 / 20);
    });

    it('returns fraction 1.0 at L2 boundary (30 pts)', () => {
        const p = levelProgress(30);
        expect(p.level).toBe(2);
        expect(p.progressFraction).toBeCloseTo(1.0);
    });

    it('returns small fraction at L3 start (31 pts)', () => {
        const p = levelProgress(31);
        expect(p.level).toBe(3);
        expect(p.pointsIntoLevel).toBe(1);
        expect(p.pointsNeededForNext).toBe(30);
        expect(p.progressFraction).toBeCloseTo(1 / 30);
    });
});
