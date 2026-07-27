import { parseIngredientLine, parseIngredientLines } from '../src/services/recipes/ingredientParser.js';
import type { Lang, ParsedIngredient } from '../src/services/recipes/types.js';

/**
 * Every line in this file is REAL — harvested from lamaistas.lt, receptai.lt,
 * beatosvirtuve.lt, budgetbytes.com, recipetineats.com and food.com. Each one
 * broke the parser at some point, and the comment says how.
 */

const one = (line: string, lang: Lang = 'lt'): ParsedIngredient => {
    const out = parseIngredientLine(line, lang);
    expect(out).toHaveLength(1);
    return out[0];
};

const shape = (p: ParsedIngredient) => ({ q: p.quantity, max: p.quantityMax, unit: p.unit, name: p.name });

describe('Lithuanian lines', () => {
    it('reads the ordinary shape', () => {
        expect(shape(one('200 mililitrų vandens')))
            .toEqual({ q: 200, max: null, unit: 'ml', name: 'vandens' });
        expect(shape(one('6 skiltelės česnako')))
            .toEqual({ q: 6, max: null, unit: 'clove', name: 'česnako' });
        expect(shape(one('2 šaukštai alyvuogių aliejaus')))
            .toEqual({ q: 2, max: null, unit: 'tbsp', name: 'alyvuogių aliejaus' });
    });

    /** receptai.lt's template prints the unit with NO space before the
     *  ingredient. Taken literally the whole thing is one unknown word. */
    it('splits a unit glued to the ingredient name', () => {
        expect(shape(one('440 gramųkonservuotų pupelių')))
            .toEqual({ q: 440, max: null, unit: 'g', name: 'konservuotų pupelių' });
        expect(shape(one('4 vienetaikiaušiniai')))
            .toEqual({ q: 4, max: null, unit: 'pcs', name: 'kiaušiniai' });
        expect(shape(one('1 stiklinėcukrus')))
            .toEqual({ q: 1, max: null, unit: 'glass', name: 'cukrus' });
    });

    /**
     * TRAP. Folding diacritics to compare prefixes makes "gramų"+"sviestas" look
     * like the accusative "gramus", and the split then ate the ingredient's
     * first letter — 170 g of "viestas".
     */
    it('does not eat the first letter of the ingredient', () => {
        expect(shape(one('170 gramųsviestas')))
            .toEqual({ q: 170, max: null, unit: 'g', name: 'sviestas' });
    });

    /**
     * TRAP. The greedy split of "šaukštaisviestas" is the instrumental
     * "šaukštais", which leaves "viestas" and rebuilds to a phrase that is not a
     * unit. Only the unit table can say which split is right.
     */
    it('picks the glued split that actually forms a unit', () => {
        expect(shape(one('2 valgomieji šaukštaisviestas')))
            .toEqual({ q: 2, max: null, unit: 'tbsp', name: 'sviestas' });
        expect(shape(one('1 arbatinis šaukšteliskepimo milteliai')))
            .toEqual({ q: 1, max: null, unit: 'tsp', name: 'kepimo milteliai' });
    });

    /** beatosvirtuve.lt spells small amounts instead of printing digits. */
    it('reads an amount written as a word', () => {
        expect(shape(one('Šaukšto medaus')))
            .toEqual({ q: 1, max: null, unit: 'tbsp', name: 'medaus' });
        expect(shape(one('Pusės šaukštelio malto cinamono')))
            .toEqual({ q: 0.5, max: null, unit: 'tsp', name: 'malto cinamono' });
        expect(shape(one('Ketvirtadalio stiklinės vandens')))
            .toEqual({ q: 0.25, max: null, unit: 'glass', name: 'vandens' });
    });

    it('reads a decimal comma and a range', () => {
        expect(shape(one('2,5 kg žalių bulvių')))
            .toEqual({ q: 2.5, max: null, unit: 'kg', name: 'žalių bulvių' });
        expect(shape(one('1-2 šaukštai granatų sirupo')))
            .toEqual({ q: 1, max: 2, unit: 'tbsp', name: 'granatų sirupo' });
        expect(shape(one('200-300 g. karštai rūkytos šoninės')))
            .toEqual({ q: 200, max: 300, unit: 'g', name: 'karštai rūkytos šoninės' });
    });

    /**
     * `\b` is ASCII-only in JavaScript, so `\bšiek tiek` and `pagal skonį\b`
     * could never match and every Lithuanian "to taste" was silently missed.
     */
    it('recognises "to taste" and "optional" through the diacritics', () => {
        const taste = one('pagal skonį druskos');
        expect(taste.toTaste).toBe(true);
        expect(taste.quantity).toBeNull();
        expect(taste.name).toBe('druskos');

        expect(one('šiek tiek saulėgrąžų aliejus').toTaste).toBe(true);
        expect(one('pagal poreikį agurkų (kiek tilps į stiklainį)').toTaste).toBe(true);
        expect(one('2 vienetai krienų lapų (nebūtina)').optional).toBe(true);
        expect(one('1 šaukštas linų sėmenų (arba čija sėklų, nebūtina)').optional).toBe(true);
    });

    it('keeps a size adjective as a note instead of in the name', () => {
        const p = one('2 mažų skiltelių tarkuoto česnako');
        expect(shape(p)).toEqual({ q: 2, max: null, unit: 'clove', name: 'česnako' });
        expect(p.note).toContain('mažų');

        const q = one('2 vidutinio dydžio svogūnų');
        expect(q.name).toBe('svogūnų');
        expect(q.note).toContain('vidutinio dydžio');
    });

    /** One line, three things to buy — each one strikeable on its own. */
    it('splits a comma-separated list of bare ingredients', () => {
        const parts = parseIngredientLine('Druskos, pipirų, lauro lapų', 'lt');
        expect(parts.map(p => p.name)).toEqual(['Druskos', 'pipirų', 'lauro lapų']);
        expect(parts.every(p => p.quantity === null)).toBe(true);
    });

    it('does NOT split a comma that introduces a prep note', () => {
        const p = one('50 gramų grietinėlės, 35%');
        expect(p.name).toBe('grietinėlės');
        expect(p.note).toBe('35%');
    });

    /** beatosvirtuve.lt parks advice in the ingredient array. */
    it('ignores prose that is not an ingredient', () => {
        expect(one('Sultiniui virti galite naudoti mėgiamas daržoves').ignored).toBe(true);
        expect(one('Padažui:').ignored).toBe(true);
    });
});

