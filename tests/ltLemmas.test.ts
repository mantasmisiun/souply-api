import { LT_LEMMA_GROUPS, lemmaOf, lemmaEntries } from '../src/utils/ltLemmas.js';
import { normalizeProductName } from '../src/utils/productNameNormalize.js';
import { nameTokens, sameKind } from '../src/services/planningScoreService.js';

/**
 * "MISSED ITEM + EXTRA ITEM" REGRESSIONS — the whole class of bug where ONE real
 * purchase is counted BOTH as a forgotten list item AND as an impulse receipt
 * line, because Lithuanian declined the head noun between the list and the till.
 *
 * When a new report comes in, add the pair here first: a failing test names the
 * cause, and src/utils/ltLemmas.ts is where the fix goes. `npm run pairing:why`
 * prints the tier-by-tier reasoning for any two names.
 */

// sameKind's real input shape, reduced to what it reads.
const list = (name: string, productId: number | null = null, l3: number | null = null) =>
    ({ productName: name, productId, l3 });
const receipt = (name: string, productId: number | null = null, l3: number | null = null) =>
    ({ name, productId, l3 });

describe('declined head nouns still pair (real cases)', () => {
    test('receipt 120: planned "Spirito actas" vs bought "Maistinė acto rūgštis"', () => {
        // Live data: different products (3544 vs 48850), and the receipt side is
        // category 688 (unassigned) so the L3 tier can never save it — the name
        // tier is the ONLY tier left, and `actas` vs `acto` used to miss.
        const li = list('Spirito actas WELL DONE, 9 proc.', 3544, 191);
        const ri = receipt('Maistinė acto rūgštis BAJORIŠKIŲ (9%)', 48850, 688);
        expect(sameKind(li, ri)).toBe(true);
    });

    test('the raw OCR spelling of that receipt line pairs too', () => {
        // The line as the parser actually stored it (no diacritics, glued brand).
        expect(sameKind(list('Spirito actas WELL DONE, 9 proc.'), receipt('BA JORISKIU MAISTINE ACTO RUGSTIS'))).toBe(true);
    });

    test('irregular declension no stemmer catches: vanduo / vandens', () => {
        expect(sameKind(list('Natūralus mineralinis vanduo TICHĖ'), receipt('TICHE MINERALINIO VANDENS 1,5 L'))).toBe(true);
    });

    test('a short inflection survives the ≥4-char filter via its longer lemma', () => {
        // 'acto' is 4 and 'actu' is 4 — but the point is that lemmatisation runs
        // BEFORE the length gate, so even a 3-char form would map up and survive.
        expect(nameTokens('acto rūgštis').has('actas')).toBe(true);
        expect(nameTokens('actų esencija').has('actas')).toBe(true);
    });
});

describe('lemmatising must not fabricate matches', () => {
    test('different kinds in the same aisle stay apart', () => {
        expect(sameKind(list('Pomidorai raudoni'), receipt('AGURKAI TRUMPAVAISIAI'))).toBe(false);
        expect(sameKind(list('Sviestas ROKIŠKIO 82 %'), receipt('GRIETINE DVARO 30 %'))).toBe(false);
    });

    test('produce is deliberately NOT in the map: crisps are not potatoes', () => {
        // `bulviu` is 416 catalogue names, nearly all "bulvių traškučiai". Bridging
        // it would pair a planned potato with a bought bag of crisps.
        for (const form of ['bulviu', 'citrinu', 'obuoliu', 'bananu', 'pomidoru', 'pieno', 'surio']) {
            expect(lemmaOf(form)).toBe(form);
        }
        expect(sameKind(list('Bulvės, 1 kg'), receipt('LAYS BULVIU TRASKUCIAI'))).toBe(false);
        expect(sameKind(list('Pienas ROKIŠKIO 2,5 %'), receipt('MILKA PIENO SOKOLADAS'))).toBe(false);
    });

    test('an unknown token is returned untouched', () => {
        expect(lemmaOf('bajoriskiu')).toBe('bajoriskiu');
        expect(lemmaOf('')).toBe('');
    });
});

describe('map invariants', () => {
    const groups = LT_LEMMA_GROUPS;

    test('every form is already normalized (lowercase, diacritics folded)', () => {
        for (const g of groups) for (const f of g) {
            expect(normalizeProductName(f)).toBe(f);
        }
    });

    test('no form appears in two groups, and none twice in one group', () => {
        const owner = new Map<string, string>();
        for (const g of groups) {
            const local = new Set<string>();
            for (const f of g) {
                expect(local.has(f)).toBe(false);
                local.add(f);
                const prev = owner.get(f);
                if (prev !== undefined) throw new Error(`form "${f}" is claimed by both "${prev}" and "${g[0]}"`);
                owner.set(f, g[0]);
            }
        }
        expect(owner.size).toBe(lemmaEntries().length);
    });

    test('every group has ≥2 forms and a lemma long enough to survive the token filter', () => {
        for (const g of groups) {
            expect(g.length).toBeGreaterThanOrEqual(2);
            expect(g[0].length).toBeGreaterThanOrEqual(4);
        }
    });

    test('each form maps to its own group lemma', () => {
        for (const g of groups) for (const f of g) expect(lemmaOf(f)).toBe(g[0]);
    });
});
