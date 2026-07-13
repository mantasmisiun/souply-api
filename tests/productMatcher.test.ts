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

// ---------------------------------------------------------------------------
// OCR space-split heal + token-set subset + anchored abbreviation.
// Receipt-203 canary: ML Kit split "KIAULIENA" → "KIAUL IENA" and the trailing
// "R" abbreviates "riebumas". The real catalog SKU #60946 must win over the
// minted orphan and the wrong-variant price-twins #60808/#60816. Mirrors the
// off-DB `receipts:matchaudit --assert` check as a fast unit regression guard.
// ---------------------------------------------------------------------------
describe('findBestProductMatches — OCR split-word heal + subset + abbrev (receipt-203)', () => {
    const OCR = 'IKI SMULKINTA KIAUL IENA R';
    const GOOD = makeCandidate({ id: 60946, storeProductName: 'Smulkinta kiauliena riebumas ne did./kaip 20% dujose, IKI', isCatalog: true });
    const ORPHAN = makeCandidate({ id: 97818, storeProductName: 'IKI SMULKINTA KIAUL IENA R', isCatalog: false });
    const VAR_BEEF = makeCandidate({ id: 60808, storeProductName: 'Smulkinta maišyta kiauliena ir/jautiena dujose, IKI', isCatalog: true });
    const VAR_35 = makeCandidate({ id: 60816, storeProductName: 'Smulkinta kiauliena riebumas ne didesnis kaip 35%', isCatalog: true });
    const UNREL = makeCandidate({ id: 53076, storeProductName: 'Šaldyti žuvų piršteliai VIČI', isCatalog: true });

    it('heals the OCR split and surfaces the real catalog SKU at auto-apply grade', () => {
        const r = findBestProductMatches(OCR, null, 'vnt', [ORPHAN, VAR_BEEF, VAR_35, GOOD, UNREL]);
        const good = r.find(m => m.storeProductId === 60946);
        expect(good).toBeDefined();                          // scored 0 (absent) before the fix
        expect(good!.confidence).toBeGreaterThanOrEqual(0.85); // full content-word coverage → auto-apply
    });

    it('ranks the catalog SKU first — orphan loses the catalog tiebreak, brand+abbrev beat the price-twins', () => {
        const r = findBestProductMatches(OCR, null, 'vnt', [ORPHAN, VAR_BEEF, VAR_35, GOOD, UNREL]);
        expect(r[0].storeProductId).toBe(60946);
    });

    it('does not heal/subset-match an unrelated catalog product (no shared significant token)', () => {
        expect(findBestProductMatches(OCR, null, 'vnt', [UNREL])).toEqual([]);
    });
});

// receipt-292: a DESTROYED name whose only significant token is a single common word must
// NOT auto-apply to a much-more-specific product it has no evidence for. "IKI LEDO F"
// (real: IKI ledo kubeliai / ice cubes) subset-matched "Ledo kubelių formelė, 3 dizainų"
// (the mold) — the one shared word "ledo" + the single-letter "F"→"Formelė" abbrev pushed
// it to 0.97 S1. The under-determined cap holds it below the 0.85 auto-apply band so it
// becomes a human swipe. Contrast receipt-203 (two significant base tokens) where the same
// single-letter abbrev is a legitimate tiebreak and MUST stay confident (canary above).
describe('findBestProductMatches — under-determined single-token subset (receipt-292)', () => {
    const MOLD = makeCandidate({ id: 60055, storeProductName: 'Ledo kubelių formelė, 3 dizainų', isCatalog: true });
    const BOOK = makeCandidate({ id: 53777, storeProductName: 'Knyga LEDO ŠALIS. SPALVINK PAGAL PAVYZDĮ', isCatalog: true });

    it('does not auto-apply — the single shared "ledo" + "F"→"Formelė" stays below S1', () => {
        const r = findBestProductMatches('IKI LEDO F', null, null, [MOLD, BOOK]);
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].confidence).toBeLessThan(0.85);   // needs-human band, not a confident wrong link
    });
});