describe('English lines', () => {
    it('reads unicode and mixed fractions', () => {
        expect(shape(one('¾ cup panko breadcrumbs', 'en')))
            .toEqual({ q: 0.75, max: null, unit: 'cup', name: 'panko breadcrumbs' });
        expect(shape(one('1 3/4 tsp black pepper', 'en')))
            .toEqual({ q: 1.75, max: null, unit: 'tsp', name: 'black pepper' });
    });

    /**
     * TRAP. Alternation is first-match-wins, so with the integer branch first
     * "3/4 tsp salt" matched the "3" and left "/4" in the name — four times the
     * salt.
     */
    it('reads a bare fraction as a fraction, not as its numerator', () => {
        expect(shape(one('3/4 tsp salt', 'en')))
            .toEqual({ q: 0.75, max: null, unit: 'tsp', name: 'salt' });
        expect(shape(one('1/3 cup light brown sugar', 'en')))
            .toEqual({ q: 0.333, max: null, unit: 'cup', name: 'light brown sugar' });
    });

    it('reads ranges, however the site spaces them', () => {
        expect(shape(one('1 -2 tablespoon olive oil', 'en')))
            .toEqual({ q: 1, max: 2, unit: 'tbsp', name: 'olive oil' });
        expect(shape(one('1 1/2 - 2 cups shredded mozzarella', 'en')))
            .toEqual({ q: 1.5, max: 2, unit: 'cup', name: 'mozzarella' });
    });

    /** Budget Bytes prints its costing inside the ingredient line. */
    it('strips prices and footnote markers', () => {
        expect(shape(one('2 cloves garlic* ($0.08)', 'en')))
            .toEqual({ q: 2, max: null, unit: 'clove', name: 'garlic' });
        expect(one('1 tsp salt, or to taste ($0.03)', 'en').toTaste).toBe(true);
    });

    /** RecipeTin Eats writes both systems; we shop in metric. */
    it('keeps the metric half of a dual measurement', () => {
        expect(shape(one('500 g / 1 lb chicken mince', 'en')))
            .toEqual({ q: 500, max: null, unit: 'g', name: 'chicken mince' });
        expect(shape(one('800g / 28oz pork belly mince', 'en')))
            .toEqual({ q: 800, max: null, unit: 'g', name: 'pork belly mince' });
    });

    /** A count, then the package size, then the container. */
    it('folds a package size into the amount', () => {
        // "crushed" is a prep participle, so it moves to the note and the display
        // name is "tomatoes" — but `nameFull` keeps it, because canned crushed
        // tomatoes are a different product from fresh ones and the knowledge base
        // looks up the fuller phrase.
        const canned = one('1 28 oz. can crushed tomatoes**', 'en');
        expect(shape(canned)).toEqual({ q: 28, max: null, unit: 'oz', name: 'tomatoes' });
        expect(canned.nameFull).toBe('crushed tomatoes');
        const tin = one('1 (400 g) can chopped tomatoes', 'en');
        expect(shape(tin)).toEqual({ q: 400, max: null, unit: 'g', name: 'tomatoes' });
        expect(tin.nameFull).toBe('chopped tomatoes');
    });

    /**
     * TRAP. "(1 head)" inside a note was read as the package size, turning two
     * cups of broccoli into one head of it. A count in brackets is a remark.
     */
    it('does not mistake a bracketed count for a package size', () => {
        const p = one('2 packed cups broccoli (soft cooked, 1 head)', 'en');
        expect(p.quantity).toBe(2);
        expect(p.unit).toBe('cup');
        expect(p.name).toBe('broccoli');
    });

    it('reads a unit that trails the noun', () => {
        expect(shape(one('3 garlic cloves ($0.12)', 'en')))
            .toEqual({ q: 3, max: null, unit: 'clove', name: 'garlic' });
        expect(shape(one('2 celery stalks', 'en')))
            .toEqual({ q: 2, max: null, unit: 'stalk', name: 'celery' });
    });

    it('keeps a bare count with no unit', () => {
        expect(shape(one('4 carrots ($0.65)', 'en')))
            .toEqual({ q: 4, max: null, unit: null, name: 'carrots' });
        expect(shape(one('1 large egg ($0.18)', 'en')))
            .toEqual({ q: 1, max: null, unit: null, name: 'egg' });
    });

    it('accepts an ingredient with no amount at all', () => {
        const p = one('Black pepper', 'en');
        expect(p.quantity).toBeNull();
        expect(p.unit).toBeNull();
        expect(p.name).toBe('Black pepper');
        expect(p.ignored).toBe(false);
    });

    /** TRAP. Without the vulgar glyphs in the has-an-amount test, this split into
     *  two ingredients, the second being the word "minced". */
    it('does not split a fraction line on its prep comma', () => {
        const parts = parseIngredientLine('½ garlic clove, minced', 'en');
        expect(parts).toHaveLength(1);
        expect(shape(parts[0])).toEqual({ q: 0.5, max: null, unit: 'clove', name: 'garlic' });
    });

    it('strips nested parentheses without leaving debris', () => {
        const p = one('1 1/2 cups shredded mozzarella ((or other cheese of choice)(Note 3))', 'en');
        expect(p.name).toBe('mozzarella');
        expect(p.name).not.toMatch(/[()]/);
    });

    it('moves a leading prep participle into the note', () => {
        const p = one('¾ cup finely chopped shallots', 'en');
        expect(p.name).toBe('shallots');
        expect(p.note).toMatch(/chopped/);
    });
});

