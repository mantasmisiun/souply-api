/**
 * RECIPE UNITS — the alias table and the metric constants behind it.
 *
 * Everything here was harvested from a 67-recipe corpus (lamaistas.lt,
 * receptai.lt, beatosvirtuve.lt, budgetbytes.com, recipetineats.com, food.com,
 * bbcgoodfood.com) and is maintained BY HAND. When a new site prints a form we
 * miss, add the form here — never "fix" it with stemming or fuzzy matching:
 * Lithuanian noun endings collide with ingredient words far too easily
 * ("skiltelė" clove vs "skiltelės" of an orange, "lapų" sheet vs bay leaves),
 * so the table stays an explicit whitelist.
 *
 * LT declension policy: recipes print units in nominative and genitive,
 * singular and plural (site templates mix them freely: "1 šaukštas",
 * "2 šaukštai", "5 šaukštų", "pusė šaukšto"), plus the occasional accusative
 * and instrumental ("šaukštą", "šaukštais"). We enumerate those. Dative and
 * locative practically never appear in an ingredient line and are left out —
 * add them only with corpus evidence.
 */

import type { Unit } from './types.js';

// ---------------------------------------------------------------------------
// Alias table
// ---------------------------------------------------------------------------

/**
 * Every surface form → canonical Unit. Keys are LOWERCASE, carry Lithuanian
 * diacritics (lookupUnit handles diacritic-free input by folding), and may be
 * multi-word ('valgomasis šaukštas', 'fl oz').
 *
 * SINGLE-LETTER POLICY (deliberate, do not "clean up"):
 *  - 'g' and 'l' ARE aliased. They collide with Lithuanian words in prose, but
 *    lookupUnit receives an already-tokenised phrase from the unit position
 *    (right after a number), where the caller guards context — "200 g miltų"
 *    is unambiguous there.
 *  - 't'/'T' is NOT aliased. US convention distinguishes t=teaspoon from
 *    T=tablespoon, but lookupUnit lowercases, so the two would be
 *    indistinguishable and one of them silently 3x wrong. Omitted entirely.
 *  - 'c' (US cup) is NOT aliased for the same class of reason: too short, and
 *    absent from the corpus.
 */