// ---------------------------------------------------------------------------
// OCR confusion-weighted char rescue (ocrConfusions.ts): a name garbled by VISUAL
// OCR confusions (digit↔letter, ll↔ti) matches its in-catalog product, gated so a
// genuinely-different name sharing packaging tokens can NOT be nudged over the floor.
// ---------------------------------------------------------------------------
describe('findBestProductMatches — OCR confusion-weighted char rescue', () => {
    const BASMATI = makeCandidate({ id: 800, storeProductName: 'Skanėja ryžiai basmati', isCatalog: true });
    const BANANAS = makeCandidate({ id: 801, storeProductName: 'Bananai', isCatalog: true });

    it('rescues a digit/visual-garbled name onto its real catalog product', () => {
        // "SKANĖJA RYŽIAI BASMATI" OCR'd "SKANĖ JA RYZ14 BAsMall" (1←i, 4←a, ll←ti). Plain
        // char sim ~0.75 ≥ rescue gate → the confusion weighting lifts it over the char floor.
        const r = findBestProductMatches('SKANĖ JA RYZ14 BAsMall', null, null, [BASMATI, BANANAS]);
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].storeProductId).toBe(800);
    });

    it('does NOT rescue a genuinely-different name sharing only packaging tokens (apples≠potatoes)', () => {
        // apples-OCR vs potatoes: plain sim ~0.58 < the rescue gate → weighting can't nudge it.
        const potatoes = makeCandidate({ id: 802, storeProductName: 'Fasuotos bulvės LAURA IKI ŪKIS', isCatalog: true });
        expect(findBestProductMatches('Fasuoti obuol ia1 IKI OKIS', null, 'kg', [potatoes])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Learned receipt-name aliases (Issue H vocabulary): a CANONICAL alias is scored
// as an additional match target, so a garbled OCR line matches the way the chain
// prints the SP even when the catalog name alone wouldn't.
// ---------------------------------------------------------------------------
describe('findBestProductMatches — canonical receipt-name aliases (Issue H)', () => {
    const OTHER = makeCandidate({ id: 701, storeProductName: 'Pienas Dvaras 2.5% 1L', isCatalog: true });

    it('matches via a canonical alias when the catalog name alone does not', () => {
        // Catalog name is unrelated to the query; only the learned alias (how the chain
        // prints it on receipts) matches. Aliases are stored already-normalized.
        const aliased = makeCandidate({
            id: 700,
            storeProductName: 'Nesusijęs katalogo pavadinimas XYZ',
            isCatalog: true,
            aliases: ['troskinta kiauliena dujose'],
        });
        const r = findBestProductMatches('TROSKINTA KIAULIENA DUJOSE', null, 'vnt', [aliased, OTHER]);
        expect(r[0]?.storeProductId).toBe(700);
        expect(r[0]!.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('an empty / absent alias list behaves exactly like before', () => {
        const a = findBestProductMatches('Pienas Dvaras', null, null, [OTHER]);
        const b = findBestProductMatches('Pienas Dvaras', null, null, [{ ...OTHER, aliases: [] }]);
        expect(b[0]?.storeProductId).toBe(a[0]?.storeProductId);
    });

    it('does not match via an alias that shares no significant token with the query', () => {
        const aliased = makeCandidate({
            id: 702,
            storeProductName: 'Nesusijęs XYZ',
            isCatalog: true,
            aliases: ['pienas dvaras'],
        });
        // Query unrelated to both the catalog name and the alias → no match.
        expect(findBestProductMatches('Bananai Chiquita', null, null, [aliased])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// H3 vocabulary signals: a REJECTED alias suppresses a known-wrong match, and a
// SIMILARITY alias hard-scopes matching to that SP's L2 family.
// ---------------------------------------------------------------------------
describe('findBestProductMatches — H3 vocabulary signals (rejected-suppress + L2-scope)', () => {
    it('suppresses a candidate whose REJECTED alias matches the query', () => {
        const sp = makeCandidate({ id: 800, storeProductName: 'Pienas Dvaras', isCatalog: true, rejectedAliases: ['pienas dvaras'] });
        // The catalog name matches perfectly, but the (OCR, SP) combo was voted 'different'.
        expect(findBestProductMatches('Pienas Dvaras', null, null, [sp])).toEqual([]);
    });

    it("scopes matching to the similarity-aliased SP's L2 (excludes other L2 families)", () => {
        const scoper  = makeCandidate({ id: 810, storeProductName: 'garbled mince xx', isCatalog: true, categoryL2Name: 'Meat',  categoryName: 'Mince',    similarityAliases: ['garbled mince xx'] });
        const sibling = makeCandidate({ id: 811, storeProductName: 'garbled mince xx', isCatalog: true, categoryL2Name: 'Meat',  categoryName: 'Sausages' });
        const otherL2 = makeCandidate({ id: 812, storeProductName: 'garbled mince xx', isCatalog: true, categoryL2Name: 'Dairy', categoryName: 'Milk' });
        const ids = findBestProductMatches('garbled mince xx', null, null, [scoper, sibling, otherL2]).map(m => m.storeProductId);
        expect(ids).toContain(811);      // same L2 as the similarity scoper → eligible
        expect(ids).not.toContain(812);  // different L2 → scoped out
    });

    it('no similarity alias → no scoping (all L2 families eligible — the no-op default)', () => {
        const a = makeCandidate({ id: 820, storeProductName: 'garbled mince xx', isCatalog: true, categoryL2Name: 'Meat' });
        const b = makeCandidate({ id: 821, storeProductName: 'garbled mince xx', isCatalog: true, categoryL2Name: 'Dairy' });
        const ids = findBestProductMatches('garbled mince xx', null, null, [a, b]).map(m => m.storeProductId);
        expect(ids).toContain(820);
        expect(ids).toContain(821);      // no scope → Dairy NOT excluded
    });
});

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

// ---------------------------------------------------------------------------
// findBestProductMatches — fat-% / variant-number disambiguation (receipt-218)
// ---------------------------------------------------------------------------

describe('findBestProductMatches — variant number disambiguation', () => {
    const Z9 = makeCandidate({ id: 66841, storeProductName: 'ŽEMAITIJOS varškė 9% rieb.' });
    const ZDESSERT = makeCandidate({ id: 63859, storeProductName: 'Desertinė varškė (plombyro skonio, 7,7% rieb.) ŽEMAITIJOS' });
    const ZLIESA = makeCandidate({ id: 67708, storeProductName: 'Varškė liesa ŽEMAITIJOS 0,5% rieb.' });

    it('a "9%" query prefers the 9% variant over the 7,7% dessert and 0,5% liesa (no more 3-way tie)', () => {
        const m = findBestProductMatches('ZEMAITIJOS VARSKE, 9% RIE', null, null, [ZDESSERT, Z9, ZLIESA], 0.4, 5, null);
        expect(m[0].storeProductId).toBe(66841);
        const z9 = m.find(x => x.storeProductId === 66841)!;
        const dessert = m.find(x => x.storeProductId === 63859);
        if (dessert) expect(z9.confidence).toBeGreaterThan(dessert.confidence);
    });

    it('rejects a different-flavour, different-% product (5% peach-passionfruit ≠ 2,5% peach-apricot)', () => {
        const APRICOT = makeCandidate({ id: 23106, storeProductName: 'Jogurtas su persik., abrik. JO, 2,5 %' });
        const m = findBestProductMatches('Jogurtas 5% persik-pasifl.', null, null, [APRICOT], 0.4, 5, null);
        expect(m.find(x => x.storeProductId === 23106)).toBeUndefined();
    });

    it('does NOT penalise when the query has no number (OCR dropped the %)', () => {
        const m = findBestProductMatches('ZEMAITIJOS VARSKE', null, null, [Z9], 0.4, 5, null);
        expect(m.find(x => x.storeProductId === 66841)).toBeTruthy();
    });
});
