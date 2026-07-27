/**
 * RECIPE IMPORT — the contract every stage of the pipeline speaks.
 *
 *   url → scraper → ScrapedRecipe
 *       → parser  → ParsedIngredient[]      (numbers + unit + bare name)
 *       → units   → Measure                 (metric, via density when needed)
 *       → matcher → MatchedIngredient[]     (a catalog product, or nothing)
 *
 * Every stage is pure except the scraper (network) and the matcher (database),
 * so the whole chain is testable from stored HTML.
 */

export type Lang = 'lt' | 'en';

/** How the recipe was lifted out of the page — kept for diagnostics: when a site
 *  redesigns, the sweep shows the extractor silently degrading to a weaker one. */
export type Extractor = 'jsonld' | 'microdata' | 'wprm' | 'nextdata' | 'dom';

export interface ScrapedRecipe {
    sourceUrl: string;
    /** Hostname without `www.` — the key the per-site quirks hang off. */
    site: string;
    title: string;
    imageUrl: string | null;
    /** Portions the amounts are written for; null when the page doesn't say. */
    servings: number | null;
    /** Ingredient lines exactly as published (entities decoded, whitespace
     *  collapsed). The parser owns everything past this point. */
    ingredientLines: string[];
    lang: Lang;
    extractor: Extractor;
}

/**
 * A unit as WRITTEN, folded to one token per concept. Deliberately not metric
 * yet: "3 šaukštai" has to survive as a spoon until we know what it holds, since
 * a spoon of oil and a spoon of salt are different masses.
 */
export type Unit =
    // mass
    | 'g' | 'kg' | 'oz' | 'lb'
    // volume
    | 'ml' | 'l' | 'tsp' | 'tbsp' | 'cup' | 'floz' | 'pint' | 'quart' | 'glass'
    // countable / vague
    | 'pcs' | 'clove' | 'slice' | 'head' | 'bunch' | 'handful' | 'pinch'
    | 'can' | 'pack' | 'sprig' | 'stalk' | 'sheet' | 'drop' | 'cm';

/** What we can actually put on a shopping list. */
export type CanonicalUnit = 'g' | 'ml' | 'pcs';

export interface ParsedIngredient {
    /** The published line, untouched — every screen falls back to it and every
     *  diagnostic needs it. */
    raw: string;
    /** Ingredient name with amounts, units, prep notes and asterisks stripped. */
    name: string;
    /**
     * The name BEFORE leading prep participles were moved into the note.
     *
     * Both are needed. "finely chopped shallots" should read as "shallots" on
     * screen, but "crushed tomatoes" is a different product from tomatoes, and
     * the knowledge base can only tell the difference if it still sees the word.
     * So: `name` is what the shopper reads, `nameFull` is what we look up.
     */
    nameFull: string;
    /** Amount as written. null when the recipe gives none ("Druskos", "Black
     *  pepper") — that is information, not a zero. */
    quantity: number | null;
    /** Upper bound of a range ("1-2 tbsp", "1 1/2 - 2 cups"); null otherwise. */
    quantityMax: number | null;
    unit: Unit | null;
    /** Prep/variant note: the parenthetical, or the tail after the comma. */
    note: string | null;
    /** "nebūtina" / "optional" / "if you like". */
    optional: boolean;
    /** "pagal skonį" / "to taste" / "pagal poreikį" / "šiek tiek" — no amount
     *  exists to convert, and the shopper needs a package, not a mass. */
    toTaste: boolean;
    /** Not an ingredient at all: a section heading ("Padažui:") or prose the
     *  site put in the ingredient array. Kept so the sweep can count them. */
    ignored: boolean;
}

/** A metric amount, or an honest absence of one. */
export interface Measure {
    qty: number | null;
    unit: CanonicalUnit | null;
    /** True when the number came from a density or a piece weight rather than
     *  from the recipe — the UI must not present it as exact. */
    approx: boolean;
}

/**
 * One row of the ingredient knowledge base. This is the file that makes
 * "3 šaukštai karį" become "≈21 g of curry powder": a spoon is 15 ml, curry
 * powder is ~0.47 g/ml.
 */
export interface IngredientInfo {
    /** Stable machine key, snake_case English ('flour_wheat', 'curry_powder'). */
    key: string;
    /** The Lithuanian shopping name — what we hand the catalog matcher. */
    ltName: string;
    /** The English name, for EN recipes and for reviewing this table. */
    enName: string;
    /** Surface forms to recognise, lowercase and diacritic-bearing. LT entries
     *  should list the stem-ish forms recipes actually print (nominative AND
     *  genitive, singular AND plural), because a recipe writes "kvietinių miltų"
     *  and a catalog writes "Kvietiniai miltai". */
    lt: string[];
    en: string[];
    /**
     * EXTRA CATALOG-FACING NAMES to search when `ltName` cannot reach the
     * product — the recipe-side twin of the StoreProductTranslation synonyms the
     * product search already uses.
     *
     * The case that needed it: the shelf spells fresh turkey "Švieži KALAKUTŲ
     * krūtinėlių pjausniai" while a recipe says "kalakutiena", and no amount of
     * stemming bridges two different word FORMATIONS. Searching "Kalakutiena"
     * returned 50 rows without a single piece of fresh turkey in them — tinned
     * turkey, pilaf, ravioli, then a long tail of dog food.
     *
     * Tried in order AFTER `ltName`, and only while nothing confident has been
     * found, so the common case still costs exactly one query.
     */
    aliases?: string[];
    /** Grams per millilitre — required for anything a recipe measures by spoon
     *  or cup but a shop sells by weight. */
    gramsPerMl?: number;
    /** Grams of one typical piece: one onion, one egg, one clove of garlic. */
    gramsPerPiece?: number;
    /** Likely already in the cupboard (salt, pepper, sugar, oil, flour…). These
     *  get grouped so the shopper can strike them in one glance. */
    pantry: boolean;
    /** Sold loose by weight (produce, meat, cheese counter) rather than in a
     *  fixed package. Drives whether we shop in kg or in pieces. */
    weighable?: boolean;
    /**
     * Not a purchase. Tap water is the case that forced this: it is a real
     * ingredient, it belongs in the table for its density, and searching the
     * catalog for it returned "Vandens indelis" — a water BOWL — with 0.97
     * confidence. Ingredients flagged here are recognised, measured, and never
     * matched to a product.
     */
    notSold?: boolean;
}