describe('Lithuanian "Ingredientas: kiekis" lines', () => {
    /**
     * skanauk.lt and receptai.lt print the amount AFTER the name, separated by
     * a colon. Taken literally the whole string survived as the name and the
     * quantity was truncated mid-decimal ("sviesto: 1"). The refit only fires
     * when the colon tail is NOTHING but an amount — a mid-line colon can also
     * be a glued heading, and a trailing colon stays a section heading.
     */
    it('reads the amount from after the colon', () => {
        expect(shape(one('jautienos be kaulo: 1,3 kilogramo')))
            .toEqual({ q: 1.3, max: null, unit: 'kg', name: 'jautienos be kaulo' });
        expect(shape(one('vandens: 500 mililitrų')))
            .toEqual({ q: 500, max: null, unit: 'ml', name: 'vandens' });
        expect(shape(one('cukrus: 40 gramų')))
            .toEqual({ q: 40, max: null, unit: 'g', name: 'cukrus' });
        expect(shape(one('sviesto: 1,5 šaukšto')))
            .toEqual({ q: 1.5, max: null, unit: 'tbsp', name: 'sviesto' });
        expect(shape(one('česnako: 7 skiltelių')))
            .toEqual({ q: 7, max: null, unit: 'clove', name: 'česnako' });
        expect(shape(one('svogūnų: 2')))
            .toEqual({ q: 2, max: null, unit: null, name: 'svogūnų' });
    });

    it('keeps a parenthetical in the tail as a note', () => {
        const p = one('morkų: 4 (didelių)');
        expect(shape(p)).toEqual({ q: 4, max: null, unit: null, name: 'morkų' });
        expect(p.note).toContain('didelių');
    });

    it('reads a bare unit and a to-taste phrase as the amount', () => {
        expect(shape(one('pipirų: žiupsnelio')))
            .toEqual({ q: 1, max: null, unit: 'pinch', name: 'pipirų' });
        const taste = one('druskos: pagal skonį');
        expect(taste.toTaste).toBe(true);
        expect(taste.quantity).toBeNull();
        expect(taste.name).toBe('druskos');
        // "truputis" ("a bit") is skanauk.lt's other to-taste word.
        const bit = one('svogūnų milteliai (arba granulės): trupučio');
        expect(bit.toTaste).toBe(true);
        expect(bit.name).toBe('svogūnų milteliai');
    });

    /** The template glues the decimal to the unit ("1,5valgomojo šaukšto")
     *  and abbreviates ("1 a.š.") — both must survive the round trip. */
    it('reads glued decimals and print abbreviations in the tail', () => {
        expect(shape(one('pomidorų pastos: 1,5valgomojo šaukšto')))
            .toEqual({ q: 1.5, max: null, unit: 'tbsp', name: 'pomidorų pastos' });
        expect(shape(one('Kepimo soda: 1 a.š.')))
            .toEqual({ q: 1, max: null, unit: 'tsp', name: 'Kepimo soda' });
        expect(shape(one('pienas: 200 ml,')))
            .toEqual({ q: 200, max: null, unit: 'ml', name: 'pienas' });
    });

    it('reads ranges, size adjectives, and approximation markers in the tail', () => {
        expect(shape(one('mėgiami prieskoniai maltai mėsai: 1-2 arbatinių šaukštelių (naudojau įvairių žolelių mišinį)')))
            .toEqual({ q: 1, max: 2, unit: 'tsp', name: 'mėgiami prieskoniai maltai mėsai' });
        expect(shape(one('nuplauti špinatų lapai: 4 didelių saujų')))
            .toEqual({ q: 4, max: null, unit: 'handful', name: 'nuplauti špinatų lapai' });
        expect(shape(one('bulvės: 6 vidutinio dydžio (virtos su lupena)')))
            .toEqual({ q: 6, max: null, unit: null, name: 'bulvės' });
        expect(shape(one('miltai: ~1,5 kilogramo')))
            .toEqual({ q: 1.5, max: null, unit: 'kg', name: 'miltai' });
        expect(shape(one('laimo sultys: iš 1 vnt.')))
            .toEqual({ q: 1, max: null, unit: 'pcs', name: 'laimo sultys' });
    });

    /** A heading glued in FRONT of the name with a colon of its own. */
    it('peels a glued heading off the name', () => {
        const p = one('Tešlai:Kiaušiniai: 4 vnt.');
        expect(shape(p)).toEqual({ q: 4, max: null, unit: 'pcs', name: 'Kiaušiniai' });
        expect(p.note).toContain('Tešlai');
    });

    /** TRAP. "kreminis sūris: 4 v. š. (pvz.: "Philadelphia")" — the LAST colon
     *  is inside the parentheses; splitting there loses the amount. The colon
     *  search must ignore bracketed content. */
    it('ignores a colon inside parentheses', () => {
        const p = one('kreminis sūris: 4 valgomųjų šaukštų (pvz.: "Philadelphia")');
        expect(shape(p)).toEqual({ q: 4, max: null, unit: 'tbsp', name: 'kreminis sūris' });
    });

    /** When the tail is NOT an amount, the colon is a heading or prose and the
     *  line must be left alone — and a trailing colon stays a heading. */
    it('does not refit when the tail is not an amount', () => {
        expect(one('Actas arba citrinų sultys: 1 v.š.').name).toBe('Actas arba citrinų sultys');
        expect(one('Padažui:').ignored).toBe(true);
    });
});

