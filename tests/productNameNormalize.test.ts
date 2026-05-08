import { normalizeProductName, nameSimilarity } from '../src/utils/productNameNormalize.js';

// ---------------------------------------------------------------------------
// normalizeProductName
// ---------------------------------------------------------------------------

describe('normalizeProductName (productNameNormalize)', () => {
    it('returns empty string for empty input', () => {
        expect(normalizeProductName('')).toBe('');
    });

    it('lowercases the input', () => {
        expect(normalizeProductName('PIENAS')).toBe('pienas');
    });

    it('strips Lithuanian diacritics', () => {
        expect(normalizeProductName('Šokoladas')).toBe('sokoladas');
        expect(normalizeProductName('Žuvis')).toBe('zuvis');
        expect(normalizeProductName('Ąžuolas')).toBe('azuolas');
    });

    it('removes amount+unit tokens (g, kg, ml, l, vnt)', () => {
        expect(normalizeProductName('Pienas 1 l')).not.toContain('1');
        expect(normalizeProductName('Sūris 200g')).not.toContain('200');
        expect(normalizeProductName('Vanduo 500 ml')).not.toContain('500');
        expect(normalizeProductName('Kiaušiniai 10 vnt')).not.toContain('10');
    });

    it('removes "40 proc" style percentage tokens', () => {
        // "40 proc" ends with a word char so \b matches → token is stripped
        expect(normalizeProductName('Riebalai 40 proc')).not.toContain('40');
    });

    it('does NOT strip "2.5%" — regex \b fails after % at end of string', () => {
        // Known edge case: \b after % (non-word char) does not fire. The %
        // itself is removed by the later [^a-z0-9\s] pass, leaving "2 5".
        const result = normalizeProductName('Pienas 2.5%');
        expect(result).toContain('2');   // digits survive
        expect(result).not.toContain('%'); // but the % is gone
    });

    it('collapses multiple spaces into one', () => {
        expect(normalizeProductName('pienas   dvaras')).toBe('pienas dvaras');
    });

    it('replaces special characters with spaces', () => {
        const result = normalizeProductName('Pienas-Dvaras!');
        expect(result).not.toContain('-');
        expect(result).not.toContain('!');
    });

    it('products with same name but different sizes normalize identically', () => {
        const a = normalizeProductName('Pienas 1 l');
        const b = normalizeProductName('Pienas 2 l');
        expect(a).toBe(b);
    });
});

// ---------------------------------------------------------------------------
// nameSimilarity
// ---------------------------------------------------------------------------

describe('nameSimilarity', () => {
    it('returns 1 for identical names', () => {
        expect(nameSimilarity('Pienas', 'Pienas')).toBe(1);
    });

    it('returns 1 for names that normalize to the same string', () => {
        // Same name, different amounts — amounts are stripped
        expect(nameSimilarity('Pienas 1 l', 'Pienas 2 l')).toBe(1);
    });

    it('returns 0 for empty strings', () => {
        expect(nameSimilarity('', '')).toBe(0);
        expect(nameSimilarity('Pienas', '')).toBe(0);
        expect(nameSimilarity('', 'Pienas')).toBe(0);
    });

    it('returns a value between 0 and 1 for partially similar names', () => {
        const score = nameSimilarity('Pienas Dvaras', 'Pienas Žemaitijos');
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });

    it('is symmetric', () => {
        const ab = nameSimilarity('Sūris', 'Suris skanus');
        const ba = nameSimilarity('Suris skanus', 'Sūris');
        expect(ab).toBeCloseTo(ba, 5);
    });

    it('returns higher score for more similar names', () => {
        const close = nameSimilarity('Pienas Dvaras', 'Pienas Dvara');
        const far   = nameSimilarity('Pienas Dvaras', 'Žuvis Kepta');
        expect(close).toBeGreaterThan(far);
    });

    it('is diacritics-insensitive (ą=a, š=s, etc.)', () => {
        expect(nameSimilarity('Šokoladas', 'Sokoladas')).toBe(1);
    });
});