export const UNIT_ALIASES: Readonly<Record<string, Unit>> = {
    // ---- mass ------------------------------------------------------------
    // gramas: 'gr' is a common LT print abbreviation ("100 gr miltų").
    'g': 'g', 'gr': 'g', 'gram': 'g', 'grams': 'g',
    'gramas': 'g', 'gramo': 'g', 'gramą': 'g', 'gramai': 'g',
    'gramų': 'g', 'gramus': 'g', 'gramais': 'g',

    'kg': 'kg', 'kilogram': 'kg', 'kilograms': 'kg', 'kilo': 'kg', 'kilos': 'kg',
    'kilogramas': 'kg', 'kilogramo': 'kg', 'kilogramą': 'kg', 'kilogramai': 'kg',
    'kilogramų': 'kg', 'kilogramus': 'kg', 'kilogramais': 'kg',

    'oz': 'oz', 'ounce': 'oz', 'ounces': 'oz',

    'lb': 'lb', 'lbs': 'lb', 'pound': 'lb', 'pounds': 'lb',

    // ---- volume ----------------------------------------------------------
    'ml': 'ml', 'millilitre': 'ml', 'millilitres': 'ml',
    'milliliter': 'ml', 'milliliters': 'ml',
    'mililitras': 'ml', 'mililitro': 'ml', 'mililitrą': 'ml', 'mililitrai': 'ml',
    'mililitrų': 'ml', 'mililitrus': 'ml', 'mililitrais': 'ml',

    'l': 'l', 'litre': 'l', 'litres': 'l', 'liter': 'l', 'liters': 'l',
    'litras': 'l', 'litro': 'l', 'litrą': 'l', 'litrai': 'l',
    'litrų': 'l', 'litrus': 'l', 'litrais': 'l',

    // Teaspoon. LT: "šaukštelis" is ALWAYS the teaspoon — the -elis diminutive
    // is the meaning, not an endearment. "arbatinis šaukštelis" (tea spoon) is
    // the formal name; some sites even print "arbatinis šaukštas". 'a š' /
    // 'a.š' is the print abbreviation "a. š." after lookupUnit strips the
    // trailing period from each token.
    'tsp': 'tsp', 'tsps': 'tsp', 'teaspoon': 'tsp', 'teaspoons': 'tsp',
    'šaukštelis': 'tsp', 'šaukštelio': 'tsp', 'šaukštelį': 'tsp',
    'šaukšteliu': 'tsp', 'šaukšteliai': 'tsp', 'šaukštelių': 'tsp',
    'šaukštelius': 'tsp', 'šaukšteliais': 'tsp',
    'arbatinis šaukštelis': 'tsp', 'arbatinio šaukštelio': 'tsp',
    'arbatinį šaukštelį': 'tsp', 'arbatiniu šaukšteliu': 'tsp',
    'arbatiniai šaukšteliai': 'tsp', 'arbatinių šaukštelių': 'tsp',
    'arbatinius šaukštelius': 'tsp', 'arbatiniais šaukšteliais': 'tsp',
    'arbatinis šaukštas': 'tsp', 'arbatinio šaukšto': 'tsp',
    'arbatiniai šaukštai': 'tsp', 'arbatinių šaukštų': 'tsp',
    'a š': 'tsp', 'a.š': 'tsp', 'arb š': 'tsp', 'arb šaukštelis': 'tsp', 'arb šaukšteliai': 'tsp',

    // Tablespoon. LT: a bare "šaukštas" in a recipe is the TABLE spoon by
    // convention (the teaspoon is always diminutive/qualified — see above).
    // "valgomasis šaukštas" (eating spoon) is the formal name; the corpus
    // prints "valgomieji šaukštai" constantly. 'v š' / 'v.š' = "v. š.".
    'tbsp': 'tbsp', 'tbsps': 'tbsp', 'tbs': 'tbsp',
    'tablespoon': 'tbsp', 'tablespoons': 'tbsp',
    'šaukštas': 'tbsp', 'šaukšto': 'tbsp', 'šaukštą': 'tbsp', 'šaukštu': 'tbsp',
    'šaukšte': 'tbsp', 'šaukštai': 'tbsp', 'šaukštų': 'tbsp',
    'šaukštus': 'tbsp', 'šaukštais': 'tbsp',
    'valgomasis šaukštas': 'tbsp', 'valgomojo šaukšto': 'tbsp',
    'valgomąjį šaukštą': 'tbsp', 'valgomuoju šaukštu': 'tbsp',
    'valgomieji šaukštai': 'tbsp', 'valgomųjų šaukštų': 'tbsp',
    'valgomuosius šaukštus': 'tbsp', 'valgomaisiais šaukštais': 'tbsp',
    'v š': 'tbsp', 'v.š': 'tbsp', 'valg š': 'tbsp', 'valg šaukštas': 'tbsp', 'valg šaukštai': 'tbsp',

    'cup': 'cup', 'cups': 'cup',

    'fl oz': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz',

    'pint': 'pint', 'pints': 'pint',

    'quart': 'quart', 'quarts': 'quart',

    // stiklinė — the Lithuanian drinking glass, its OWN unit (250 ml), NOT a
    // US cup. Mapping it to 'cup' would silently shrink every soviet-era
    // recipe by 4%. See VOLUME_ML for the number's rationale.
    'glass': 'glass', 'glasses': 'glass',
    'stiklinė': 'glass', 'stiklinės': 'glass', 'stiklinę': 'glass',
    'stiklinių': 'glass', 'stiklines': 'glass', 'stiklinėmis': 'glass',
    // "puodelis" is the other Lithuanian household measure — a mug, and by
    // convention the same 250 ml as a stiklinė. Deliberately NOT 'cup': that is
    // the 240 ml US cup, and mapping a Lithuanian recipe onto it would shave 4 %
    // off every amount for no reason.
    'puodelis': 'glass', 'puodelio': 'glass', 'puodeliai': 'glass',
    'puodelių': 'glass', 'puodeliu': 'glass', 'puodelį': 'glass',

    // ---- countable / vague ------------------------------------------------
    'pc': 'pcs', 'pcs': 'pcs', 'piece': 'pcs', 'pieces': 'pcs',
    // US grocery listing style: "1 each red onion". Distinct from the "2 tsp
    // EACH: a, b, c" sense, which distributes one amount over several
    // ingredients and is split before any unit is read.
    'each': 'pcs',
    'vnt': 'pcs',  // 'vnt.' arrives here after period stripping
    'vienetas': 'pcs', 'vieneto': 'pcs', 'vienetą': 'pcs', 'vienetai': 'pcs',
    'vienetų': 'pcs', 'vienetus': 'pcs', 'vienetais': 'pcs',

    'clove': 'clove', 'cloves': 'clove',
    'skiltelė': 'clove', 'skiltelės': 'clove', 'skiltelę': 'clove',
    'skiltele': 'clove', 'skiltelių': 'clove', 'skilteles': 'clove',
    'skiltelėmis': 'clove',

    'slice': 'slice', 'slices': 'slice',
    'riekė': 'slice', 'riekės': 'slice', 'riekę': 'slice',
    'riekių': 'slice', 'riekes': 'slice',
    'riekelė': 'slice', 'riekelės': 'slice', 'riekelę': 'slice',
    'riekelių': 'slice', 'riekeles': 'slice',

    'head': 'head', 'heads': 'head',
    'galva': 'head', 'galvos': 'head', 'galvą': 'head', 'galvų': 'head',
    'galvas': 'head',
    'galvutė': 'head', 'galvutės': 'head', 'galvutę': 'head',
    'galvučių': 'head', 'galvutes': 'head',

    // pundelis and ryšulėlis are interchangeable "small bundle" words — the
    // corpus has both ("1 pundelis krapų", "Ryšulėlio krapų").
    'bunch': 'bunch', 'bunches': 'bunch',
    'pundelis': 'bunch', 'pundelio': 'bunch', 'pundelį': 'bunch',
    'pundeliai': 'bunch', 'pundelių': 'bunch', 'pundelius': 'bunch',
    'ryšulėlis': 'bunch', 'ryšulėlio': 'bunch', 'ryšulėlį': 'bunch',
    'ryšulėliai': 'bunch', 'ryšulėlių': 'bunch',

    // saujelė (diminutive) prints as often as sauja; same nominal size — a
    // recipe author who writes "saujelė" is being modest, not halving.
    'handful': 'handful', 'handfuls': 'handful',
    'sauja': 'handful', 'saujos': 'handful', 'saują': 'handful',
    'saujų': 'handful', 'saujas': 'handful',
    'saujelė': 'handful', 'saujelės': 'handful', 'saujelę': 'handful',
    'saujelių': 'handful', 'saujeles': 'handful',

    'pinch': 'pinch', 'pinches': 'pinch',
    'žiupsnelis': 'pinch', 'žiupsnelio': 'pinch', 'žiupsnelį': 'pinch',
    'žiupsneliu': 'pinch', 'žiupsneliai': 'pinch', 'žiupsnelių': 'pinch',
    'žiupsnelius': 'pinch', 'žiupsneliais': 'pinch',
    'žiupsnis': 'pinch', 'žiupsnio': 'pinch', 'žiupsnį': 'pinch',
    'žiupsniai': 'pinch', 'žiupsnių': 'pinch',

    // 'jar' rides on 'can': the corpus's "1 (15 ounce) jar salsa" is the same
    // concept (a fixed retail container of preserved food) and there is no
    // closer member. Vague either way — the caller flags it approximate.
    'can': 'can', 'cans': 'can', 'tin': 'can', 'tins': 'can',
    'jar': 'can', 'jars': 'can',
    'skardinė': 'can', 'skardinės': 'can', 'skardinę': 'can',
    'skardinių': 'can', 'skardines': 'can',

    // 'punnet' (berries/tomatoes) and 'tub' (sour cream) are retail packages;
    // 'pack' is the generic "one package" member, so they belong here.
    'pack': 'pack', 'packs': 'pack', 'package': 'pack', 'packages': 'pack',
    'packet': 'pack', 'packets': 'pack', 'pkg': 'pack', 'pkgs': 'pack',
    'punnet': 'pack', 'punnets': 'pack', 'tub': 'pack', 'tubs': 'pack',
    'pak': 'pack',  // 'pak.' — LT print abbreviation
    'pakelis': 'pack', 'pakelio': 'pack', 'pakelį': 'pack',
    'pakeliai': 'pack', 'pakelių': 'pack', 'pakelius': 'pack',
    'pakuotė': 'pack', 'pakuotės': 'pack', 'pakuotę': 'pack',
    'pakuočių': 'pack', 'pakuotes': 'pack',

    'sprig': 'sprig', 'sprigs': 'sprig',
    'šakelė': 'sprig', 'šakelės': 'sprig', 'šakelę': 'sprig',
    'šakelių': 'sprig', 'šakeles': 'sprig', 'šakelėmis': 'sprig',

    // 'rib'/'ribs' — the corpus's "2 ribs celery" is US usage where a celery
    // rib IS a stalk. Ambiguity with meat ribs is the caller's context
    // problem (meat lines carry a mass unit first, so 'ribs' never reaches
    // the unit position there).
    'stalk': 'stalk', 'stalks': 'stalk', 'rib': 'stalk', 'ribs': 'stalk',
    'stiebas': 'stalk', 'stiebo': 'stalk', 'stiebą': 'stalk',
    'stiebai': 'stalk', 'stiebų': 'stalk', 'stiebus': 'stalk',

    // lakštas is THE sheet word (lasagne, filo); lapas/lapelis ("leaf") is how
    // gelatine sheets are actually printed ("2 želatinos lapeliai"). A bay
    // LEAF is an ingredient, not a unit — but that distinction lives in the
    // caller (no number-unit-name shape), not in this table.
    'sheet': 'sheet', 'sheets': 'sheet',
    'lakštas': 'sheet', 'lakšto': 'sheet', 'lakštą': 'sheet',
    'lakštai': 'sheet', 'lakštų': 'sheet', 'lakštus': 'sheet',
    'lapas': 'sheet', 'lapo': 'sheet', 'lapą': 'sheet',
    'lapai': 'sheet', 'lapų': 'sheet', 'lapus': 'sheet',
    'lapelis': 'sheet', 'lapelio': 'sheet', 'lapelį': 'sheet',
    'lapeliai': 'sheet', 'lapelių': 'sheet', 'lapelius': 'sheet',

    // šlakelis ("a splash") rides on 'drop' — the only splash-like member.
    // Its nominal 0.05 ml badly understates a real splash (~3 ml), but every
    // corpus use is a to-taste drizzle of vinegar/oil where the estimate is
    // decorative; the approx flag covers us.
    'drop': 'drop', 'drops': 'drop',
    'lašas': 'drop', 'lašo': 'drop', 'lašą': 'drop', 'lašai': 'drop',
    'lašų': 'drop', 'lašus': 'drop',
    'lašelis': 'drop', 'lašelio': 'drop', 'lašeliai': 'drop', 'lašelių': 'drop',
    'šlakelis': 'drop', 'šlakelio': 'drop', 'šlakeliai': 'drop',
    'šlakelių': 'drop',

    // cm — "2 cm šviežio imbiero šaknies": a length of root, count-dimension
    // by design (converting cm of ginger to grams needs a per-ingredient
    // thickness we don't pretend to have).
    'cm': 'cm',
    'centimetras': 'cm', 'centimetro': 'cm', 'centimetrą': 'cm',
    'centimetrai': 'cm', 'centimetrų': 'cm', 'centimetrus': 'cm',
    'centimetrais': 'cm',
};