describe('dual measurements (metric half wins)', () => {
    /**
     * The imperial half is anything but a plain decimal: vulgar fractions,
     * mixed numbers, "fl oz", compound runs. When it failed to match, the
     * metric UNIT was left at the head of the name ("g/1½oz butter").
     */
    it('reads every imperial shape bbc.co.uk prints', () => {
        expect(shape(one('40g/1½oz butter', 'en')))
            .toEqual({ q: 40, max: null, unit: 'g', name: 'butter' });
        expect(shape(one('150 g/5 ½ oz 00 flour', 'en')))
            .toEqual({ q: 150, max: null, unit: 'g', name: '00 flour' });
        expect(shape(one('600ml/20fl oz chicken or vegetable stock', 'en')))
            .toEqual({ q: 600, max: null, unit: 'ml', name: 'chicken or vegetable stock' });
        expect(shape(one('1kg/2lb 4oz lean beef mince', 'en')))
            .toEqual({ q: 1, max: null, unit: 'kg', name: 'lean beef mince' });
        expect(shape(one('4 g/⅛ oz easy-blend dried yeast', 'en')))
            .toEqual({ q: 4, max: null, unit: 'g', name: 'easy-blend dried yeast' });
    });

    it('keeps the metric half when the other half is cups', () => {
        expect(shape(one('2 cups / 500 ml red wine', 'en')))
            .toEqual({ q: 500, max: null, unit: 'ml', name: 'red wine' });
        expect(shape(one('1/3 cup / 50g flour', 'en')))
            .toEqual({ q: 50, max: null, unit: 'g', name: 'flour' });
    });

    /** A slash that is NOT a dual measurement is a synonym pair — split only
     *  when both halves name a known food; the second becomes the note. */
    it('does not confuse a synonym slash with a measurement slash', () => {
        const p = one('2 tsp cornflour / cornstarch', 'en');
        expect(shape(p)).toEqual({ q: 2, max: null, unit: 'tsp', name: 'cornflour' });
        expect(p.note).toContain('cornstarch');
        expect(shape(one('1 1/2 cups chicken stock/broth', 'en')))
            .toEqual({ q: 1.5, max: null, unit: 'cup', name: 'chicken stock' });
    });
});

describe('head-of-line amount grammar', () => {
    /** "2 x 400g tins" — the multiplier feeds the existing pack-size fold. */
    it('reads an N x SIZE multiplier', () => {
        const p = one('2 x 400g tins chopped tomatoes', 'en');
        expect(shape(p)).toEqual({ q: 800, max: null, unit: 'g', name: 'tomatoes' });
        expect(p.nameFull).toBe('chopped tomatoes');
        expect(shape(one('1 x 1.5kg whole free-range chicken', 'en')))
            .toEqual({ q: 1.5, max: null, unit: 'kg', name: 'whole free-range chicken' });
        // The container and its dangling "of" stack; both must go.
        expect(shape(one('1 x 250g packet of cooked lentils', 'en')))
            .toEqual({ q: 250, max: null, unit: 'g', name: 'lentils' });
        expect(shape(one('2 x blocks white marzipan', 'en')))
            .toEqual({ q: 2, max: null, unit: null, name: 'white marzipan' });
    });

    /** sallysbakingaddiction spells the mixed number: "3 and 1/4 cups".
     *  Anchored and fraction-required, so "salt and pepper" is untouched. */
    it('reads an "N and F" mixed number', () => {
        expect(shape(one('1 and 1/2 teaspoons ground cinnamon', 'en')))
            .toEqual({ q: 1.5, max: null, unit: 'tsp', name: 'ground cinnamon' });
        const parts = parseIngredientLine('salt and pepper', 'en');
        expect(parts.map(p => p.name)).toEqual(['salt', 'pepper']);
    });

    /** A second amount after "plus" cannot be added (different units) — it
     *  moves to the note and the FIRST amount stays authoritative. */
    it('moves a "plus <amount>" tail to the note', () => {
        const p = one('1 Tbsp. plus 1½ tsp. kasoori methi', 'en');
        expect(shape(p)).toEqual({ q: 1, max: null, unit: 'tbsp', name: 'kasoori methi' });
        expect(p.note).toContain('plus 1½ tsp.');
        const q = one('25g melted butter plus extra for cooking', 'en');
        expect(shape(q)).toEqual({ q: 25, max: null, unit: 'g', name: 'butter' });
    });

    /** A LEADING size adjective hid the quantity from takeQuantity, which ran
     *  first — "Scant ½ teaspoon" lost both the ½ and the teaspoon. */
    it('reads a quantity behind a leading size adjective', () => {
        const p = one('Scant ½ teaspoon fine salt, to taste', 'en');
        expect(shape(p)).toEqual({ q: 0.5, max: null, unit: 'tsp', name: 'fine salt' });
        expect(p.toTaste).toBe(true);
    });
});

