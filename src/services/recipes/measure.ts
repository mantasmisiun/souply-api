import type { Lang, IngredientInfo, Measure, ParsedIngredient, Unit } from './types.js';
import { INGREDIENTS } from './ingredientData.js';
import { MASS_G, VOLUME_ML, isVagueUnit, unitDimension } from './units.js';

/**
 * MEASURE — turn a parsed ingredient into something a shop can sell you.
 *
 * A recipe measures by convenience, a shop sells by mass or by the piece, and
 * the bridge between them is physical: 3 tablespoons of curry powder is 45 ml
 * of curry powder is ~21 g of curry powder. Without density we would either
 * refuse the line or invent a number; with it we can say "≈21 g" and mark the
 * value approximate so nothing downstream presents it as exact.
 *
 * The other half of this file is ingredient RECOGNITION: finding which row of
 * the knowledge base a recipe phrase refers to. Lithuanian makes this the hard
 * part — a recipe writes "kvietinių miltų" where a shop writes "Kvietiniai
 * miltai" — so we match on folded, lightly stemmed word windows, longest first.
 */

/* ─────────────────────────── ingredient lookup ─────────────────────────── */

export const fold = (s: string): string => s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ė/g, 'e').replace(/į/g, 'i').replace(/ų/g, 'u').replace(/ū/g, 'u')
    .replace(/ą/g, 'a').replace(/č/g, 'c').replace(/ę/g, 'e').replace(/š/g, 's').replace(/ž/g, 'z')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A deliberately blunt Lithuanian stemmer: chop the case ending so "miltų",
 * "miltai" and "miltus" collide. Only applied to tokens long enough that the
 * chop cannot swallow the root — the same 4-character floor the catalog
 * matcher's `ltStem` uses, and for the same reason.
 */
const LT_ENDINGS_RAW = [
    // Definite-adjective endings first — they are the longest, and they are what
    // makes "rudojo cukraus" and "Rudasis cukrus" the same brown sugar.
    'iaisiais', 'osiomis', 'iesiems', 'osioms', 'aisiais', 'osios', 'iosios', 'ųjų',
    'ajam', 'ojo', 'oji', 'uoju', 'ąją', 'asis', 'ieji', 'ojoje',
    'iomis', 'iams', 'iais', 'omis', 'ėmis', 'iuose', 'uose', 'ose', 'yje',
    'ams', 'ais', 'ius', 'ies', 'ėje', 'oje', 'ėms', 'iai', 'iui', 'iu',
    'ai', 'ui', 'us', 'os', 'as', 'is', 'ys', 'ės', 'ių',
    'ų', 'ę', 'į', 'ą', 'ė', 'a', 'e', 'i', 'o', 'u', 'y',
];

/**
 * TRAP, and an expensive one: the words are FOLDED before they are stemmed, so an
 * ending list written with diacritics ('ės', 'ių', 'ų') matched almost nothing —
 * "petražolės" folded to "petrazoles" and stemmed to "petrazoles", while
 * "petražolių" became "petrazoli". Two spellings of one word, and the comparison
 * that decides whether we quietly dropped a qualifier saw them as different
 * words. It flagged perfectly correct matches for review by the hundred.
 *
 * So the list is folded here, at load, exactly the way the input is.
 */
const LT_ENDINGS = [...new Set(LT_ENDINGS_RAW.map(e => fold(e)))]
    .sort((a, b) => b.length - a.length);

/**
 * A three-character floor, the same MIN_STEM the project's search stemmer uses.
 * Four was too strict for the short words Lithuanian is full of: "acto" and
 * "actas" (vinegar) both kept their endings and read as different words.
 */
const MIN_STEM = 3;

const stemWord = (w: string): string => {
    if (w.length <= MIN_STEM) return w;
    for (const end of LT_ENDINGS) {
        if (w.length - end.length >= MIN_STEM && w.endsWith(end)) return w.slice(0, -end.length);
    }
    return w;
};

const stemPhrase = (s: string): string => s.split(' ').map(stemWord).join(' ');

/** Longest surface form, in words — bounds the window scan. */
let MAX_FORM_WORDS = 1;

/** form → entry, in two flavours: folded-exact and folded-stemmed. */
const EXACT = new Map<string, IngredientInfo>();
const STEMMED = new Map<string, IngredientInfo>();

for (const info of INGREDIENTS) {
    for (const form of [...info.lt, ...info.en]) {
        const f = fold(form);
        if (!f) continue;
        MAX_FORM_WORDS = Math.max(MAX_FORM_WORDS, f.split(' ').length);
        if (!EXACT.has(f)) EXACT.set(f, info);
        const st = stemPhrase(f);
        // First writer wins: the table is ordered, and a stemmed collision
        // between two entries must not let a later, less specific row steal a
        // form the earlier one owns outright.
        if (!STEMMED.has(st)) STEMMED.set(st, info);
    }
}

