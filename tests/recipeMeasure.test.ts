import { INGREDIENT_INDEX } from '../src/services/recipes/ingredientData.js';
import { contentWords, findIngredient, formatMeasure, toMetric } from '../src/services/recipes/measure.js';
import { parseIngredientLine } from '../src/services/recipes/ingredientParser.js';
import type { Lang } from '../src/services/recipes/types.js';

/**
 * The conversion layer: a recipe measures by convenience, a shop sells by mass or
 * by the piece, and density is the bridge. These tests pin the bridge — a wrong
 * density is a silently wrong shopping list.
 */

const measureOf = (line: string, lang: Lang = 'lt') => {
    const p = parseIngredientLine(line, lang)[0];
    const hit = findIngredient(p.nameFull || p.name) ?? findIngredient(p.name);
    return { measure: toMetric(p, hit?.info ?? null), info: hit?.info ?? null, parsed: p };
};

describe('findIngredient', () => {
    it('recognises a Lithuanian genitive against a nominative table', () => {
        expect(findIngredient('kvietinių miltų')?.info.key).toBe('flour_wheat');
        expect(findIngredient('grietinės')?.info.key).toBe('sour_cream');
        expect(findIngredient('česnako')?.info.key).toBe('garlic');
    });

    /** Longest-window-wins. Without it "alyvuogių aliejus" collapses to any oil
     *  and "pieno šokoladas" is read as milk — both real products in this catalog. */
    it('prefers the longest matching phrase', () => {
        expect(findIngredient('alyvuogių aliejaus')?.info.key).not.toBe(findIngredient('aliejaus')?.info.key);
        expect(findIngredient('alyvuogių aliejaus')?.info.ltName).toMatch(/alyvuog/i);
    });

    it('translates English forms to a Lithuanian shopping name', () => {
        expect(findIngredient('all-purpose flour')?.info.ltName).toMatch(/miltai/i);
        expect(findIngredient('sour cream')?.info.ltName).toMatch(/[Gg]rietinė/);
        expect(findIngredient('garlic')?.info.key).toBe('garlic');
    });

    it('returns null for something that is not an ingredient', () => {
        expect(findIngredient('')).toBeNull();
        expect(findIngredient('kepimo maišelį sudėti karką')).toBeNull();
    });

    /**
     * The hit must confess WHICH words of the phrase it accounted for. "purple
     * carrots" is recognised through the window "carrots" alone — and before
     * the hit reported that window, nobody downstream could see that "purple"
     * (or "red", or "sweet") was silently thrown away. That silence is how red
     * pepper became black pepper in a shopping basket.
     */
    it('reports the exact window of the phrase it matched', () => {
        const partial = findIngredient('purple carrots');
        expect(partial?.form).toBe('carrots');
        expect(partial?.words).toBe(1);

        const full = findIngredient('alyvuogių aliejaus');
        expect(full?.form).toBe('alyvuogiu aliejaus');   // folded surface words, not the stemmed key
        expect(full?.words).toBe(2);
    });
});

