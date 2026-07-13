import { findBestProductMatches, scoreNameRelaxed } from '../src/utils/productMatcher.js';

/**
 * Lithuanian INFLECTION lane (Fix 5, receipt-237 salmon): receipts print genitives
 * ("atlantinių lašišų gabalai"), catalogs nominatives ("atlantinės lašišos") — the
 * case endings cost 2-3 Levenshtein edits per token, which on OCR-garbled tokens
 * eats the 0.75 edit budget. bestTokenMatch now also compares suffix-stripped stems
 * (slight 0.98 discount so exact forms win ties).
 *
 * GUARD (the apples-vs-potatoes regression the lane initially caused): when a
 * distinguishing content noun DISAGREES, the stem credit is voided — stems matching
 * on packaging words ("Fasuoti"↔"Fasuotos" → "fasuot") must not resurrect a
 * different product.
 */
const candidate = (id: number, name: string) => ({
    id, productId: id, storeProductName: name, brandName: null,
    isWeighable: false, amount: null, unit: null, imageUrl: null,
    categoryId: null, categoryName: null, categoryL2Name: null, chainId: 3,
    isCatalog: true,
});

describe('inflection lane — genitive/nominative forms match across case endings', () => {
    it('matches an inflected catalog form across case endings (sviestas → sviesto)', () => {
        // Anchor passes on the shared exact "rokiskio"; then the stem lane lifts the
        // inflected content word (sviestas→sviesto stems to the same "sviest" at 0.98)
        // that the raw lane leaves at the borderline. Exact form still wins the tie.
        const exact = findBestProductMatches('Rokiškio sviestas 82%', null, null, [candidate(1, 'Sviestas ROKIŠKIO 82%')] as any);
        const inflected = findBestProductMatches('Rokiškio sviestas 82%', null, null, [candidate(2, 'Sviesto ROKIŠKIO 82%')] as any);
        expect(exact[0]?.confidence ?? 0).toBeGreaterThan(0.7);
        expect(inflected[0]?.confidence ?? 0).toBeGreaterThan(0.7);
        expect(exact[0].confidence).toBeGreaterThanOrEqual(inflected[0].confidence);
    });

    it('relaxed pool scorer clears the fishing floor for the salmon genitive forms', () => {
        // The receipt-237 case verbatim: OCR-garbled nominative-ish query vs genitive catalog name.
        const s = scoreNameRelaxed('ATLATINÉS LAŠISOSs BE GAL', 'Atšaldytos skrostos atlantinių lašišų gabalai');
        expect(s).toBeGreaterThanOrEqual(0.45);
    });

    it('GUARD: stem credit on packaging words cannot resurrect apples→potatoes', () => {
        // "Fasuoti"/"Fasuotos" stem-match at 0.98, but the content nouns disagree
        // (obuoliai vs bulvės) → the distinguishing penalty voids the stem credit and
        // potatoes stays under the 0.4 surface floor.
        const r = findBestProductMatches('Fasuoti obuol ia1 IKI OKIS', null, null,
            [candidate(3, 'Fasuotos bulvės LAURA IKI ŪKIS')] as any);
        expect(r).toHaveLength(0);
    });

    it('relaxed scorer keeps rejecting different fish at the same price (upėtakis ≠ lašiša)', () => {
        const s = scoreNameRelaxed('ATLATINÉS LAŠISOSs BE GAL', 'Karštai rūkyti vaivorykštinio upėtakio gabalai');
        expect(s).toBe(0);
    });
});