describe('parenthetical metric restatement', () => {
    /**
     * TRAP — the silent one. "8 tablespoons (113g) butter" parsed as 904 g:
     * the bracket was read as a package size and MULTIPLIED, but a US baking
     * site is RESTATING the measure it just wrote. If a mass/volume unit was
     * already taken from the line, the bracket replaces the amount; a count
     * (or no unit) still multiplies — that path is pinned above by
     * "1 (400 g) can chopped tomatoes" and "1 28 oz. can crushed tomatoes**".
     */
    it('replaces the amount instead of multiplying', () => {
        const p = one('8 tablespoons (113g) butter, cut into 6 pieces', 'en');
        expect(shape(p)).toEqual({ q: 113, max: null, unit: 'g', name: 'butter' });
        expect(shape(one('8 ounces (227g) mozzarella cheese, shredded', 'en')))
            .toEqual({ q: 227, max: null, unit: 'g', name: 'mozzarella cheese' });
        expect(shape(one('1/2 cup (60g) King Arthur Unbleached All-Purpose Flour', 'en')))
            .toEqual({ q: 60, max: null, unit: 'g', name: 'King Arthur Unbleached All-Purpose Flour' });
        expect(shape(one('1 1/4 teaspoons (8g) table salt', 'en')))
            .toEqual({ q: 8, max: null, unit: 'g', name: 'table salt' });
        expect(shape(one('2 tbsp cornflour/cornstarch ((20g))', 'en')))
            .toEqual({ q: 20, max: null, unit: 'g', name: 'cornflour' });
        expect(shape(one('3 and 1/4 cups (423g) bread flour', 'en')))
            .toEqual({ q: 423, max: null, unit: 'g', name: 'bread flour' });
    });
});

describe('the span between the unit and the noun', () => {
    /** A container after a mass unit was never stripped — "400g can chickpeas"
     *  went shopping for a "can chickpeas". "canned"/"jarred" stay whole. */
    it('strips a container noun that survived the unit', () => {
        expect(shape(one('400g / 14oz can chickpeas (, drained)', 'en')))
            .toEqual({ q: 400, max: null, unit: 'g', name: 'chickpeas' });
        expect(shape(one('300g pack silken tofu drained', 'en')))
            .toEqual({ q: 300, max: null, unit: 'g', name: 'silken tofu' });
        expect(shape(one('1 (8-oz.) bottle clam juice', 'en')))
            .toEqual({ q: 1, max: null, unit: null, name: 'clam juice' });
    });

    it('strips a dangling "of" after a vague unit', () => {
        expect(shape(one('Pinch of red pepper flakes', 'en')))
            .toEqual({ q: 1, max: null, unit: 'pinch', name: 'red pepper flakes' });
        expect(shape(one('½ small bunch of coriander finely chopped', 'en')))
            .toEqual({ q: 0.5, max: null, unit: 'bunch', name: 'coriander' });
    });

    /** English puts the participle AFTER the noun as often as before it. The
     *  fuller phrase stays in nameFull — same contract as the leading rule. */
    it('moves a trailing prep participle into the note', () => {
        const p = one('3 cardamom pods crushed', 'en');
        expect(shape(p)).toEqual({ q: 3, max: null, unit: null, name: 'cardamom pods' });
        expect(p.nameFull).toBe('cardamom pods crushed');
        expect(shape(one('100g butter chopped', 'en')))
            .toEqual({ q: 100, max: null, unit: 'g', name: 'butter' });
        expect(shape(one('1 lime juiced', 'en')))
            .toEqual({ q: 1, max: null, unit: null, name: 'lime' });
        // Without the adverb group the strip strands it: "red cabbage finely".
        expect(shape(one('¼ red cabbage finely shredded', 'en')))
            .toEqual({ q: 0.25, max: null, unit: null, name: 'red cabbage' });
    });

    /**
     * TRAP. The glued-unit splitter exists for receptai.lt's template bug, but
     * its candidate list holds the ENGLISH aliases too — "Canola oil" became a
     * can of "ola oil" and "Ribeye" a stalk of "eye". No glue outside LT.
     */
    it('never glue-splits an English word', () => {
        expect(shape(one('Canola oil', 'en')))
            .toEqual({ q: null, max: null, unit: null, name: 'Canola oil' });
        const p = one('1 large jarred roasted red pepper', 'en');
        expect(shape(p)).toEqual({ q: 1, max: null, unit: null, name: 'jarred roasted red pepper' });
        const rib = one('2 Ribeye, New York, or Tri Tip steaks', 'en');
        expect(rib.name).not.toBe('eye');
        expect(rib.unit).not.toBe('stalk');
    });
});

describe('headings and serving remarks', () => {
    it('ignores a heading that ends in a dash', () => {
        expect(one('Sauce options -', 'en').ignored).toBe(true);
        // …while a bare ingredient stays an ingredient.
        expect(one('Black pepper', 'en').ignored).toBe(false);
    });

    /** TRAP. The multi-ingredient split ran on the RAW line, before the
     *  parentheses were peeled — the comma INSIDE "(, optional)" was a split
     *  point and "Naan (, optional)" became two ingredients. */
    it('does not split inside parentheses', () => {
        const parts = parseIngredientLine('Naan (, optional)', 'en');
        expect(parts).toHaveLength(1);
        expect(parts[0].name).toBe('Naan');
        expect(parts[0].optional).toBe(true);
    });

    it('drops a serving remark instead of buying it', () => {
        const chips = parseIngredientLine('Tortilla chips, for serving', 'en');
        expect(chips).toHaveLength(1);
        expect(chips[0].name).toBe('Tortilla chips');
        const serve = parseIngredientLine(
            'lime wedges, rice, guacamole, soured cream and green salad, to serve', 'en');
        expect(serve.map(p => p.name))
            .toEqual(['lime wedges', 'rice', 'guacamole', 'soured cream', 'green salad']);
    });

    /** A heading GLUED to the first ingredient — mid-line colon, so
     *  isSectionHeading cannot see it. The optional flag must survive the
     *  strip, and the " or ½ cup…" alternative carries its own amount, so it
     *  moves to the note rather than staying in the name. */
    it('peels a glued heading and an alternative-with-amount', () => {
        const p = one('Optional, for creamy dressing: 2 tablespoons tahini or ½ cup whole-milk Greek yogurt', 'en');
        expect(shape(p)).toEqual({ q: 2, max: null, unit: 'tbsp', name: 'tahini' });
        expect(p.optional).toBe(true);
    });
});