/**
 * Longest alias phrase, in words — the parser windows tokens down from this.
 * Currently 2 ('valgomasis šaukštas', 'fl oz', …). The test suite recomputes
 * this from the table and fails if a longer key sneaks in without bumping it.
 */
export const MAX_UNIT_WORDS = 2;

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Lithuanian diacritic folding — recipes and users routinely type 'saukstas'
 * for 'šaukštas' (phone keyboards, lazy CMSes). We fold the TABLE, not the
 * language: only the nine LT diacritic letters, nothing Unicode-general.
 */
const LT_FOLD: Record<string, string> = {
    'ą': 'a', 'č': 'c', 'ę': 'e', 'ė': 'e', 'į': 'i',
    'š': 's', 'ų': 'u', 'ū': 'u', 'ž': 'z',
};

function foldDiacritics(s: string): string {
    return s.replace(/[ąčęėįšųūž]/g, ch => LT_FOLD[ch]);
}

/**
 * Exact aliases first, then folded variants only where they don't collide —
 * exact keys always win, so a folded form can never shadow a real alias.
 * (Today no folded form of one unit equals an exact form of another; the
 * two-pass build keeps that true even if the table grows.)
 */
const LOOKUP = new Map<string, Unit>();
for (const [alias, unit] of Object.entries(UNIT_ALIASES)) {
    LOOKUP.set(alias, unit);
}
for (const [alias, unit] of Object.entries(UNIT_ALIASES)) {
    const folded = foldDiacritics(alias);
    if (!LOOKUP.has(folded)) LOOKUP.set(folded, unit);
}