describe('toMetric', () => {
    it('converts mass units exactly', () => {
        expect(measureOf('500 g vištienos filė').measure).toEqual({ qty: 500, unit: 'g', approx: false });
        expect(measureOf('1,5 kg kiaulienos').measure).toEqual({ qty: 1500, unit: 'g', approx: false });
        expect(measureOf('2 lbs boneless chicken breasts', 'en').measure.qty).toBeCloseTo(907.18, 1);
    });

    /** The whole point of the density table: a spoon of one powder is not a spoon
     *  of another, so the mass must come from the ingredient, not the spoon. */
    it('uses density to turn a spoon into grams', () => {
        const flour = measureOf('2 šaukštai kvietinių miltų').measure;   // 30 ml × 0.53
        expect(flour.unit).toBe('g');
        expect(flour.qty).toBeCloseTo(15.9, 1);
        expect(flour.approx).toBe(true);

        const honey = measureOf('1 šaukštas medaus').measure;            // 15 ml × 1.42
        expect(honey.qty).toBeCloseTo(21.3, 1);

        // Same spoon, three very different masses.
        expect(measureOf('1 šaukštas druskos').measure.qty)
            .toBeGreaterThan(measureOf('1 šaukštas kvietinių miltų').measure.qty!);
    });

    it('keeps millilitres when the ingredient has no density', () => {
        const m = measureOf('200 mililitrų vandens').measure;
        expect(m.unit).toBe('g');            // water is 1.0 g/ml, so grams is right
        expect(m.qty).toBe(200);
    });

    it('converts a US cup, not a Lithuanian glass', () => {
        // 1 cup = 240 ml; 1 stiklinė = 250 ml. Same word in translation, different
        // volume, and sugar makes the difference visible.
        const cup = measureOf('1 cup granulated sugar', 'en').measure.qty!;
        const glass = measureOf('1 stiklinė cukraus').measure.qty!;
        expect(cup).toBeCloseTo(240 * 0.85, 0);
        expect(glass).toBeCloseTo(250 * 0.85, 0);
        expect(glass).toBeGreaterThan(cup);
    });

    it('weighs countable things the table knows', () => {
        expect(measureOf('2 skiltelės česnako').measure).toEqual({ qty: 8, unit: 'g', approx: true });
        expect(measureOf('3 vienetai svogūnų').measure.qty).toBe(450);
    });

    it('leaves eggs as eggs — they are sold by the box, not by the gram', () => {
        const m = measureOf('4 kiaušiniai').measure;
        expect(m.unit).toBe('pcs');
        expect(m.qty).toBe(4);
    });

    it('reports nothing when the recipe gives no amount', () => {
        expect(measureOf('pagal skonį druskos').measure).toEqual({ qty: null, unit: null, approx: false });
    });

    /** A range buys the lower bound: over-buying a spice is waste, and the raw
     *  line still shows the range. */
    it('converts the lower bound of a range', () => {
        expect(measureOf('1-2 šaukštai medaus').measure.qty).toBeCloseTo(21.3, 1);
    });
});

describe('formatMeasure', () => {
    it('marks an estimate and rolls up to kg/l', () => {
        expect(formatMeasure({ qty: 21.3, unit: 'g', approx: true })).toBe('≈21,3 g');
        expect(formatMeasure({ qty: 500, unit: 'g', approx: false })).toBe('500 g');
        expect(formatMeasure({ qty: 1500, unit: 'g', approx: false })).toBe('1,5 kg');
        expect(formatMeasure({ qty: 2000, unit: 'ml', approx: false })).toBe('2 l');
        expect(formatMeasure({ qty: 3, unit: 'pcs', approx: false })).toBe('3 vnt.');
        expect(formatMeasure({ qty: 3, unit: 'pcs', approx: false }, 'en')).toBe('3 pcs');
        expect(formatMeasure({ qty: null, unit: null, approx: false })).toBeNull();
    });
});

describe('contentWords', () => {
    /**
     * TRAP: the words are folded before they are stemmed, so an ending list
     * written with diacritics stemmed almost nothing — "petražolės" and
     * "petražolių" read as different words and flagged correct matches for review.
     */
    it('collapses Lithuanian inflections of the same word', () => {
        expect(contentWords('petražolių')).toEqual(contentWords('Petražolės'));
        expect(contentWords('braškių')).toEqual(contentWords('Braškės'));
        expect(contentWords('rudojo cukraus')[0]).toBe(contentWords('Rudasis cukrus')[0]);
        expect(contentWords('kedrinių pinijų')).toEqual(contentWords('Kedrinės pinijos'));
    });

    it('drops grammar words and keeps content', () => {
        expect(contentWords('su druska ir pipirais')).not.toContain('su');
    });
});

describe('the ingredient table itself', () => {
    it('indexes the forms Lithuanian recipes actually print', () => {
        for (const form of ['miltų', 'cukraus', 'druskos', 'sviesto', 'kiaušinių', 'česnako', 'pieno']) {
            expect(INGREDIENT_INDEX.has(form)).toBe(true);
        }
    });

    /** Paid for in the receipt parser already: "bulvių traškučiai" are crisps and
     *  "pieno šokoladas" is chocolate. A bare generic token must have ONE owner. */
    it('does not let a generic token be claimed by a specific product', () => {
        expect(INGREDIENT_INDEX.get('pieno')?.key).toMatch(/milk/);
        expect(INGREDIENT_INDEX.get('bulvių')?.key).toMatch(/potato/);
    });

    it('marks tap water as recognised but not shopping', () => {
        const water = INGREDIENT_INDEX.get('vandens');
        expect(water?.gramsPerMl).toBe(1);
        expect(water?.notSold).toBe(true);
    });
});