describe('parseIngredientLines', () => {
    it('flattens a whole list and keeps ignored lines visible', () => {
        const out = parseIngredientLines([
            '500 gramų vištienos filė',
            'Padažui:',
            'Druskos, pipirų',
            '',
        ], 'lt');
        expect(out).toHaveLength(4);              // 1 + 1 heading + 2 split, empty dropped
        expect(out.filter(p => p.ignored)).toHaveLength(1);
        expect(out[0].raw).toBe('500 gramų vištienos filė');
    });

    it('never loses the published line', () => {
        const raw = '440 gramųkonservuotų pupelių(tamsios ar šviesios, mažos)';
        expect(parseIngredientLine(raw, 'lt')[0].raw).toBe(raw);
    });
});

/**
 * HOLDOUT ROUND 1 — 23 recipes the parser had never been tuned on. Every case
 * below is a real published line that the tuned parser still got wrong, which is
 * the point of keeping a holdout: the training corpus had stopped teaching.
 */
describe('lines found by the first holdout set', () => {
    it('keeps the metric half when the units are spelled out', () => {
        // bbcgoodfood writes "1 litre / 4 cups"; only abbreviations were handled,
        // so "4 cups" was left sitting at the head of the ingredient name.
        expect(shape(one('1 litre / 4 cups beef stock/broth', 'en')))
            .toEqual({ q: 1, max: null, unit: 'l', name: 'beef stock' });
        const pints = one('1 litre/1¾ pints chicken stock or fish stock', 'en');
        expect(pints.unit).toBe('l');
        expect(pints.name).not.toMatch(/litre|pint/i);
    });

    /** A colon whose tail is NOT an amount: which side is the ingredient depends
     *  on whether the head is a heading or a thing. */
    it('reads a purpose after the colon as a note, not as the ingredient', () => {
        // The trailing "pagal poreikį" splits off as its own (ignored) fragment,
        // so take the first thing that is actually an ingredient.
        const p = parseIngredientLine('Aliejus: kepimui, pagal poreikį.', 'lt')
            .find(x => !x.ignored)!;
        expect(p.name).toBe('Aliejus');
        expect(p.note).toMatch(/kepimui/);
    });

    it('drops a section heading in front of the colon', () => {
        expect(one('Optional garnish: toasted sesame seeds', 'en').name)
            .toBe('toasted sesame seeds');
        const lt = one('vištienos kulšelės: 6-8Patiekimui:grietinė arba padažas');
        expect(lt.name).toBe('vištienos kulšelės');
    });

    /** "zest and juice of 1 lime" — the shopping is the lime. */
    it('buys the fruit a zest or juice is taken from', () => {
        expect(shape(one('zest and juice of 1 lime', 'en')))
            .toEqual({ q: 1, max: null, unit: null, name: 'lime' });
        expect(one('juice of 2 lemons', 'en').name).toBe('lemons');
    });
});

/**
 * THE SECOND HOLDOUT ROUND — lines that only 23 unseen recipes produced.
 *
 * Lithuanian sites glue the unit onto whatever follows it, and the split has to
 * survive an opening typographic quote: with a letter demanded after the alias,
 * the correct "gramų" split was rejected and the shorter "gram" won, naming the
 * ingredient "ų„dansukker" cukrus".
 */
describe('glued units from the second holdout', () => {
    const one = (line: string) => parseIngredientLine(line, 'lt').find(x => !x.ignored)!;

    it('splits a unit glued onto an opening quote', () => {
        expect(one('250 gramų„dansukker“ cukrus uogienėms').name).not.toMatch(/^ų/);
        expect(one('250 gramų„dansukker“ cukrus uogienėms').unit).toBe('g');
    });

    it.each([
        ['3 vienetaikiaušiniai', 'kiaušiniai', 'pcs'],
        ['1 vienetassvogūnai', 'svogūnai', 'pcs'],
        ['200 gramųryžiai', 'ryžiai', 'g'],
        ['1 šaukšteliodruska', 'druska', 'tsp'],
    ])('%s → %s', (line, name, unit) => {
        const p = one(line);
        expect(p.name).toBe(name);
        expect(p.unit).toBe(unit);
    });
});

/**
 * Water was the commonest "unmatched ingredient" in the holdout, and calling it
 * a failed match is wrong twice: nothing was mis-parsed, and there is nothing to
 * buy. The line is kept and marked ignored — but only when it is TAP water.
 */
describe('water is not a purchase', () => {
    const first = (line: string, lang: 'lt' | 'en' = 'en') => parseIngredientLine(line, lang)[0];

    it.each([
        ['500 ml water', 'en'], ['warm water', 'en'], ['200 ml boiling water', 'en'],
        ['200 ml vandens', 'lt'], ['1 l šalto vandens', 'lt'],
    ])('ignores %s', (line, lang) => {
        expect(first(line, lang as 'lt' | 'en').ignored).toBe(true);
    });

    /** Everything you can actually put in a basket stays shoppable. */
    it.each([
        ['500 ml mineralinio vandens', 'lt'], ['200 ml coconut water', 'en'],
        ['1 tbsp rose water', 'en'], ['500 ml sparkling water', 'en'],
    ])('still buys %s', (line, lang) => {
        expect(first(line, lang as 'lt' | 'en').ignored).toBe(false);
    });

    /** "apie 400 ml vandens" (beatosvirtuve.lt) — the spelled approximation hid
     *  the number from the grammar AND kept "apie" in the name, so TAP_WATER
     *  never saw plain "vandens" and tap water reached the basket unmatched. */
    it('still ignores tap water behind a spelled approximation', () => {
        const p = first('apie 400 ml vandens', 'lt');
        expect(p.ignored).toBe(true);
        expect(shape(p)).toEqual({ q: 400, max: null, unit: 'ml', name: 'vandens' });
    });
});

