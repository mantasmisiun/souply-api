import { normalizeProductName, findBestProductMatches, type MatchCandidate } from '../src/utils/productMatcher.js';

// ---------------------------------------------------------------------------
// normalizeProductName (productMatcher version — receipt-oriented)
// ---------------------------------------------------------------------------

describe('normalizeProductName (productMatcher)', () => {
    it('returns empty string for empty input', () => {
        expect(normalizeProductName('')).toBe('');
    });

    it('lowercases and strips diacritics', () => {
        expect(normalizeProductName('ŠOKOLADAS')).toBe('sokoladas');
    });

    it('replaces dots and slashes with spaces', () => {
        const result = normalizeProductName('nuol. 1.20');
        expect(result).not.toContain('.');
    });

    it('strips Rimi loyalty card mask lines', () => {
        const result = normalizeProductName('XXXXXXXXXXXXXXX9631 Pienas');
        expect(result).not.toContain('xxx');
        expect(result).toContain('pienas');
    });

    it('strips nuol. discount markers', () => {
        // stripReceiptPrefixes now runs on the raw string before dots/commas
        // are normalised away, so the pattern fires correctly.
        expect(normalizeProductName('Pienas nuol. -1,20').trim()).toBe('pienas');
    });

    it('strips galut. kaina markers', () => {
        expect(normalizeProductName('Pienas galut. kaina 2,27').trim()).toBe('pienas');
    });

    it('strips sutaupete markers', () => {
        expect(normalizeProductName('Sutaupete: Pienas').trim()).toBe('pienas');
    });

    it('strips deposit (pet depozitinis) markers', () => {
        expect(normalizeProductName('Vanduo pet (depozitinis) 0,10 eur 0,10').trim()).toBe('vanduo');
    });
});

// ---------------------------------------------------------------------------
// findBestProductMatches
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<MatchCandidate> & { id: number; storeProductName: string }): MatchCandidate {
    return {
        productId: overrides.id,
        categoryId: 1,
        categoryName: null,
        categoryL2Name: null,
        brandName: null,
        amount: null,
        unit: null,
        isWeighable: false,
        imageUrl: null,
        ...overrides,
    };
}

const MILK = makeCandidate({ id: 1, storeProductName: 'Pienas Dvaras 2.5% 1L' });
const CHEESE = makeCandidate({ id: 2, storeProductName: 'Sūris Džiugas 200g' });
const JUICE = makeCandidate({ id: 3, storeProductName: 'Sultys Aronija 1L' });
const MILK_1KG = makeCandidate({ id: 4, storeProductName: 'Pienas Žemaitijos 2.5% 1L', amount: 1, unit: 'l' });

describe('findBestProductMatches', () => {
    it('returns empty array for empty candidates', () => {
        expect(findBestProductMatches('Pienas', null, null, [])).toEqual([]);
    });

    it('returns empty array when OCR name is empty', () => {
        expect(findBestProductMatches('', null, null, [MILK, CHEESE])).toEqual([]);
    });

    it('finds the best match for a clean OCR name', () => {
        const results = findBestProductMatches('Pienas Dvaras', null, null, [MILK, CHEESE, JUICE]);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].storeProductId).toBe(1);
    });

    it('returns results sorted by confidence descending', () => {
        const results = findBestProductMatches('Pienas Dvaras', null, null, [MILK, CHEESE, JUICE, MILK_1KG]);
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
        }
    });

    it('respects minConfidence threshold — low confidence candidates excluded', () => {
        const results = findBestProductMatches('Pienas', null, null, [CHEESE, JUICE], 0.9);
        expect(results).toEqual([]);
    });

    it('respects topN limit', () => {
        const candidates = [MILK, CHEESE, JUICE, MILK_1KG];
        const results = findBestProductMatches('Pienas', null, null, candidates, 0.1, 2);
        expect(results.length).toBeLessThanOrEqual(2);
    });

    it('catalog-first tiebreak: a scraped catalog SKU outranks a same-name receipt-minted orphan', () => {
        // Both score identically on name; the orphan (isCatalog false) must NOT out-rank
        // the real catalog SKU (isCatalog true) — a re-scanned garbled orphan can score
        // marginally higher in the wild, so within the margin the catalog wins.
        const orphan  = makeCandidate({ id: 97654, storeProductName: 'Atlantines lasisos', isCatalog: false });
        const catalog = makeCandidate({ id: 58876, storeProductName: 'Atlantines lasisos', isCatalog: true });
        const results = findBestProductMatches('Atlantines lasisos', null, null, [orphan, catalog]);
        expect(results[0].storeProductId).toBe(58876);
    });

    it('boosts confidence when amount and unit match', () => {
        // Query has token "Extra" which fuzzy-matches "Ekstra" below the
        // exact-match threshold, so the base confidence is below 1.0 and
        // the +0.15 amount-match boost can visibly raise it.
        const withAmount = makeCandidate({ id: 10, storeProductName: 'Pienas Dvaras Ekstra', amount: 1, unit: 'l' });
        const noAmount   = makeCandidate({ id: 11, storeProductName: 'Pienas Dvaras Ekstra' });
        const withBoost    = findBestProductMatches('Pienas Dvaras Extra', 1, 'l', [withAmount], 0.1);
        const withoutBoost = findBestProductMatches('Pienas Dvaras Extra', 1, 'l', [noAmount], 0.1);
        const boostedConf   = withBoost[0]?.confidence ?? 0;
        const unboostedConf = withoutBoost[0]?.confidence ?? 0;
        expect(boostedConf).toBeGreaterThan(unboostedConf);
    });

    it('penalises confidence when amount mismatches', () => {
        const wrongSize = makeCandidate({ id: 20, storeProductName: 'Pienas Dvaras', amount: 2, unit: 'l' });
        const noSize = makeCandidate({ id: 21, storeProductName: 'Pienas Dvaras' });
        const withMismatch = findBestProductMatches('Pienas Dvaras', 1, 'l', [wrongSize], 0.1);
        const withoutSize  = findBestProductMatches('Pienas Dvaras', 1, 'l', [noSize], 0.1);
        const mismatchConf = withMismatch[0]?.confidence ?? 1;
        const noSizeConf   = withoutSize[0]?.confidence ?? 0;
        expect(mismatchConf).toBeLessThan(noSizeConf);
    });

    it('confidence is rounded to 2 decimal places', () => {
        const results = findBestProductMatches('Pienas Dvaras', null, null, [MILK]);
        if (results.length > 0) {
            const c = results[0].confidence;
            expect(c).toBe(Math.round(c * 100) / 100);
        }
    });

    it('handles OCR-noisy input with character substitution', () => {
        // "Pienas Dvaras" with 1 char swapped
        const results = findBestProductMatches('Pienqs Dvaras', null, null, [MILK, CHEESE, JUICE]);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].storeProductId).toBe(1);
    });
});

