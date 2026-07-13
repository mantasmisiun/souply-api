import { weightedLevenshtein } from '../src/utils/ocrConfusions.js';
import { levenshtein } from '../src/utils/addressMatcher.js';

describe('weightedLevenshtein — OCR confusion costs', () => {
    it('digit-for-letter confusions are cheap (ryz14 ≈ ryžiai, folded to ryziai)', () => {
        const w = weightedLevenshtein('ryz14', 'ryziai');
        expect(w).toBeLessThan(1.6);                         // 1→i (.15) + 4→a (.25) + insert i (1)
        expect(w).toBeLessThan(levenshtein('ryz14', 'ryziai')); // strictly better than plain
    });

    it('multi-char visual confusions collapse (basmall ≈ basmati via ll↔ti)', () => {
        expect(weightedLevenshtein('basmall', 'basmati')).toBeLessThan(0.6);
    });

    it('homoglyphs: 0↔o, 5↔s', () => {
        expect(weightedLevenshtein('c0ca', 'coca')).toBeLessThan(0.2);
        expect(weightedLevenshtein('5vie5tas', 'sviestas')).toBeLessThan(0.5);
    });

    it('does NOT collapse genuinely-different names (no false rescue)', () => {
        expect(weightedLevenshtein('bananai', 'pienas')).toBeGreaterThan(4);
        expect(weightedLevenshtein('aaaa', 'bbbb')).toBe(4); // no confusions → full cost
    });

    it('identical / already-folded strings cost 0', () => {
        expect(weightedLevenshtein('pienas', 'pienas')).toBe(0);
        expect(weightedLevenshtein('', 'abc')).toBe(3);
    });
});