/**
 * Lines a shopper never buys — each one reached the basket as an unmatched row
 * on the 180-recipe baseline sweep. Same treatment as tap water: the line is
 * kept and marked ignored, so the UI can show it in the "not added" list.
 */
describe('non-ingredients are not purchases', () => {
    const first = (line: string, lang: 'lt' | 'en' = 'lt') => parseIngredientLine(line, lang)[0];

    it.each([
        // valgom.lt prints the dough-PROVING step inside its ingredient list —
        // an instruction, not a thing, even though it carries an amount.
        ['tešlos rauginimas'],
        ['1 a.š. tešlos rauginimas'],
        // Ice cubes are tap water in another shape; receptai.lt also glues them.
        ['ledukai'],
        ['šiek tiekledukai'],
        ['200 mililitrųledukai(kubeliai)'],
        // A garnish INSTRUCTION — dative of purpose, no amount anywhere.
        ['daigų papuošimui'],
    ])('ignores %s', (line) => {
        expect(first(line).ignored).toBe(true);
    });

    it.each([
        // "ledai" is ICE CREAM — one letter from "ledukai" and a real product.
        ['ledai', 'lt'],
        // With an amount the site is telling us to BUY the garnish.
        ['100 g šokolado papuošimui', 'lt'],
    ])('still buys %s', (line, lang) => {
        expect(first(line, lang as 'lt' | 'en').ignored).toBe(false);
    });
});

/**
 * VALIDATION ROUND over 60 LT recipes — 15min.lt and greitireceptai.lt write
 * the amount INSIDE the ingredient text, after the name: "Bulvės 2,5 kg".
 * The decimal comma was read as the prep-note comma (name "Bulvės 2", note
 * "5 kg"), the quantity was lost, and every such line bought the 0.3 kg
 * fallback — a systematic UNDERBUY the shopper cannot cook around.
 */
describe('trailing amounts (15min.lt / greitireceptai.lt)', () => {
    it.each([
        ['Bulvės 2,5 kg', 'Bulvės', 2.5, 'kg'],
        ['Varškė 500 g', 'Varškė', 500, 'g'],
        ['Svogūnai 4 vnt', 'Svogūnai', 4, 'pcs'],
        ['Šoninė 500 g', 'Šoninė', 500, 'g'],
    ])('%s → %s', (line, name, quantity, unit) => {
        expect(shape(one(line))).toEqual({ q: quantity, max: null, unit, name });
    });

    /**
     * TRAP. With the trailing amount left in the name, the UNIT leaked into the
     * match query — "Romas 4 šaukštai" (four tablespoons of rum) matched
     * "Pietų šaukštai LAGUNA, 3": CUTLERY, because "šaukštai" dominated. Every
     * drink recipe hits this shape, comma or no comma.
     */
    it('strips the unit out of the query instead of buying cutlery', () => {
        expect(shape(one('Romas 4 šaukštai')))
            .toEqual({ q: 4, max: null, unit: 'tbsp', name: 'Romas' });
        expect(shape(one('Romas, 4 šaukštai')))
            .toEqual({ q: 4, max: null, unit: 'tbsp', name: 'Romas' });
    });

    /** The refit only fires when EVERYTHING after the first number is an
     *  amount — these lines carry trailing numbers that are not one, and each
     *  is pinned elsewhere in this file with its correct reading. */
    it('leaves a trailing number that is not an amount alone', () => {
        const p = one('50 gramų grietinėlės, 35%');
        expect(p.name).toBe('grietinėlės');
        expect(p.note).toBe('35%');
        expect(shape(one('zest and juice of 1 lime', 'en')))
            .toEqual({ q: 1, max: null, unit: null, name: 'lime' });
    });

    /** greitireceptai.lt also prints a VAGUE amount after the name — "Vanilinas
     *  žiupsnelis" (a pinch of vanillin). With no number to find, the whole
     *  string survived as the name and matched nothing. */
    it('reads a bare pinch-word trailing the name', () => {
        expect(shape(one('Vanilinas žiupsnelis')))
            .toEqual({ q: 1, max: null, unit: 'pinch', name: 'Vanilinas' });
    });

    /** Pinch-words only: a trailing count/package unit names a PART of the
     *  product, and reading it as an amount of one would underbuy. */
    it('does not read a trailing part-unit as an amount', () => {
        expect(shape(one('duonos riekelės')))
            .toEqual({ q: null, max: null, unit: null, name: 'duonos riekelės' });
    });
});

/**
 * "apie 400 ml vandens", "maždaug 200 g miltų" — the spelled approximation
 * markers hid the number from the quantity grammar exactly as a "~" does, and
 * the marker itself survived at the head of the NAME. Digit-gated: a name that
 * merely starts with one of these words loses nothing.
 */
describe('spelled approximation markers', () => {
    it.each([
        ['apie 400 ml vandens', 400, 'ml', 'vandens'],
        ['maždaug 200 g miltų', 200, 'g', 'miltų'],
        ['about 2 cups flour', 2, 'cup', 'flour'],
    ])('%s', (line, q, unit, name) => {
        const lang = /about/.test(line as string) ? 'en' : 'lt';
        expect(shape(one(line as string, lang as Lang)))
            .toEqual({ q, max: null, unit, name });
    });
});

/**
 * VALIDATION ROUND — some LT sites write "Ingredient, preparation, amount",
 * and the preparation is exactly the word that selects the right product.
 * Noted away, "Agurkai, marinuoti, 4 vienetai" bought FRESH cucumbers instead
 * of pickled, and "Dešra, virta, 100 gramų" a VEGAN pepperoni instead of a
 * cooked sausage. The participle must survive INTO the name.
 */
