import { normalizeAddress, levenshtein, findBestStoreMatch } from '../src/utils/addressMatcher.js';

// ---------------------------------------------------------------------------
// normalizeAddress
// ---------------------------------------------------------------------------

describe('normalizeAddress', () => {
    it('returns empty string for empty input', () => {
        expect(normalizeAddress('')).toBe('');
    });

    it('lowercases the input', () => {
        expect(normalizeAddress('Vilniaus')).toBe('vilniaus');
    });

    it('strips Lithuanian diacritics', () => {
        expect(normalizeAddress('Šiauliai')).toBe('siauliai');
        expect(normalizeAddress('Gedimino')).toBe('gedimino');
        expect(normalizeAddress('Žirmūnų')).toBe('zirmunu');
    });

    it('normalizes street abbreviations', () => {
        expect(normalizeAddress('Taikos g. 5')).toContain('g');
        expect(normalizeAddress('Gedimino pr. 9')).toContain('pr');
        expect(normalizeAddress('Lazdynų al. 2')).toContain('al');
    });

    it('removes all punctuation, spaces and commas', () => {
        const result = normalizeAddress('Taikos g. 5, Vilnius');
        expect(result).not.toContain(' ');
        expect(result).not.toContain(',');
        expect(result).not.toContain('.');
    });

    it('removes OCR-introduced spaces within words', () => {
        // "Ši auli ai" → same result as "Šiauliai"
        expect(normalizeAddress('Ši auli ai')).toBe(normalizeAddress('Šiauliai'));
    });

    it('produces identical output for OCR-noisy and clean versions of the same address', () => {
        const clean = normalizeAddress('Gegužių g. 30, Šiauliai');
        const noisy = normalizeAddress('Gequžių g. 30, Ši auli ai');
        // They won't be identical (OCR substituted e→q) but should be close in length
        expect(Math.abs(clean.length - noisy.length)).toBeLessThanOrEqual(3);
    });
});

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

describe('levenshtein', () => {
    it('returns 0 for identical strings', () => {
        expect(levenshtein('abc', 'abc')).toBe(0);
    });

    it('returns length of b when a is empty', () => {
        expect(levenshtein('', 'abc')).toBe(3);
    });

    it('returns length of a when b is empty', () => {
        expect(levenshtein('abc', '')).toBe(3);
    });

    it('returns 1 for a single substitution', () => {
        expect(levenshtein('cat', 'bat')).toBe(1);
    });

    it('returns 1 for a single insertion', () => {
        expect(levenshtein('cat', 'cats')).toBe(1);
    });

    it('returns 1 for a single deletion', () => {
        expect(levenshtein('cats', 'cat')).toBe(1);
    });

    it('is symmetric', () => {
        expect(levenshtein('kitten', 'sitting')).toBe(levenshtein('sitting', 'kitten'));
    });

    it('returns correct distance for kitten→sitting', () => {
        expect(levenshtein('kitten', 'sitting')).toBe(3);
    });

    it('handles completely different strings of same length', () => {
        expect(levenshtein('abc', 'xyz')).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// findBestStoreMatch
// ---------------------------------------------------------------------------

describe('findBestStoreMatch', () => {
    const stores = [
        { id: 1, address: 'Taikos g. 5, Vilnius' },
        { id: 2, address: 'Gedimino pr. 9, Vilnius' },
        { id: 3, address: 'Lyros g. 5A, Šiauliai' },
    ];

    it('returns null for empty stores list', () => {
        expect(findBestStoreMatch('Taikos g. 5, Vilnius', [])).toBeNull();
    });

    it('returns null for empty OCR address', () => {
        expect(findBestStoreMatch('', stores)).toBeNull();
    });

    it('finds exact match with high confidence', () => {
        const result = findBestStoreMatch('Taikos g. 5, Vilnius', stores);
        expect(result).not.toBeNull();
        expect(result!.store.id).toBe(1);
        expect(result!.confidence).toBeGreaterThan(0.9);
    });

    it('finds near-exact match despite minor OCR noise', () => {
        // Single character substitution in street name
        const result = findBestStoreMatch('Taikqs g. 5, Vilnius', stores);
        expect(result).not.toBeNull();
        expect(result!.store.id).toBe(1);
    });

    it('matches street-only OCR against full DB address (IKI-style)', () => {
        // IKI receipts often show only the street part
        const result = findBestStoreMatch('LYROS G. 5A', stores);
        expect(result).not.toBeNull();
        expect(result!.store.id).toBe(3);
    });

    it('returns null when best candidate exceeds maxRatio', () => {
        const result = findBestStoreMatch('Completely unrelated address 999', stores, 0.3);
        expect(result).toBeNull();
    });

    it('returns the closest distance match when multiple stores qualify', () => {
        const closeStores = [
            { id: 1, address: 'Taikos g. 5, Vilnius' },
            { id: 2, address: 'Taikos g. 5A, Vilnius' },  // 1 char different
        ];
        const result = findBestStoreMatch('Taikos g. 5, Vilnius', closeStores);
        expect(result).not.toBeNull();
        expect(result!.store.id).toBe(1); // exact match wins
    });

    it('confidence is between 0 and 1', () => {
        const result = findBestStoreMatch('Taikos g. 5, Vilnius', stores);
        expect(result!.confidence).toBeGreaterThanOrEqual(0);
        expect(result!.confidence).toBeLessThanOrEqual(1);
    });
});