/**
 * The meaning-bearing words of a phrase, folded and stemmed, so "šaldytų" and
 * "Šaldytas" are the same word. Short words are dropped: they are grammar, not
 * content, and the catalog matcher uses the same 4-character floor.
 */
export const contentWords = (s: string): string[] =>
    fold(s).split(' ').filter(w => w.length >= 4).map(stemWord);

export interface IngredientHit {
    info: IngredientInfo;
    /**
     * The words of the PHRASE the entry actually accounted for, folded — the
     * matched window itself. This is what lets the matcher see that "red pepper"
     * was recognised through the window "pepper" alone: the entry never vouched
     * for "red", and pretending otherwise turned red pepper into black pepper
     * in a shopping basket. `words` alone could not tell WHICH words matched.
     */
    form: string;
    /** How many words of the phrase the entry accounted for — a 2-word hit on
     *  "alyvuogių aliejus" beats a 1-word hit on "aliejus". */
    words: number;
    exact: boolean;
}

/**
 * Which known ingredient is this phrase about?
 *
 * Scans every word window longest-first and takes the longest hit, preferring
 * an exact form over a stemmed one at equal length. Longest-wins is what keeps
 * "alyvuogių aliejus" (olive oil) from collapsing into "aliejus" (any oil) and
 * "pieno šokoladas" (milk chocolate) from being read as milk.
 */
/**
 * @param lang decides which single word of a COMPOUND is the ingredient. English
 *   noun compounds are head-FINAL — "cranberry beans" are beans, "plum tomatoes"
 *   are tomatoes — so the last match wins. Lithuanian is the other way round
 *   ("imbiero šaknies" is ginger, not root), and taking the last word there
 *   would undo a whole class of fixes, so LT keeps the first match.
 */
export const findIngredient = (name: string, lang: Lang = 'lt'): IngredientHit | null => {
    const hits = findIngredientHits(name);
    return hits.length > 0 ? pickHead(hits, hits[0].words, lang) : null;
};

/**
 * EVERY hit at the winning window length, not just the head pick.
 *
 * The matcher's homonym rule needs the full slate: a product name can carry
 * several readings at once, and which of them is "the" ingredient depends on
 * who is asking. "Rūkyta kiaulienos šoninė" reads as pork belly ("kiaulienos
 * šoninė") AND as the bacon the query meant — judging only the head pick
 * would call the correct bacon a stranger. One reading that vouches for the
 * query is enough; only a name NONE of whose readings do (every window of
 * "Malti muskato riešutai" says nutmeg, never a nut) is a genuine homonym.
 */
export const findIngredientHits = (name: string): IngredientHit[] => {
    const folded = fold(name);
    if (!folded) return [];
    const words = folded.split(' ');

    for (let n = Math.min(MAX_FORM_WORDS, words.length); n >= 1; n--) {
        const hits: IngredientHit[] = [];
        for (let i = 0; i + n <= words.length; i++) {
            const window = words.slice(i, i + n).join(' ');
            const exact = EXACT.get(window);
            if (exact) hits.push({ info: exact, form: window, words: n, exact: true });
        }
        if (hits.length > 0) return hits;
        for (let i = 0; i + n <= words.length; i++) {
            // `form` stays the SURFACE window, not the stemmed key: the caller
            // compares it against the phrase's own words to find what was left
            // uncovered, and a stemmed form would never line up with them.
            const window = words.slice(i, i + n).join(' ');
            const hit = STEMMED.get(stemPhrase(window));
            if (hit) hits.push({ info: hit, form: window, words: n, exact: false });
        }
        if (hits.length > 0) return hits;
    }
    return [];
};

/**
 * LEFTMOST WINS — and a blanket "English compounds are head-final" rule does NOT
 * work here, though it is tempting and half-true.
 *
 * The holdout found three silent errors from keeping the modifier and dropping
 * the head: "cranberry beans" bought cranberries, "plum tomatoes" bought prunes,
 * "tomato sauce" bought fresh tomatoes. Preferring the LAST single-word match
 * fixed all three — and broke more than it fixed, because English piles
 * compounds onto generic heads whose modifier carries the meaning. "Bell
 * pepper", "Scotch bonnet pepper" and "black pepper" all end in "pepper"; take
 * the head and every chilli in the corpus becomes a jar of black peppercorns,
 * which is a silent error the judges had already flagged separately.
 *
 * So the head only wins where the DATA says it does — a multi-word entry for
 * the compound, exactly as with "olive oil" and "bell pepper". That is more
 * lexicon rows, but each one is verifiable and none of them can surprise a
 * neighbouring ingredient.
 */