/**
 * Resolve one alias phrase → Unit, or null when it isn't one.
 * Tolerates any case, surrounding whitespace, trailing periods on each token
 * ('vnt.', 'v. š.'), and missing Lithuanian diacritics.
 */
export function lookupUnit(phrase: string): Unit | null {
    // Periods are separators, not letters. Lithuanian sites abbreviate the spoon
    // every possible way — "v. š.", "valg.š.", "arb. š." — and stripping only the
    // TRAILING period left "valg. š" unmatchable, so the amount was lost.
    const norm = phrase
        .toLowerCase()
        .replace(/\./g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');
    if (!norm) return null;
    return LOOKUP.get(norm) ?? LOOKUP.get(foldDiacritics(norm)) ?? null;
}

// ---------------------------------------------------------------------------
// Metric sizes
// ---------------------------------------------------------------------------

/** Grams in one of this unit. Mass units only. */
export const MASS_G: Readonly<Partial<Record<Unit, number>>> = {
    g: 1,
    kg: 1000,
    oz: 28.3495,   // avoirdupois ounce
    lb: 453.592,   // 16 oz
};

/**
 * Millilitres in one of this unit. Volume units only.
 *
 * cup = 240 ml, the US customary cup as used by every EN site in the corpus
 * (budgetbytes, recipetineats, food.com print US measures; recipetineats even
 * footnotes "measures in Australia are..."). NOT the metric 250 ml cup.
 *
 * glass = 250 ml: the Lithuanian "stiklinė" — LT cookbooks standardised on
 * the 250 ml faceted glass decades ago, and every LT recipe means exactly
 * that. It is deliberately NOT the 240 ml US cup: two different traditions,
 * two different numbers, two different units.
 *
 * pinch/drop/handful are vague but still VOLUMES — the pipeline needs a
 * nominal size to estimate mass through density; isVagueUnit makes the caller
 * flag the result approximate.
 */
export const VOLUME_ML: Readonly<Partial<Record<Unit, number>>> = {
    ml: 1,
    l: 1000,
    tsp: 5,
    tbsp: 15,
    cup: 240,
    floz: 29.5735,
    pint: 473.176,   // US liquid pint
    quart: 946.353,  // US liquid quart
    glass: 250,
    pinch: 0.4,      // between "1/16 tsp" and "1/8 tsp" folk definitions
    drop: 0.05,      // pharmacology's 20 drops/ml
    handful: 120,    // ~half a cup of loose leaves/berries
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Dimension = 'mass' | 'volume' | 'count';

/**
 * Total over the whole Unit union: membership in MASS_G / VOLUME_ML decides,
 * everything else counts pieces. bunch/sprig/can/… have no honest ml, so they
 * are 'count' by construction — a matcher resolves them via per-ingredient
 * piece weights, never through this file.
 */
export function unitDimension(u: Unit): Dimension {
    if (u in MASS_G) return 'mass';
    if (u in VOLUME_ML) return 'volume';
    return 'count';
}

/**
 * Units whose size is a guess rather than a measurement — the caller must
 * flag anything derived from these as approximate. 'glass' is here despite
 * having a firm 250 ml convention because the physical glass in the cook's
 * hand still varies; 'pcs' and 'clove' are NOT here — one egg or one garlic
 * clove is as exact as a recipe count gets.
 */
const VAGUE_UNITS: ReadonlySet<Unit> = new Set<Unit>([
    'pinch', 'handful', 'bunch', 'sprig', 'can', 'pack', 'slice',
    'head', 'stalk', 'cm', 'drop', 'sheet', 'glass',
]);

export function isVagueUnit(u: Unit): boolean {
    return VAGUE_UNITS.has(u);
}

// ---------------------------------------------------------------------------
// Deliberately NOT representable — Unit is a closed union, so these corpus /
// real-world forms are left unmapped rather than lied about:
//  - "desertinis šaukštas" (LT dessert spoon, 10 ml): sits exactly between
//    tsp (5) and tbsp (15); mapping to either is a 2x/1.5x lie. Omitted.
//  - "stick" (US butter stick, 113 g): mass unit with no Unit member; not in
//    the corpus, so omitted rather than shoehorned.
//  - "mm": appears only inside prep notes ("2mm slices"); no Unit member, and
//    aliasing it to 'cm' would be a 10x lie.
//  - "box" / "bottle": appear in the corpus only as prose ("box grater",
//    "top up with bottle"), never in the unit position — aliasing them would
//    only create false positives.
//  - 't' / 'T': see the single-letter policy at the top of UNIT_ALIASES.
// ---------------------------------------------------------------------------