describe('findBestProductMatches — anchor-token gate (Airanas/Šafranas regression)', () => {
    const SAFRANAS = makeCandidate({ id: 50, productId: 5125, storeProductName: 'Šafranas KOTANYI', amount: 0.01, unit: 'g' });
    const AIRANAS = makeCandidate({ id: 51, productId: 600, storeProductName: 'Airanas DVARO' });

    it('does NOT cluster "Airanas" into "Šafranas KOTANYI" (the €230 incident)', () => {
        // single-token "airanas" is only 0.75 char-similar to "safranas" —
        // exactly the short-name, similar-ending false positive the gate kills.
        const matches = findBestProductMatches('Airanas', null, 'vnt', [SAFRANAS]);
        expect(matches).toHaveLength(0);
    });

    it('still matches "Airanas" to a real airanas product (exact token present)', () => {
        const matches = findBestProductMatches('Airanas', null, 'vnt', [SAFRANAS, AIRANAS]);
        expect(matches.map(m => m.storeProductId)).toEqual([51]); // saffron excluded
    });

    it('preserves the OCR split-word rescue (near-identical chars bypass the gate)', () => {
        // "sok oladas" → "sokoladas": different tokens but identical characters.
        const SOK = makeCandidate({ id: 60, productId: 700, storeProductName: 'Šokoladas' });
        const matches = findBestProductMatches('Sok oladas', null, null, [SOK]);
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].storeProductId).toBe(60);
    });
});

describe('findBestProductMatches — weighable gate', () => {
    const LOOSE = makeCandidate({ id: 70, storeProductName: 'Raudonosios paprikos', isWeighable: true });
    // A genuine FIXED package (concrete 180 g) — stays excluded from a by-weight line.
    const PACKED = makeCandidate({ id: 71, storeProductName: 'Raudonosios paprikos BON VIA, 180 g', isWeighable: false });
    // Pre-packed-BY-WEIGHT produce: flagged isWeighable=0 but NO fixed pack size.
    const PREPACK = makeCandidate({ id: 72, storeProductName: 'Fasuoti obuoliai IKI ŪKIS', isWeighable: false });

    it('by-WEIGHT query drops a FIXED-PACKAGE candidate (180 g)', () => {
        const m = findBestProductMatches('Raudonosios paprikos', null, null, [PACKED, LOOSE], undefined, undefined, true);
        expect(m.map((x) => x.storeProductId)).toEqual([70]); // only the weighable one
    });

    it('by-WEIGHT query KEEPS a packaged-but-NO-fixed-size candidate (fasuoti produce sold per kg)', () => {
        const m = findBestProductMatches('Fasuoti obuoliai IKI ŪKIS', null, null, [PREPACK], undefined, undefined, true);
        expect(m.map((x) => x.storeProductId)).toEqual([72]); // matches despite isWeighable=0
    });

    it('PACKAGED (fixed-size) query drops by-WEIGHT candidates', () => {
        const m = findBestProductMatches('Raudonosios paprikos', 180, 'g', [PACKED, LOOSE], undefined, undefined, false);
        expect(m.map((x) => x.storeProductId)).toEqual([71]);
    });

    it('null gate (legacy) keeps both', () => {
        const m = findBestProductMatches('Raudonosios paprikos', null, null, [PACKED, LOOSE]);
        expect(m.length).toBe(2);
    });
});
