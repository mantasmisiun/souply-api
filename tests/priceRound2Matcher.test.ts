/**
 * Round-2 (price-based) receipt-product matching.
 *
 * We mock getAsOfDatePricesForCandidates so these tests exercise ONLY the
 * confirm/disambiguate/fail-open logic, not the SQL. Each test feeds a parsed
 * receipt line (with Round-1 `altMatches`) + a stubbed price map and asserts
 * how the line's storeProductId / priceVerified change.
 */
import { jest } from '@jest/globals';

const mockGetAsOfDatePrices = jest.fn<any>();
jest.unstable_mockModule('../src/models/priceModel.js', () => ({
    getAsOfDatePricesForCandidates: mockGetAsOfDatePrices,
}));

const { applyPriceRound2Matching } = await import('../src/services/priceRound2Matcher.js');

const RECEIPT_DATE = new Date('2026-06-11T21:07:00');

beforeEach(() => mockGetAsOfDatePrices.mockReset());

const line = (over: any) => ({
    name: 'NAMINIS PIENAS',
    storeProductId: 100,
    priceVerified: false,
    isWeighable: false,
    unit: 'vnt',
    price: 1.49,
    promoPrice: null,
    pricePerUnit: 1.49,
    altMatches: [],
    ...over,
});

describe('applyPriceRound2Matching', () => {
    it('PACK-SIZE disambiguation (name-TIED): picks the price-matching variant, syncs display', async () => {
        // 3 tied same-name variants; only the 1L SP (101) is priced 1,49.
        const l = line({
            storeProductId: 102, // Round-1 auto-applied the WRONG size (2L)
            matchedName: 'NAMINIS pienas 2L',
            price: 1.49,
            altMatches: [
                { storeProductId: 101, confidence: 0.87, name: 'NAMINIS pienas 1L' }, // 1L
                { storeProductId: 102, confidence: 0.87, name: 'NAMINIS pienas 2L' }, // 2L
                { storeProductId: 103, confidence: 0.85, name: 'NAMINIS pienas 500ml' }, // 500ml
            ],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [101, { price: 1.49, promoPrice: null, promoEnd: null }],
            [102, { price: 2.79, promoPrice: null, promoEnd: null }],
            [103, { price: 0.99, promoPrice: null, promoEnd: null }],
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);

        expect(l.storeProductId).toBe(101);
        expect(l.priceVerified).toBe(true);
        expect(l.matchedName).toBe('NAMINIS pienas 1L'); // display follows the linked SP
        expect(res.confirmed).toBe(1);
        expect(res.overridden).toBe(1); // pick changed 102 → 101
    });

    it('GAP GUARD: does NOT override a confident name pick with a weaker-name price match', async () => {
        // Receipt POMIDORAI #6 regression: 60161 "Lietuviški pomidorai" (conf 1.0,
        // the right product) did NOT price-match, but 60149 "Kekiniai pomidorai"
        // (conf 0.60, a DIFFERENT tomato) did. Must keep 60161, not swap.
        const l = line({
            name: 'LIETUVIŠKI POMIDORAI',
            storeProductId: 60161,
            matchedName: 'Lietuviški pomidorai',
            isWeighable: true, unit: 'kg', price: 2.87, pricePerUnit: 3.99,
            altMatches: [
                { storeProductId: 60161, confidence: 1.0, name: 'Lietuviški pomidorai' },
                { storeProductId: 60149, confidence: 0.6, name: 'Kekiniai pomidorai' },
            ],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [60161, { price: 4.49, promoPrice: null, promoEnd: null }], // ≠ 3.99 → no match
            [60149, { price: 3.99, promoPrice: null, promoEnd: null }], // = 3.99 → matches, but weak name
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);

        expect(l.storeProductId).toBe(60161);        // unchanged
        expect(l.matchedName).toBe('Lietuviški pomidorai');
        expect(l.priceVerified).toBe(false);         // not confirmed (price didn't back the name pick)
        expect(res.confirmed).toBe(0);
        expect(res.overridden).toBe(0);
    });

    it('CLEAN CONFIRM: the current name pick itself price-matches → confirm, no override', async () => {
        const l = line({
            storeProductId: 55852,
            matchedName: 'Rokiškio NAMINIS, 2,5%',
            price: 1.49,
            altMatches: [
                { storeProductId: 55852, confidence: 0.94, name: 'Rokiškio NAMINIS, 2,5%' },
                { storeProductId: 55859, confidence: 0.94, name: 'Rokiškio NAMINIS 2L' },
            ],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [55852, { price: 1.49, promoPrice: null, promoEnd: null }], // current pick matches
            [55859, { price: 2.79, promoPrice: null, promoEnd: null }],
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);

        expect(l.storeProductId).toBe(55852);  // unchanged
        expect(l.priceVerified).toBe(true);    // confirmed
        expect(res.confirmed).toBe(1);
        expect(res.overridden).toBe(0);        // no swap
    });

    it('FAIL-OPEN: no candidate price-matches → Round-1 pick untouched', async () => {
        const l = line({
            storeProductId: 102,
            price: 1.49,
            altMatches: [
                { storeProductId: 101, confidence: 0.87 },
                { storeProductId: 102, confidence: 0.87 },
            ],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [101, { price: 2.79, promoPrice: null, promoEnd: null }],
            [102, { price: 3.49, promoPrice: null, promoEnd: null }],
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);

        expect(l.storeProductId).toBe(102); // unchanged
        expect(l.priceVerified).toBe(false);
        expect(res.confirmed).toBe(0);
    });

    it('WEIGHABLE: compares €/kg (pricePerUnit), NOT the line total', async () => {
        // salmon: line total 18,15 but €/kg 16,99 — only €/kg may match the DB.
        const l = line({
            name: 'ATLANTINĖS LAŠIŠOS',
            storeProductId: 200,
            isWeighable: true,
            unit: 'kg',
            price: 18.15,        // line total — must NOT be used
            pricePerUnit: 16.99, // €/kg — the comparable
            altMatches: [{ storeProductId: 200, confidence: 0.8 }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [200, { price: 16.99, promoPrice: null, promoEnd: null }],
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);

        expect(res.confirmed).toBe(1);
        expect(l.priceVerified).toBe(true);
    });

    it('weighable does NOT confirm when only the line total would match', async () => {
        const l = line({
            isWeighable: true, unit: 'kg', price: 18.15, pricePerUnit: 16.99,
            altMatches: [{ storeProductId: 200, confidence: 0.8 }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [200, { price: 18.15, promoPrice: null, promoEnd: null }], // = the line total
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(res.confirmed).toBe(0);
    });

    it('matches an ACTIVE promo price (promoEnd ≥ receipt date)', async () => {
        const l = line({
            price: 0.99,
            altMatches: [{ storeProductId: 101, confidence: 0.9 }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [101, { price: 1.49, promoPrice: 0.99, promoEnd: new Date('2026-06-20') }],
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(res.confirmed).toBe(1);
        expect(l.storeProductId).toBe(101);
    });

    it('ignores an EXPIRED promo (promoEnd < receipt date)', async () => {
        const l = line({
            storeProductId: 101,
            price: 0.99,
            altMatches: [{ storeProductId: 101, confidence: 0.9 }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [101, { price: 1.49, promoPrice: 0.99, promoEnd: new Date('2026-06-01') }],
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(res.confirmed).toBe(0);
    });

    it('≥2 price-match → highest Round-1 name confidence wins', async () => {
        const l = line({
            storeProductId: 999,
            price: 1.49,
            altMatches: [
                { storeProductId: 101, confidence: 0.72 },
                { storeProductId: 102, confidence: 0.91 }, // higher name confidence
            ],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [101, { price: 1.49, promoPrice: null, promoEnd: null }],
            [102, { price: 1.49, promoPrice: null, promoEnd: null }],
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(l.storeProductId).toBe(102);
        expect(res.confirmed).toBe(1);
    });

    it('REJECT: €5 receipt vs €25 SP (no plausible sibling) → skip price write, keep display', async () => {
        const l = line({
            name: 'SOMETHING CHEAP',
            storeProductId: 700,
            matchedName: 'Expensive product',
            price: 5.0,
            altMatches: [{ storeProductId: 700, confidence: 0.7, name: 'Expensive product' }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [700, { price: 25.0, promoPrice: null, promoEnd: null }], // 5/25 = 0.2 → extreme
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);

        expect(res.rejected.has(0)).toBe(true);   // price write will be skipped
        expect(l.storeProductId).toBe(700);       // display unchanged (conservative)
        expect(l.priceVerified).toBe(false);
        expect(res.confirmed).toBe(0);
    });

    it('REJECT high side: €25 receipt vs €5 SP → flagged implausible', async () => {
        const l = line({
            storeProductId: 701, price: 25.0,
            altMatches: [{ storeProductId: 701, confidence: 0.7, name: 'Cheap product' }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [701, { price: 5.0, promoPrice: null, promoEnd: null }], // 25/5 = 5.0 → extreme
        ]));
        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(res.rejected.has(0)).toBe(true);
    });

    it('RE-PICK: implausible pick dropped for a price-plausible, name-competitive sibling', async () => {
        const l = line({
            name: 'PIENAS',
            storeProductId: 800, // implausible: €5 receipt, this SP is €25
            matchedName: 'Wrong expensive milk',
            price: 5.0,
            altMatches: [
                { storeProductId: 800, confidence: 0.80, name: 'Wrong expensive milk' },
                { storeProductId: 801, confidence: 0.78, name: 'Right cheap milk' }, // plausible, name-competitive
            ],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [800, { price: 25.0, promoPrice: null, promoEnd: null }], // 0.2 → extreme
            [801, { price: 5.49, promoPrice: null, promoEnd: null }], // 0.91 → plausible (not a price match though)
        ]));

        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);

        expect(l.storeProductId).toBe(801);        // dropped the implausible 800
        expect(l.matchedName).toBe('Right cheap milk');
        expect(res.repicked.has(0)).toBe(true);
        expect(res.rejected.has(0)).toBe(false);   // price writes to the plausible SP
    });

    it('FAIL-OPEN on a plausible gap: 40%-off sale is NOT rejected', async () => {
        const l = line({
            storeProductId: 900, price: 3.0, // 3/5 = 0.6 → within [0.4, 2.5]
            altMatches: [{ storeProductId: 900, confidence: 0.8, name: 'On sale' }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [900, { price: 5.0, promoPrice: null, promoEnd: null }],
        ]));
        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(res.rejected.has(0)).toBe(false);
        expect(res.repicked.has(0)).toBe(false);
        expect(l.storeProductId).toBe(900); // untouched
    });

    it('a matching DISCOUNT does NOT rescue a 5×-off regular (regular is the anchor)', async () => {
        const l = line({
            storeProductId: 950,
            price: 5.0,         // regular 5 vs db regular 25 → extreme
            promoPrice: 2.99,   // discounted 2.99 == db promo 2.99 (coincidence)
            altMatches: [{ storeProductId: 950, confidence: 0.7, name: 'Expensive on sale' }],
        });
        mockGetAsOfDatePrices.mockResolvedValue(new Map<number, any>([
            [950, { price: 25.0, promoPrice: 2.99, promoEnd: new Date('2026-06-20') }],
        ]));
        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(res.confirmed).toBe(0);          // the promo match is NOT a confirm
        expect(res.rejected.has(0)).toBe(true); // regular extreme → rejected
    });

    it('no altMatches / empty product list → no lookup, no change', async () => {
        const l = line({ altMatches: [] });
        const res = await applyPriceRound2Matching([l], 3, RECEIPT_DATE, 999);
        expect(res.confirmed).toBe(0);
        expect(mockGetAsOfDatePrices).not.toHaveBeenCalled();
    });

    it('passes the excludeReceiptId + chainId through to the lookup (no self-confirmation)', async () => {
        const l = line({ altMatches: [{ storeProductId: 101, confidence: 0.9 }] });
        mockGetAsOfDatePrices.mockResolvedValue(new Map());
        await applyPriceRound2Matching([l], 7, RECEIPT_DATE, 12345);
        expect(mockGetAsOfDatePrices).toHaveBeenCalledWith([101], 7, RECEIPT_DATE, 12345, undefined);
    });
});