const pickHead = (hits: IngredientHit[], _n: number, _lang: Lang): IngredientHit => hits[0];

/* ──────────────────────────── conversion ───────────────────────────────── */

const NONE: Measure = { qty: null, unit: null, approx: false };

/**
 * Convert one parsed ingredient to grams, millilitres or pieces.
 *
 * The rules, in the order they fire:
 *   mass unit          → grams, exact
 *   volume + density   → grams, approximate (a spoon is not a laboratory)
 *   volume, no density → millilitres, exact-ish (we measured what was written)
 *   count + piece mass → grams when the shop weighs it, pieces when it doesn't
 *   count, no data     → pieces
 *   no amount at all   → nothing, and that is an honest answer
 *
 * A range ("1-2 tbsp") converts its LOWER bound: over-buying a spice is waste,
 * under-buying is a second trip, and the shopper can see the range in the raw
 * line. Choosing the low end also keeps totals from creeping upward across a
 * whole recipe.
 */
export const toMetric = (ing: ParsedIngredient, info: IngredientInfo | null): Measure => {
    if (ing.quantity == null || ing.unit == null) {
        // No unit but a bare count is still a count: "2 kiaušiniai", "3 bananas".
        if (ing.quantity != null && ing.unit == null) return pieces(ing.quantity, info);
        return NONE;
    }

    const qty = ing.quantity;
    const unit = ing.unit;
    const dim = unitDimension(unit);
    const vague = isVagueUnit(unit);

    if (dim === 'mass') {
        const g = MASS_G[unit];
        return g == null ? NONE : { qty: round2(qty * g), unit: 'g', approx: false };
    }

    if (dim === 'volume') {
        const ml = VOLUME_ML[unit];
        if (ml == null) return NONE;
        const totalMl = qty * ml;
        const density = info?.gramsPerMl;
        if (density != null) {
            return { qty: round2(totalMl * density), unit: 'g', approx: true };
        }
        // No density: report the volume. A litre of milk is a real purchase; a
        // spoon of an unknown powder is at least an honest 15 ml.
        return { qty: round2(totalMl), unit: 'ml', approx: vague };
    }

    // Countable units. A clove and a piece are not the same size, so a unit
    // that names a sub-part gets its own weight where the table knows one.
    return countToMeasure(qty, unit, info, vague);
};

const countToMeasure = (qty: number, unit: Unit, info: IngredientInfo | null, vague: boolean): Measure => {
    const perPiece = info?.gramsPerPiece;
    if (perPiece != null) {
        return { qty: round2(qty * perPiece), unit: 'g', approx: true };
    }
    return { qty: round2(qty), unit: 'pcs', approx: vague };
};

const pieces = (qty: number, info: IngredientInfo | null): Measure => {
    const perPiece = info?.gramsPerPiece;
    // Only convert to grams for things a shop actually weighs — turning "2 eggs"
    // into "110 g" would be true and useless, because eggs are sold by the box.
    if (perPiece != null && info?.weighable) {
        return { qty: round2(qty * perPiece), unit: 'g', approx: true };
    }
    return { qty: round2(qty), unit: 'pcs', approx: false };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * How the amount should read to a human: "≈21 g", "150 ml", "2 vnt.".
 * Grams roll up to kilograms and millilitres to litres at the point a shopper
 * would say it that way.
 */
export const formatMeasure = (m: Measure, lang: 'lt' | 'en' = 'lt'): string | null => {
    if (m.qty == null || m.unit == null) return null;
    const prefix = m.approx ? '≈' : '';
    if (m.unit === 'pcs') {
        const label = lang === 'lt' ? 'vnt.' : 'pcs';
        return `${prefix}${trim(m.qty)} ${label}`;
    }
    if (m.unit === 'g' && m.qty >= 1000) return `${prefix}${trim(m.qty / 1000)} kg`;
    if (m.unit === 'ml' && m.qty >= 1000) return `${prefix}${trim(m.qty / 1000)} l`;
    return `${prefix}${trim(m.qty)} ${m.unit}`;
};

/** Numbers a shopper reads, not numbers a float produces: 0.5 → "0,5". */
const trim = (n: number): string => {
    const r = Math.round(n * 100) / 100;
    const s = Number.isInteger(r) ? String(r) : String(r).replace('.', ',');
    return s;
};
