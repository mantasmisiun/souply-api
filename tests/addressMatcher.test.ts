import { normalizeAddress, levenshtein, findBestStoreMatch, extractCity, citySimilarity } from '../src/utils/addressMatcher.js';

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

// ---------------------------------------------------------------------------
// extractCity / citySimilarity
// ---------------------------------------------------------------------------

describe('extractCity', () => {
    it('extracts the city after the last comma, folded to ASCII letters', () => {
        expect(extractCity('Vilniaus g. 128-2, Šiauliai')).toBe('siauliai');
        expect(extractCity('Vilniaus g.62, Ukmergė')).toBe('ukmerge');
    });
    it('folds an OCR-garbled city the same way', () => {
        expect(extractCity("Vilniaus g. l 2, Siau'iai")).toBe('siauiai');
    });
    it('returns empty string when the address has no city (no comma)', () => {
        expect(extractCity('LYROS G. 5A')).toBe('');
        expect(extractCity('')).toBe('');
    });
});

describe('citySimilarity', () => {
    it('scores a garbled-but-correct city high and a different city low', () => {
        expect(citySimilarity('siauiai', 'siauliai')).toBeGreaterThan(0.8);
        expect(citySimilarity('siauiai', 'ukmerge')).toBeLessThan(0.4);
    });
    it('treats an OCR-truncated city as a full match via the prefix bonus', () => {
        expect(citySimilarity('siau', 'siauliai')).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// findBestStoreMatch — city gate (receipt-206 regression)
// ---------------------------------------------------------------------------

describe('findBestStoreMatch city gate', () => {
    // A chain reuses "Vilniaus g." across towns; a garbled house number leaves the
    // Šiauliai receipt's street 1 edit from the Ukmergė branch.
    const ikiStores = [
        { id: 420, address: 'Vilniaus g.62, Ukmergė' },
        { id: 438, address: 'Vilniaus g. 128-2, Šiauliai' },
        { id: 358, address: 'Lyros g. 5A, Šiauliai' },
    ];

    it('picks the correct-city store even when a wrong-city street scores better', () => {
        const result = findBestStoreMatch("Vilniaus g. l 2, Siau'iai", ikiStores);
        expect(result).not.toBeNull();
        expect(result!.store.id).toBe(438); // Šiauliai, not Ukmergė
    });

    it('without the gate (cityGate=0) the wrong-city branch wins — documents the bug', () => {
        const result = findBestStoreMatch("Vilniaus g. l 2, Siau'iai", ikiStores, 0.3, 0);
        expect(result!.store.id).toBe(420); // Ukmergė — the pre-gate behaviour
    });

    it('street-only OCR (no city) is unaffected by the gate', () => {
        const result = findBestStoreMatch('Vilniaus g.62', ikiStores);
        expect(result!.store.id).toBe(420); // no city to gate on → street match stands
    });

    it('rejects everything (null) when the OCR city matches no store town', () => {
        const result = findBestStoreMatch('Vilniaus g. 5, Klaipėda', ikiStores);
        expect(result).toBeNull();
    });
});

// receipt-293: the OCR/parser can emit the address CITY-FIRST ("Šiauliai, Lyros g. 19A-1").
// extractCity only read the last comma-segment, so it grabbed the STREET as the "city" and
// the gate rejected the exact-match store → the map appeared for a store already in the DB.
describe('findBestStoreMatch — order-independent (city-first or -last)', () => {
    const stores = [
        { id: 358, address: 'LYROS G. 5A, Šiauliai' },
        { id: 435, address: 'LYROS G. 19A-1, Šiauliai' },
        { id: 999, address: 'Vilniaus g. 62, Ukmergė' },
        { id: 888, address: 'Vilniaus g. 12, Šiauliai' },
    ];

    it('matches the exact store whether the city is printed first or last', () => {
        expect(findBestStoreMatch('Lyros g. 19A-1, Šiauliai', stores)!.store.id).toBe(435);
        expect(findBestStoreMatch('Šiauliai, Lyros g. 19A-1', stores)!.store.id).toBe(435);
        expect(findBestStoreMatch('Lyros g. 19A-1', stores)!.store.id).toBe(435);
    });

    it('still disambiguates same-street-different-town when the city is first', () => {
        expect(findBestStoreMatch('Šiauliai, Vilniaus g. 12', stores)!.store.id).toBe(888); // not Ukmergė
    });

    it('a bare city part never ties every store in that town at distance 0', () => {
        // "Šiauliai" alone (no street/number) must NOT confidently match a Šiauliai store.
        const r = findBestStoreMatch('Šiauliai', stores);
        expect(r === null || r.confidence < 0.85).toBe(true);
    });
});

// receipt-302: OCR can scramble the WORD ORDER entirely ("36-101, Vilnius auletekio al."
// for "Saulėtekio al. 36-101, Vilnius"), which defeats edit distance on every variant
// pairing. The TOKEN lane accepts when the store's house number appears as an exact token
// AND the street name fuzzy-matches an OCR token — word order becomes irrelevant.
describe('findBestStoreMatch — scrambled word order (token lane)', () => {
    const stores = [
        { id: 367, address: 'SAULĖTEKIO AL. 36-101, Vilnius' },
        { id: 297, address: 'Zarasų g. 5A, Vilnius' },
    ];

    it('matches the fully-scrambled receipt-302 address', () => {
        const r = findBestStoreMatch('36-101, Vilnius auletekio al.', stores);
        expect(r).not.toBeNull();
        expect(r!.store.id).toBe(367);
    });

    it('clean addresses still score a full-confidence edit-lane match', () => {
        expect(findBestStoreMatch('Saulėtekio al. 36-101, Vilnius', stores)!.confidence).toBeCloseTo(1, 2);
    });

    it('an unrelated address still returns null', () => {
        expect(findBestStoreMatch('visiškai kitas adresas 99, Kaunas', stores)).toBeNull();
    });
});
