/**
 * Data-integrity tests for the ingredient knowledge base.
 *
 * This is a DATA file — the tests pin the invariants the pipeline depends on:
 * unique keys, exclusive surface-form ownership, plausible densities/weights,
 * the anchor values conversions are calibrated against, and (the important
 * one) that the table actually covers the harvested recipe corpus.
 */

import { readFileSync, existsSync } from 'fs';
import {
    INGREDIENTS,
    INGREDIENT_INDEX,
    ingredientByKey,
} from '../src/services/recipes/ingredientData.js';
import type { IngredientInfo } from '../src/services/recipes/types.js';

const CORPUS_DIR =
    '/tmp/claude-1000/-home-mantas-Documents-Projects/928b7a9c-7fcc-416a-a268-c284cfdb965b/scratchpad/recipes';

describe('ingredient knowledge base', () => {
    it('has at least 300 entries', () => {
        expect(INGREDIENTS.length).toBeGreaterThanOrEqual(300);
    });

    it('keys are unique snake_case', () => {
        const seen = new Set<string>();
        for (const ing of INGREDIENTS) {
            expect(ing.key).toMatch(/^[a-z][a-z0-9_]*$/);
            expect(seen.has(ing.key)).toBe(false);
            seen.add(ing.key);
        }
    });

    it('ingredientByKey resolves every key and rejects unknowns', () => {
        for (const ing of INGREDIENTS) {
            expect(ingredientByKey(ing.key)).toBe(ing);
        }
        expect(ingredientByKey('definitely_not_a_key')).toBeUndefined();
    });

    it('no surface form is claimed by two entries; forms are lowercase, trimmed, non-empty', () => {
        const owner = new Map<string, IngredientInfo>();
        for (const ing of INGREDIENTS) {
            for (const form of [...ing.lt, ...ing.en]) {
                expect(form.length).toBeGreaterThan(0);
                expect(form).toBe(form.trim());
                expect(form).toBe(form.toLowerCase());
                const prev = owner.get(form);
                if (prev && prev !== ing) {
                    throw new Error(
                        `surface form '${form}' claimed by both '${prev.key}' and '${ing.key}'`,
                    );
                }
                owner.set(form, ing);
            }
        }
        // The exported index must be exactly this ownership map.
        expect(INGREDIENT_INDEX.size).toBe(owner.size);
        for (const [form, ing] of owner) {
            expect(INGREDIENT_INDEX.get(form)).toBe(ing);
        }
    });

    it('names are well-formed and every entry has forms in both languages', () => {
        // Lithuanian shopping names start with an uppercase letter (incl. diacritics).
        const upper = /^[A-ZĄČĘĖĮŠŲŪŽ]/;
        for (const ing of INGREDIENTS) {
            expect(ing.ltName.length).toBeGreaterThan(0);
            expect(ing.ltName).toMatch(upper);
            expect(ing.enName.length).toBeGreaterThan(0);
            expect(ing.enName).toBe(ing.enName.toLowerCase());
            expect(ing.lt.length).toBeGreaterThanOrEqual(1);
            expect(ing.en.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('densities and piece weights stay within physical plausibility bounds', () => {
        for (const ing of INGREDIENTS) {
            if (ing.gramsPerMl !== undefined) {
                expect(ing.gramsPerMl).toBeGreaterThanOrEqual(0.05);
                expect(ing.gramsPerMl).toBeLessThanOrEqual(2.0);
            }
            if (ing.gramsPerPiece !== undefined) {
                expect(ing.gramsPerPiece).toBeGreaterThanOrEqual(0.1);
                // 5 kg, not 3: a whole watermelon is genuinely 4 kg and is the
                // heaviest single thing a recipe ever asks for by the piece. The
                // bound exists to catch a misplaced zero, and it still does.
                expect(ing.gramsPerPiece).toBeLessThanOrEqual(5000);
            }
        }
    });

    it('anchor values hold, looked up through real LT surface forms', () => {
        // Looking these up via the genitive forms recipes actually print also
        // proves the LT forms are indexed.
        expect(INGREDIENT_INDEX.get('vandens')?.gramsPerMl).toBe(1.0);
        expect(INGREDIENT_INDEX.get('miltų')?.gramsPerMl).toBe(0.53);
        expect(INGREDIENT_INDEX.get('kiaušinių')?.gramsPerPiece).toBe(55);
        expect(INGREDIENT_INDEX.get('česnako')?.gramsPerPiece).toBe(4);
        expect(INGREDIENT_INDEX.get('grietinės')?.gramsPerMl).toBe(1.0);
        expect(INGREDIENT_INDEX.get('medaus')?.gramsPerMl).toBe(1.42);
        expect(INGREDIENT_INDEX.get('kario')?.gramsPerMl).toBe(0.47);
        expect(INGREDIENT_INDEX.get('svogūnų')?.gramsPerPiece).toBe(150);
        // And the same table answers English recipes.
        expect(INGREDIENT_INDEX.get('all-purpose flour')?.key).toBe('flour_wheat');
        expect(INGREDIENT_INDEX.get('kosher salt')?.key).toBe('salt_coarse');
    });

    it('a generic form never swallows a specific product (the pieno-šokoladas trap)', () => {
        expect(INGREDIENT_INDEX.get('pieno')?.key).toBe('milk');
        expect(INGREDIENT_INDEX.get('pieno šokoladas')?.key).toBe('chocolate_milk');
        expect(INGREDIENT_INDEX.get('sviesto')?.key).toBe('butter');
        expect(INGREDIENT_INDEX.get('žemės riešutų sviesto')?.key).toBe('peanut_butter');
        expect(INGREDIENT_INDEX.get('alyvuogių')?.key).toBe('olives');
        expect(INGREDIENT_INDEX.get('alyvuogių aliejaus')?.key).toBe('oil_olive');
    });
});

describe('shopping names match the shelf, not the recipe (catalog-verified synonyms)', () => {
    // Each ltName below was verified against souply_dev Product rows. The
    // recipe's word is often not the shop's word — the ltName IS the catalog
    // query, so it must be the shop's.
    const ltNameOf = (key: string) => ingredientByKey(key)?.ltName;

    it('blueberries shop as šilauogės (fresh mėlynės do not exist in the catalog)', () => {
        expect(ltNameOf('blueberry')).toBe('Šilauogės');
        expect(INGREDIENT_INDEX.get('šilauogės')?.key).toBe('blueberry');
        // wild bilberries keep their own entry and name
        expect(INGREDIENT_INDEX.get('mėlynių')?.key).toBe('bilberry');
    });

    it('chicken shops as viščiukas broileris (the shelf barely says vištiena)', () => {
        expect(ltNameOf('chicken')).toBe('Viščiukas broileris');
        expect(ltNameOf('chicken_breast')).toBe('Viščiukų broilerių filė');
        // recipes still resolve through either lemma
        expect(INGREDIENT_INDEX.get('vištienos')?.key).toBe('chicken');
        expect(INGREDIENT_INDEX.get('viščiuko')?.key).toBe('chicken');
        expect(INGREDIENT_INDEX.get('broilerio')?.key).toBe('chicken');
    });

    it('mince shops as smulkinta mėsa, not the recipe word faršas', () => {
        expect(ltNameOf('mince')).toBe('Smulkinta kiauliena ir jautiena');
        expect(ltNameOf('mince_beef')).toBe('Smulkinta jautiena');
        expect(INGREDIENT_INDEX.get('faršo')?.key).toBe('mince');
        expect(INGREDIENT_INDEX.get('malta mėsa')?.key).toBe('mince');
        expect(INGREDIENT_INDEX.get('smulkintos jautienos')?.key).toBe('mince_beef');
    });

    it('beef also recognises the shelf lemmas galvijų/jaučio', () => {
        expect(INGREDIENT_INDEX.get('galvijienos')?.key).toBe('beef');
        expect(INGREDIENT_INDEX.get('jaučio mėsos')?.key).toBe('beef');
        expect(INGREDIENT_INDEX.get('jautienos')?.key).toBe('beef');
    });

    it('cukraus pudra ≡ cukraus milteliai — both resolve to powdered sugar', () => {
        expect(INGREDIENT_INDEX.get('cukraus milteliai')?.key).toBe('sugar_powdered');
        expect(INGREDIENT_INDEX.get('cukraus pudros')?.key).toBe('sugar_powdered');
    });

    it('bay leaves shop as laurų lapai (5 of 7 shelf products)', () => {
        expect(ltNameOf('bay_leaf')).toBe('Laurų lapai');
        expect(INGREDIENT_INDEX.get('laurų lapų')?.key).toBe('bay_leaf');
        expect(INGREDIENT_INDEX.get('lauro lapų')?.key).toBe('bay_leaf');
    });

    it('uogienė ≡ džemas — one entry, shopping name Džemas (72 vs 30 products)', () => {
        expect(ltNameOf('jam')).toBe('Džemas');
        expect(INGREDIENT_INDEX.get('džemo')?.key).toBe('jam');
        expect(INGREDIENT_INDEX.get('uogienės')?.key).toBe('jam');
    });

    it('soy sauce shops in the genitive PLURAL the shelf uses (sojų, 23 vs 4)', () => {
        expect(ltNameOf('soy_sauce')).toBe('Sojų padažas');
        expect(ltNameOf('soy_sauce_dark')).toBe('Tamsusis sojų padažas');
        expect(INGREDIENT_INDEX.get('sojų padažo')?.key).toBe('soy_sauce');
        expect(INGREDIENT_INDEX.get('sojos padažo')?.key).toBe('soy_sauce');
        expect(INGREDIENT_INDEX.get('tamsusis sojų padažas')?.key).toBe('soy_sauce_dark');
    });

    it('more genitive-number fixes: česnakų milteliai, obuolių actas', () => {
        expect(ltNameOf('garlic_powder')).toBe('Česnakų milteliai');
        expect(INGREDIENT_INDEX.get('česnakų miltelių')?.key).toBe('garlic_powder');
        expect(ltNameOf('vinegar_apple')).toBe('Obuolių actas');
    });

    it('spices use the shelf plural: malti muskatai, malti kardamonai', () => {
        expect(ltNameOf('nutmeg')).toBe('Malti muskatai');
        expect(INGREDIENT_INDEX.get('muskatų')?.key).toBe('nutmeg');
        expect(ltNameOf('cardamom')).toBe('Malti kardamonai');
        expect(INGREDIENT_INDEX.get('kardamonų')?.key).toBe('cardamom');
    });

    it('crème fraîche resolves to grietinė — the shelf equivalent, not a new hunt', () => {
        expect(INGREDIENT_INDEX.get('crème fraîche')?.key).toBe('sour_cream');
        expect(INGREDIENT_INDEX.get('creme fraiche')?.key).toBe('sour_cream');
    });
});

describe('compound names resolve to their OWN entry, not the head token', () => {
    const keyOf = (form: string) => INGREDIENT_INDEX.get(form)?.key;

    it('harissa paste is not pasta (noodles)', () => {
        expect(keyOf('harissa paste')).toBe('harissa');
        expect(keyOf('harissa')).toBe('harissa');
        expect(keyOf('pasta')).toBe('pasta');
    });

    it('tortillas are not flour and not canned corn', () => {
        expect(keyOf('flour tortillas')).toBe('tortilla');
        expect(keyOf('corn tortillas')).toBe('tortilla');
        expect(keyOf('corn tortilla wraps')).toBe('tortilla');
        expect(keyOf('flour')).toBe('flour_wheat');
        expect(keyOf('corn')).toBe('corn_canned');
    });

    it('avocado oil is not an avocado', () => {
        expect(keyOf('avocado oil')).toBe('oil_avocado');
        expect(keyOf('avocado')).toBe('avocado');
    });

    it('pasta water is reserved cooking liquid — notSold, never a purchase', () => {
        expect(keyOf('pasta water')).toBe('pasta_water');
        expect(keyOf('pasta cooking water')).toBe('pasta_water');
        expect(ingredientByKey('pasta_water')?.notSold).toBe(true);
    });

    it('vanilla ice cream is not vanilla extract', () => {
        expect(keyOf('vanilla ice cream')).toBe('ice_cream');
        expect(keyOf('ice cream')).toBe('ice_cream');
        expect(keyOf('vanilla')).toBe('vanilla_extract');
    });

    it('pepper sauces and jarred peppers are not black pepper', () => {
        expect(keyOf('hot pepper sauce')).toBe('hot_sauce');
        expect(keyOf('jarred roasted red pepper')).toBe('bell_pepper');
        expect(keyOf('roasted red pepper')).toBe('bell_pepper');
        expect(keyOf('pepper')).toBe('pepper_black');
    });

    it('coriander seeds are a spice, not a bunch of fresh cilantro', () => {
        expect(keyOf('coriander seeds')).toBe('coriander_seed');
        expect(keyOf('ground coriander')).toBe('coriander_seed');
        expect(keyOf('coriander')).toBe('cilantro');
    });

    it('žemės riešutų sviestas is peanut butter, not dairy butter', () => {
        expect(keyOf('žemės riešutų sviestas')).toBe('peanut_butter');
        expect(keyOf('sviestas')).toBe('butter');
    });

    it('nutritional yeast is a seasoning, not baker\'s yeast', () => {
        expect(keyOf('nutritional yeast')).toBe('nutritional_yeast');
        expect(keyOf('yeast')).toBe('yeast');
    });

    it('cinnamon sticks, egg whites and chocolate syrup have their own entries', () => {
        expect(keyOf('cinnamon sticks')).toBe('cinnamon_stick');
        expect(keyOf('cinnamon')).toBe('cinnamon');
        expect(keyOf('egg whites')).toBe('egg_white');
        expect(keyOf('egg')).toBe('egg');
        expect(keyOf('chocolate syrup')).toBe('chocolate_syrup');
        expect(keyOf('chocolate')).toBe('chocolate_dark');
    });

    it('bare baltymai stays unregistered — ambiguous between egg whites and protein powder', () => {
        expect(INGREDIENT_INDEX.get('baltymai')).toBeUndefined();
        expect(INGREDIENT_INDEX.get('baltymų')).toBeUndefined();
        expect(keyOf('kiaušinių baltymai')).toBe('egg_white');
        expect(keyOf('baltymų milteliai')).toBe('protein_powder');
    });
});

describe('variety distinctions that change the dish resolve to DIFFERENT keys', () => {
    const keyOf = (form: string) => INGREDIENT_INDEX.get(form)?.key;

    it('sweet vs hot vs smoked paprika are three different jars', () => {
        const sweet = keyOf('sweet paprika');
        const hot = keyOf('hot paprika');
        const smoked = keyOf('smoked paprika');
        expect(sweet).toBe('paprika_ground');
        expect(hot).toBe('chili_powder');
        expect(smoked).toBe('paprika_smoked');
        expect(new Set([sweet, hot, smoked]).size).toBe(3);
        // and the LT shelf phrases land on the same three
        expect(keyOf('malta saldžioji paprika')).toBe('paprika_ground');
        expect(keyOf('malta aitrioji paprika')).toBe('chili_powder');
        expect(keyOf('rūkyta paprika')).toBe('paprika_smoked');
    });

    it('red pepper (vegetable) vs black pepper (spice) vs chilli', () => {
        expect(keyOf('red pepper')).toBe('bell_pepper');
        expect(keyOf('pepper')).toBe('pepper_black');
        expect(keyOf('chilli')).toBe('chili_fresh');
        expect(keyOf('red pepper flakes')).toBe('chili_flakes');
    });

    it('sweet potato vs potato; red vs white cabbage; risotto vs plain rice', () => {
        expect(keyOf('sweet potatoes')).toBe('potato_sweet');
        expect(keyOf('potatoes')).toBe('potato');
        expect(keyOf('red cabbage')).toBe('cabbage_red');
        expect(keyOf('purple cabbage')).toBe('cabbage_red');
        expect(keyOf('cabbage')).toBe('cabbage');
        expect(keyOf('risotto rice')).toBe('rice_risotto');
        expect(keyOf('arborio rice')).toBe('rice_risotto');
        expect(keyOf('rice')).toBe('rice');
    });

    it('the four vinegars stay four purchases', () => {
        const keys = [
            keyOf('white vinegar'),
            keyOf('apple cider vinegar'),
            keyOf('red wine vinegar'),
            keyOf('balsamic vinegar'),
        ];
        expect(new Set(keys).size).toBe(4);
        expect(keyOf('white vinegar')).toBe('vinegar_table');
        expect(keyOf('apple cider vinegar')).toBe('vinegar_apple');
        expect(keyOf('red wine vinegar')).toBe('vinegar_wine');
        expect(keyOf('balsamic vinegar')).toBe('vinegar_balsamic');
    });

    it('žirneliai are green peas; pipirų žirneliai are peppercorns', () => {
        expect(keyOf('žirneliai')).toBe('peas');
        expect(keyOf('pipirų žirneliai')).toBe('pepper_black');
        expect(keyOf('juodųjų pipirų žirneliai')).toBe('pepper_black');
        expect(keyOf('kvapniųjų pipirų žirneliai')).toBe('allspice');
    });

    it('kmynai (caraway) is not kuminas (cumin)', () => {
        expect(keyOf('kmynai')).toBe('caraway');
        expect(keyOf('kuminas')).toBe('cumin');
        expect(keyOf('cumin')).toBe('cumin');
        expect(keyOf('caraway')).toBe('caraway');
    });

    it('grietinė (sour cream) is not grietinėlė (cream) — literal-prefix trap', () => {
        expect(keyOf('grietinė')).toBe('sour_cream');
        expect(keyOf('grietinėlė')).toBe('cream_heavy');
        expect(keyOf('grietinės')).toBe('sour_cream');
        expect(keyOf('grietinėlės')).toBe('cream_heavy');
    });

    it('fennel bulb vs fennel seeds; stew meat is a braising cut, not generic beef', () => {
        expect(keyOf('fennel')).toBe('fennel');
        expect(keyOf('fennel seeds')).toBe('fennel_seeds');
        expect(keyOf('stew meat')).toBe('braising_steak');
        expect(keyOf('braising steak')).toBe('braising_steak');
        expect(keyOf('beef')).toBe('beef');
    });
});

describe('lexicon-gap entries (diagnosis cause 8)', () => {
    const keyOf = (form: string) => INGREDIENT_INDEX.get(form)?.key;

    it('8a: previously unmatched staples now resolve', () => {
        expect(keyOf('garam masala')).toBe('garam_masala');
        expect(keyOf('molasses')).toBe('molasses');
        expect(keyOf('black treacle')).toBe('molasses');
        expect(keyOf('oyster sauce')).toBe('oyster_sauce');
        expect(keyOf('anchovy fillets')).toBe('anchovy');
        expect(keyOf('cardamom pods')).toBe('cardamom_pods');
        expect(keyOf('cardamom')).toBe('cardamom'); // ground jar unaffected
    });

    it('8b: self-raising flour is its own entry', () => {
        expect(keyOf('self-raising flour')).toBe('flour_self_raising');
        expect(keyOf('self raising flour')).toBe('flour_self_raising');
        expect(keyOf('plain flour')).toBe('flour_wheat');
    });

    it('8c: ordinary shop items', () => {
        expect(keyOf('mussels')).toBe('mussels');
        expect(keyOf('clams')).toBe('clams');
        expect(keyOf('squid')).toBe('squid');
        expect(keyOf('tilapia')).toBe('tilapia');
        expect(keyOf('pecans')).toBe('pecans');
        expect(keyOf('brussels sprouts')).toBe('brussels_sprouts');
        expect(keyOf('edamame')).toBe('edamame');
        expect(keyOf('cranberries')).toBe('cranberries');
        expect(keyOf('blackberries')).toBe('blackberries');
        expect(keyOf('clementines')).toBe('clementine');
        expect(keyOf('puff pastry')).toBe('puff_pastry');
        expect(keyOf('burger buns')).toBe('burger_buns');
        expect(keyOf('baguette')).toBe('baguette');
        expect(keyOf('batonas')).toBe('bread_white_loaf'); // not robbed by baguette
        expect(keyOf('applesauce')).toBe('applesauce');
        expect(keyOf('cornmeal')).toBe('cornmeal');
        expect(keyOf('polenta')).toBe('cornmeal');
        expect(keyOf('cornstarch')).toBe('starch_corn'); // starch untouched
        expect(keyOf('beer')).toBe('beer');
        expect(keyOf('prosecco')).toBe('sparkling_wine');
        expect(keyOf('bbq sauce')).toBe('bbq_sauce');
        expect(keyOf('bratwurst')).toBe('bratwurst');
        expect(keyOf('mixed spice')).toBe('mixed_spice');
        expect(keyOf('lentils')).toBe('dried_lentils');
        expect(keyOf('guacamole')).toBe('guacamole');
        expect(keyOf('tortilla chips')).toBe('tortilla_chips');
        expect(keyOf('chickpeas')).toBe('chickpeas');
        expect(keyOf('kahlua')).toBe('coffee_liqueur');
        expect(keyOf('tajín')).toBe('tajin');
    });

    it('serving-side and US-import items are recognised but notSold', () => {
        for (const key of ['naan', 'chamoy', 'mezcal', 'frangelico',
            'marshmallow_fluff', 'liquid_smoke', 'graham_crackers', 'coconut_aminos']) {
            const ing = ingredientByKey(key);
            expect(ing).toBeDefined();
            expect(ing?.notSold).toBe(true);
        }
        // tap water keeps the flag that started it all
        expect(ingredientByKey('water')?.notSold).toBe(true);
        // and things that ARE sold never carry it
        expect(ingredientByKey('tajin')?.notSold).toBeUndefined();
        expect(ingredientByKey('coffee_liqueur')?.notSold).toBeUndefined();
    });
});

describe('corpus coverage', () => {
    // Words that appear in ingredient lines but are not ingredients: units,
    // amounts, prep instructions, connectives. Kept inline and additive-only —
    // shrinking the corpus word list is NOT a way to make this test pass.
    const LT_UNIT_STOP = new Set([
        // units & measure words
        'šaukštas', 'šaukštai', 'šaukšto', 'šaukštų', 'šaukštelis', 'šaukšteliai', 'šaukštelio', 'šaukštelių',
        'valgomasis', 'valgomieji', 'arbatinis', 'arbatiniai', 'arbatinio',
        'vienetas', 'vienetai', 'vieneto', 'vienetų',
        'sauja', 'saujos', 'saujelė', 'saujelės',
        'žiupsnelis', 'žiupsnelio', 'žiupsneliai',
        'pundelis', 'ryšulėlis', 'ryšulėlio',
        'skiltelė', 'skiltelės', 'skiltelių',
        'gramas', 'gramai', 'gramų', 'mililitrai', 'mililitrų', 'ml', 'g', 'kg', 'l',
        'litras', 'litrai', 'litro', 'kilogramas', 'kilogramai',
        'stiklinė', 'stiklinės', 'riekė', 'riekės', 'cm', 'centimetras', 'centimetrai', 'vnt',
        'šakelė', 'šakelės', 'šakelių', 'šlakelis', 'šlakelio', 'šlakelių', 'galvutė', 'galvutės', 'galvučių',
        // stop words / prep phrases
        'pagal', 'skonį', 'poreikį', 'ar', 'arba', 'ir', 'bet', 'jei', 'su', 'į', 'iš', 'kiek',
        'tinka', 'nebūtina', 'nebūtinai', 'galima', 'naudojau', 'žr', 'patarimus', 'kito', 'kitos', 'kitokio',
        'mažu', 'mažų', 'mažiau', 'nedidelio', 'nedidelės', 'nedidelių', 'didelė', 'didelės',
        'šviežio', 'šviežių', 'šviežios', 'šviežias',
        'šaldytų', 'smulkinto', 'smulkintų', 'tarkuoto', 'tarkuotos', 'skrudintų',
        'kepimui', 'virti', 'virtų', 'žalių', 'karšto', 'karštai',
        'kambario', 'temperatūros', 'kupino', 'kelių', 'pusės', 'pusantro', 'ketvirtadalio', 'vienos',
        'vidutinio', 'dydžio', 'ilgio', 'šiek', 'tiek',
    ]);

    const EN_UNIT_STOP = new Set([
        // units & containers
        'tsp', 'tbsp', 'teaspoon', 'teaspoons', 'tablespoon', 'tablespoons', 'table',
        'cup', 'cups', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'g', 'kg', 'ml', 'litre', 'liter',
        'can', 'cans', 'jar', 'packet', 'package', 'pack', 'box', 'tin', 'tub', 'bottle', 'punnet',
        'slice', 'slices', 'pinch', 'bunch', 'sprig', 'sprigs', 'stalk', 'stalks', 'clove', 'cloves',
        'head', 'handful', 'handfuls', 'pieces', 'piece', 'cm', 'mm', 'half', 'halves', 'quarter',
        // prep & descriptor words
        'or', 'and', 'of', 'the', 'a', 'an', 'to', 'for', 'with', 'in', 'into', 'each', 'any', 'other',
        'note', 'notes', 'see', 'above', 'plus', 'extra', 'optional', 'preferably', 'substitute', 'sub',
        'taste', 'divided', 'about', 'if', 'is', 'it', 'not', 'then', 'use', 'using', 'quot', 'amp',
        'finely', 'chopped', 'minced', 'diced', 'sliced', 'grated', 'shredded', 'crushed', 'cracked',
        'freshly', 'cut', 'peeled', 'drained', 'packed', 'heaped', 'softened', 'melted', 'beaten',
        'cooked', 'uncooked', 'boiled', 'roasted', 'toasted', 'trimmed', 'picked', 'halved', 'halve',
        'large', 'medium', 'small', 'big', 'whole', 'regular', 'fine', 'light', 'dark', 'low', 'full',
        'fat', 'lean', 'sodium', 'organic', 'stoneground', 'store', 'bought', 'dry', 'dried', 'fresh',
        'frozen', 'room', 'temperature', 'cold', 'warm', 'hot', 'fridge', 'excess', 'spicy', 'sweet',
        'sharp', 'strong', 'soft', 'firm', 'firmly', 'ripe', 'baby', 'wedge', 'wedges', 'garnish',
        'type', 'kind', 'choice', 'shell', 'skin', 'seasoning', 'mix', 'blend', 'recipe',
    ]);

    /** Every full form plus every whitespace/hyphen-separated token of a form —
     *  a corpus word counts as "known" if some registered form mentions it. */
    const knownTokens = (() => {
        const set = new Set<string>();
        for (const ing of INGREDIENTS) {
            for (const f of [...ing.lt, ...ing.en]) {
                set.add(f);
                for (const t of f.split(/[\s-]+/)) if (t) set.add(t);
            }
        }
        return set;
    })();

    function coverage(file: string, stop: Set<string>): { ratio: number; misses: string[] } {
        const lines = readFileSync(`${CORPUS_DIR}/${file}`, 'utf8').trim().split('\n');
        const words = lines
            .map(l => l.trim().split(/\s+/))
            .filter(([freq]) => Number(freq) >= 3)
            .map(([, w]) => w)
            .filter((w): w is string => !!w);
        expect(words.length).toBeGreaterThan(0);
        const misses = words.filter(w => !knownTokens.has(w) && !stop.has(w));
        return { ratio: (words.length - misses.length) / words.length, misses };
    }

    const corpusPresent = existsSync(`${CORPUS_DIR}/words_lt.txt`);
    const maybeIt = corpusPresent ? it : it.skip;

    maybeIt('covers ≥75% of frequent Lithuanian corpus words', () => {
        const { ratio, misses } = coverage('words_lt.txt', LT_UNIT_STOP);
        if (misses.length) {
            // eslint-disable-next-line no-console
            console.log(`[corpus lt] uncovered (${misses.length}): ${misses.join(', ')}`);
        }
        // Achieved at time of writing: 96.4% — the only misses are scrape
        // artifacts where the source glued unit+ingredient into one token
        // ('vienetaikiaušiniai', 'šaukšteliodruska', 'šaukšteliomaltų').
        expect(ratio).toBeGreaterThanOrEqual(0.75);
    });

    maybeIt('covers ≥75% of frequent English corpus words', () => {
        const { ratio, misses } = coverage('words_en.txt', EN_UNIT_STOP);
        if (misses.length) {
            // eslint-disable-next-line no-console
            console.log(`[corpus en] uncovered (${misses.length}): ${misses.join(', ')}`);
        }
        // Achieved at time of writing: 100%.
        expect(ratio).toBeGreaterThanOrEqual(0.75);
    });
});