describe('comma-separated preparation that selects the product', () => {
    it('folds the participle back in front of the noun', () => {
        expect(shape(one('Agurkai, marinuoti, 4 vienetai')))
            .toEqual({ q: 4, max: null, unit: 'pcs', name: 'marinuoti Agurkai' });
        const p = one('Dešra, virta, 100 gramų');
        expect(shape(p)).toEqual({ q: 100, max: null, unit: 'g', name: 'virta Dešra' });
        // "virta" is in LT_PREP_LEAD (as prep it usually is), so the fold must
        // also survive the leading-participle strip — nameFull included.
        expect(p.nameFull).toBe('virta Dešra');
    });

    /** With no amount on the line, the multi-ingredient split used to claim it
     *  first — two rows, the second literally named "marinuoti". */
    it('does not split the participle off as a phantom ingredient', () => {
        const parts = parseIngredientLine('Agurkai, marinuoti', 'lt');
        expect(parts).toHaveLength(1);
        expect(parts[0].name).toBe('marinuoti Agurkai');
    });

    /** A multi-word tail is an instruction, not a category — it stays a note,
     *  and the name stays the noun. */
    it('keeps a multi-word prep tail as a note', () => {
        const p = one('500 gramų bulvių, virtų ir sutarkuotų');
        expect(shape(p)).toEqual({ q: 500, max: null, unit: 'g', name: 'bulvių' });
        expect(p.note).toContain('virtų ir sutarkuotų');
    });

    /** The MIRROR shape: the comma leaves the identity participle as the HEAD
     *  and the noun in the tail. Noted away, the name became the bare "virtos"
     *  and confidently bought cooked SAUSAGES for a poultry stew. */
    it('keeps the line whole when the participle leads and the noun trails', () => {
        const p = one('Apie 800 g virtos, keptos arba rūkytos paukštienos');
        expect(shape(p)).toEqual({
            q: 800, max: null, unit: 'g', name: 'virtos keptos arba rūkytos paukštienos',
        });
    });
});

/**
 * VALIDATION ROUND — a fragment that is ONLY a modifier is never a thing to
 * buy, and split off as its own ingredient it matched something absurd with
 * full confidence: "grietinė, rūgšti" emitted a bare "rūgšti" that matched
 * "Rūgšti spurga su braškiniu įdaru" (a SOUR DOUGHNUT), and "šviežio ir
 * džiovinto raudonėlio" a bare "šviežio" that matched "Šviežio maisto
 * maitintuvas CANPOL" — a baby-nursery FEEDER. The lexicon decides what is a
 * modifier (one word naming no known food), not an adjective list.
 */
describe('modifier-only fragments are never their own ingredient', () => {
    it('folds "grietinė, rūgšti" into the real product', () => {
        const parts = parseIngredientLine('grietinė, rūgšti', 'lt');
        expect(parts).toHaveLength(1);
        expect(parts[0].name).toBe('rūgšti grietinė');
    });

    it('keeps "šviežio ir džiovinto raudonėlio" whole', () => {
        const parts = parseIngredientLine('šviežio ir džiovinto raudonėlio', 'lt');
        expect(parts).toHaveLength(1);
        // No fold target here (the noun is inside the second half), so the
        // line survives intact — the noun stays in the query, never a bare
        // "šviežio".
        expect(parts[0].name).toBe('šviežio ir džiovinto raudonėlio');
    });

    /** A dative purpose word is not a modifier to fold — "Aliejus, kepimui"
     *  is oil FOR frying, and the colon shape of the same line already files
     *  "kepimui" as the note. It must not become a phantom row either. */
    it('notes a purpose tail instead of buying or wearing it', () => {
        const parts = parseIngredientLine('Aliejus, kepimui', 'lt');
        expect(parts).toHaveLength(1);
        expect(parts[0].name).toBe('Aliejus');
        expect(parts[0].note).toContain('kepimui');
    });

    /** The guard is one-word-only: known single words and multi-word parts
     *  still split — the lexicon knows these three, and "green salad"-style
     *  unknowns carry their own noun. */
    it('still splits a genuine bare-ingredient list', () => {
        const parts = parseIngredientLine('Druskos, pipirų, lauro lapų', 'lt');
        expect(parts.map(p => p.name)).toEqual(['Druskos', 'pipirų', 'lauro lapų']);
    });
});

/**
 * "2 teaspoons EACH: black pepper, garlic powder, onion powder" — one measure
 * spread over several ingredients. Three spices used to arrive as a single
 * ingredient literally named "each", and the other two were lost.
 */
describe('an amount that applies to each of several ingredients', () => {
    const names = (line: string) => parseIngredientLine(line, 'en').filter(p => !p.ignored).map(p => p.name);

    it('splits a colon list and gives every part the same amount', () => {
        const parts = parseIngredientLine('2 teaspoons each: black pepper, garlic powder, onion powder', 'en');
        expect(parts.map(p => p.name)).toEqual(['black pepper', 'garlic powder', 'onion powder']);
        for (const p of parts) expect(p).toMatchObject({ quantity: 2, unit: 'tsp' });
    });

    it.each([
        ['1 tsp each salt and pepper', ['salt', 'pepper']],
        ['1 tsp each of salt and pepper', ['salt', 'pepper']],
        ['2 tsp EACH black pepper, onion powder, mustard powder', ['black pepper', 'onion powder', 'mustard powder']],
    ])('%s', (line, expected) => {
        expect(names(line)).toEqual(expected);
    });

    /** The OTHER "each" — a US listing unit meaning one of the thing. */
    it('reads "1 each red onion" as a single piece of red onion', () => {
        const p = parseIngredientLine('1 each red onion', 'en')[0];
        expect(p).toMatchObject({ name: 'red onion', quantity: 1, unit: 'pcs' });
    });
});
