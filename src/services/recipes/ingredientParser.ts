import type { Lang, ParsedIngredient, Unit } from './types.js';
import { findIngredient } from './measure.js';
import { MAX_UNIT_WORDS, UNIT_ALIASES, isVagueUnit, lookupUnit, unitDimension } from './units.js';

/**
 * INGREDIENT PARSER — "440 gramųkonservuotų pupelių(tamsios ar šviesios)" into
 * { quantity: 440, unit: 'g', name: 'konservuotos pupelės', note: '…' }.
 *
 * Written against 736 real ingredient lines from lamaistas.lt, receptai.lt,
 * beatosvirtuve.lt, budgetbytes.com, recipetineats.com, food.com and
 * bbcgoodfood.com. Every rule below exists because a real line demanded it:
 *
 *   receptai.lt   "440 gramųkonservuotų pupelių(...)"  ← no space after the unit
 *   beatosvirtuve "Pusės šaukštelio malto cinamono"    ← the amount is a WORD
 *   beatosvirtuve "Druskos, pipirų, lauro lapų"        ← three ingredients, one line
 *   budgetbytes   "2 cloves garlic* ($0.08)"           ← a price the shopper must not see
 *   recipetineats "500 g / 1 lb  chicken mince (...)"  ← metric and imperial together
 *   recipetineats "1 1/2 - 2 cups shredded mozzarella" ← mixed fraction, range
 *   food.com      "1 -2   tablespoon    olive oil"     ← range with stray spacing
 *   budgetbytes   "1 28 oz. can crushed tomatoes**"    ← count × package size
 *
 * A line can hold MORE than one ingredient, so the entry point returns an
 * array. Everything here is pure.
 */

/* ───────────────────────────── numbers ─────────────────────────────────── */

/** Vulgar fractions print as single glyphs in half the corpus. */
const VULGAR: Record<string, number> = {
    '¼': 0.25, '½': 0.5, '¾': 0.75, '⅐': 1 / 7, '⅑': 1 / 9, '⅒': 0.1,
    '⅓': 1 / 3, '⅔': 2 / 3, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
    '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};
const VULGAR_CLASS = Object.keys(VULGAR).join('');

/**
 * Lithuanian recipes — especially hand-written blogs — spell small amounts.
 * "Pusės šaukštelio malto cinamono" is half a teaspoon of cinnamon, and
 * dropping the "pusės" would double the spice.
 */
const LT_NUMBER_WORDS: Record<string, number> = {
    pusė: 0.5, pusės: 0.5, puse: 0.5, puses: 0.5, pusę: 0.5, pusu: 0.5,
    ketvirtis: 0.25, ketvirčio: 0.25, ketvircio: 0.25,
    ketvirtadalis: 0.25, ketvirtadalio: 0.25,
    trečdalis: 1 / 3, trečdalio: 1 / 3, trecdalio: 1 / 3,
    trečdalį: 1 / 3, trecdali: 1 / 3,
    pusantro: 1.5, pusantros: 1.5,
    vienas: 1, viena: 1, vieno: 1, vienos: 1,
    du: 2, dvi: 2, dviejų: 2, dvieju: 2,
    trys: 3, trijų: 3, triju: 3,
    keturi: 4, keturios: 4, keturių: 4, keturiu: 4,
    penki: 5, penkios: 5, penkių: 5, penkiu: 5,
    šeši: 6, šešios: 6, sesi: 6, šešių: 6,
    septyni: 7, aštuoni: 8, devyni: 9, dešimt: 10, desimt: 10,
};

const EN_NUMBER_WORDS: Record<string, number> = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, dozen: 12,
    half: 0.5, quarter: 0.25,
};

/** "1", "0.5", "0,5", "1/2", "1 1/2", "1½", "½" → a number. */
const numberFrom = (raw: string): number | null => {
    const s = raw.trim();
    if (!s) return null;
    let total = 0;
    let sawAny = false;
    // Leading whole part, then a fraction (either "1/2" or a vulgar glyph).
    const m = s.match(new RegExp(`^(\\d+(?:[.,]\\d+)?)?\\s*(?:(\\d+)\\s*/\\s*(\\d+)|([${VULGAR_CLASS}]))?$`));
    if (!m) return null;
    if (m[1] != null) { total += parseFloat(m[1].replace(',', '.')); sawAny = true; }
    if (m[2] != null && m[3] != null) {
        const den = Number(m[3]);
        if (den === 0) return null;
        total += Number(m[2]) / den;
        sawAny = true;
    }
    if (m[4] != null) { total += VULGAR[m[4]]; sawAny = true; }
    if (!sawAny || !Number.isFinite(total)) return null;
    return round3(total);
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** A number token as it may appear at the head of a line, including ranges. */
/**
 * ORDER IS LOAD-BEARING. Regex alternation is first-match-wins, so the mixed
 * number must be tried before the bare fraction and the bare fraction before a
 * plain integer — otherwise "3/4 tsp salt" matches the "3" and leaves "/4"
 * behind, which is how you buy four times the salt.
 */
const NUM_GROUP = [
    `\\d+\\s+\\d+\\s*/\\s*\\d+`,           // 1 1/2
    `\\d+\\s*/\\s*\\d+`,                   // 3/4
    `\\d+(?:[.,]\\d+)?\\s*[${VULGAR_CLASS}]`,  // 1½
    `\\d+(?:[.,]\\d+)?`,                     // 500, 0,5
    `[${VULGAR_CLASS}]`,                       // ½
].join('|');
const QTY_RE = new RegExp(`^\\s*(${NUM_GROUP})\\s*(?:[-–—]|\\bto\\b|\\biki\\b)\\s*(${NUM_GROUP})|^\\s*(${NUM_GROUP})`, 'i');

interface QtyHead { quantity: number | null; quantityMax: number | null; rest: string }

const takeQuantity = (text: string, lang: Lang): QtyHead => {
    const m = text.match(QTY_RE);
    if (m) {
        const rest = text.slice(m[0].length);
        if (m[1] != null && m[2] != null) {
            const lo = numberFrom(m[1]);
            const hi = numberFrom(m[2]);
            // A range is only a range when it ascends; "1-2" yes, "2-1" is a typo
            // we refuse to interpret.
            if (lo != null && hi != null && hi > lo) return { quantity: lo, quantityMax: hi, rest };
            if (lo != null) return { quantity: lo, quantityMax: null, rest };
        }
        const only = numberFrom(m[3] ?? '');
        if (only != null) return { quantity: only, quantityMax: null, rest };
    }
    // No digits: a spelled amount ("Pusės šaukštelio", "half a cup").
    const words = text.trim().split(/\s+/);
    const table = lang === 'lt' ? LT_NUMBER_WORDS : EN_NUMBER_WORDS;
    const first = stripPunct(words[0] ?? '').toLowerCase();
    if (first in table) {
        // "a"/"an" is only a quantity in English and only before a unit-ish word;
        // "a pinch of salt" yes, "avocado" no — the table lookup already guards
        // the second case because we matched the WHOLE token.
        return { quantity: table[first], quantityMax: null, rest: words.slice(1).join(' ') };
    }
    return { quantity: null, quantityMax: null, rest: text };
};

const stripPunct = (s: string): string => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/* ───────────────────────────── units ───────────────────────────────────── */

/** Fold Lithuanian diacritics — the unit tables index both forms, but glued
 *  splitting compares prefixes and must agree on one alphabet. */
const fold = (s: string): string => s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ė/g, 'e').replace(/į/g, 'i').replace(/ų/g, 'u').replace(/ū/g, 'u')
    .replace(/ą/g, 'a').replace(/č/g, 'c').replace(/ę/g, 'e').replace(/š/g, 's').replace(/ž/g, 'z');

interface UnitHead { unit: Unit | null; rest: string }

/**
 * Take the unit off the head of `text`.
 *
 * Two shapes to handle. The ordinary one is space-separated, longest phrase
 * first ("valgomieji šaukštai" before "šaukštai"). The other is receptai.lt,
 * whose template emits the unit and the ingredient with no space between them
 * — "gramųkonservuotų", "vienetaikiaušiniai", "šaukšteliodruska". For those we
 * try every unit alias as a PREFIX of the first token; the tail must be a
 * plausible word start, otherwise "litras" would eat the "l" of "lašišos".
 */
const takeUnit = (text: string, lang: Lang): UnitHead => {
    const trimmed = text.replace(/^[\s,.;:]+/, '');
    if (!trimmed) return { unit: null, rest: '' };
    const words = trimmed.split(/\s+/);

    for (let n = Math.min(MAX_UNIT_WORDS, words.length); n >= 1; n--) {
        const phrase = words.slice(0, n).join(' ');
        const unit = lookupUnit(stripTrailingDot(phrase));
        if (unit) return { unit, rest: words.slice(n).join(' ') };

        // The glued template bug is a Lithuanian-site phenomenon. The candidate
        // list holds every ≥3-char alias — including the ENGLISH "can", "jar",
        // "rib" — and on an English line the token after the amount is just an
        // ordinary word, so the split fired on it: "Canola oil" became a can of
        // "ola oil", "Ribeye" a stalk of "eye". No glue outside Lithuanian.
        if (lang === 'en') continue;

        // The glue lands on the LAST word of the window, because that is where
        // the unit phrase ends: "valgomieji šaukštaimajonezas" is a two-word
        // unit whose second word has the ingredient stuck to it. Rebuild the
        // phrase with each candidate split and ask the table again.
        //
        // EVERY candidate is tried, not just the longest. "valgomieji
        // šaukštaisviestas" splits most greedily at the instrumental "šaukštais"
        // — which leaves "viestas" and rebuilds to a phrase that is not a unit.
        // The correct split is one character shorter, and only the table can say
        // so, so the table decides.
        const viable = gluedSplits(words[n - 1])
            .map(g => ({ ...g, unit: lookupUnit([...words.slice(0, n - 1), g.alias].join(' ')) }))
            .filter((g): g is GluedSplit & { unit: Unit } => g.unit != null);
        if (viable.length > 0) {
            // "225 gramaisviestas" splits validly at BOTH the instrumental
            // "gramais" (leaving "viestas") and the nominative "gramai" (leaving
            // "sviestas") — the unit table cannot choose, because both are real
            // units. The ingredient table can: only one remainder is a word for
            // food. Longest alias only breaks the tie when nothing is recognised.
            const known = viable.find(g => findIngredient(g.rest) != null);
            const chosen = known ?? viable[0];
            return { unit: chosen.unit, rest: [chosen.rest, ...words.slice(n)].join(' ') };
        }
    }

    return { unit: null, rest: trimmed };
};

const stripTrailingDot = (s: string): string => s.replace(/\.$/, '');

/**
 * Single-word unit aliases, longest first. A glued token cannot contain a space,
 * and an alias shorter than 3 characters is barred outright — splitting on "g"
 * or "l" inside a word is how "lašišos" becomes a litre of "ašišos".
 */
let GLUE_CANDIDATES: string[] | null = null;
const glueCandidates = (): string[] => {
    if (GLUE_CANDIDATES) return GLUE_CANDIDATES;
    const seen = new Set<string>();
    for (const alias of Object.keys(UNIT_ALIASES)) {
        if (alias.includes(' ') || alias.length < 3) continue;
        seen.add(alias);
    }
    GLUE_CANDIDATES = [...seen].sort((a, b) => b.length - a.length);
    return GLUE_CANDIDATES;
};

/**
 * Split "gramųsviestas" into the alias "gramų" and the rest "sviestas".
 *
 * TRAP, paid for once: matching on FOLDED text made "gramų" + "sviestas" fold to
 * "gramusviestas", which the accusative alias "gramus" also matches — and the
 * split then ate the ingredient's first letter, leaving "viestas". So the
 * literal spelling is tried first for every alias, and folding is only a
 * fallback for genuinely diacritic-free input.
 */
interface GluedSplit { alias: string; rest: string }

const gluedSplits = (token: string): GluedSplit[] => {
    if (!token) return [];
    const out: GluedSplit[] = [];
    const seen = new Set<string>();
    // Literal spelling first, folded second: folding makes "gramų"+"sviestas"
    // look like the accusative "gramus", and that split ate the ingredient's
    // first letter, leaving "viestas".
    for (const useFold of [false, true]) {
        const haystack = useFold ? fold(token) : token.toLowerCase();
        for (const alias of glueCandidates()) {
            const probe = useFold ? fold(alias) : alias;
            if (!haystack.startsWith(probe)) continue;
            const rest = token.slice(probe.length);
            // The tail must look like the start of a word, not a stray letter or
            // a digit — "500g" is handled by the ordinary path, not here.
            //
            // A site can also glue the unit straight onto an opening QUOTE:
            // "250 gramų„dansukker“ cukrus uogienėms". Demanding a letter there
            // rejected the correct "gramų" split, so the shorter alias "gram"
            // won instead and left the ingredient named "ų„dansukker“ cukrus".
            // A quote or bracket is allowed, provided a letter follows it.
            if (rest.length < 3 || !/^["„“«(\[]?\p{L}/u.test(rest)) continue;
            if (!lookupUnit(alias)) continue;
            const key = `${alias}|${rest}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ alias, rest });
        }
    }
    return out;
};

/* ─────────────────────────── line cleaning ─────────────────────────────── */

/** Budget Bytes prints its costing in the ingredient line: "(...) ($0.70)". */
const PRICE_RE = /\(\s*\$\s*\d[\d.,]*\s*\)/g;
/** Footnote markers a shopper should never read: "garlic*", "salt**". */
const FOOTNOTE_RE = /\*+/g;
/** "(Note 3)", "(pastaba 2)" — cross-references to the article body. */
const CROSSREF_RE = /\(\s*(?:note|pastaba|žr\.?|zr\.?)\s*\d*\s*\)/gi;

/**
 * `\b` is ASCII-only in JavaScript, so `\bšiek tiek` and `pagal skonį\b` can
 * NEVER match: 'š' and 'į' are not word characters, so the boundary the engine
 * looks for is not there. Every Lithuanian "to taste" silently failed until the
 * corpus sweep showed the flag stuck at false. Unicode lookarounds instead.
 */
const edged = (body: string): RegExp =>
    new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'iu');

const OPTIONAL_RE = edged('optional|to serve|if desired|if you like|nebūtina|nebutina|nebūtinai|nebutinai'
    + '|pagal norą|pagal nora|jei norite|galima nedėti|galima nedeti');
const TO_TASTE_RE = edged('to taste|as needed|as required|pagal skonį|pagal skoni'
    + '|pagal poreikį|pagal poreiki|šiek tiek|siek tiek|kiek tilps|kiek reikia|pagal poreikius'
    // "truputis" ("a bit") — skanauk.lt prints it as the whole amount:
    // "svogūnų milteliai: trupučio". Same meaning as "šiek tiek".
    + '|truputis|truputi|truputį|trupučio|trupucio');

/** A heading inside the ingredient list: "Padažui:", "For the sauce:".
 *  A trailing dash counts too — "Sauce options -" is a heading, and parsed as
 *  an ingredient it reached the shopping list verbatim. */
const isSectionHeading = (s: string): boolean =>
    /[:\-–—]\s*$/.test(s) && !/\d/.test(s) && s.length <= 60;

/**
 * Prose the site parked in the ingredient array. beatosvirtuve.lt does this
 * ("Sultiniui virti galite naudoti mėgiamas daržoves" — "for the stock you can
 * use whatever vegetables you like"). It is advice, not something to buy.
 */
const isProse = (s: string): boolean => {
    const words = s.split(/\s+/).length;
    if (words < 6) return false;
    if (/^\d/.test(s.trim())) return false;          // it starts with an amount → it's real
    return /\b(galite|galima|naudoti|patiekite|jei|kad|tinka|arba pagal|you can|serve with|if you)\b/i.test(s);
};

/**
 * "500 g / 1 lb chicken mince" — RecipeTin Eats writes both systems. Keep the
 * metric half: this app shops in a Lithuanian supermarket, and converting the
 * imperial half back would only add rounding error.
 *
 * The imperial half is anything but a plain decimal — bbc.co.uk prints vulgar
 * glyphs ("40g/1½oz"), mixed numbers ("5 ½ oz"), "fl oz", and compound runs
 * ("1kg/2lb 4oz"). When the half fails to match, the substitution silently
 * skips and the metric UNIT is left at the head of the name — so both halves
 * are built from NUM_GROUP, `fl oz` is tried before `oz`, and a whole RUN of
 * imperial terms is consumed. `(?![a-z])` (not `\b`) is what stops the metric
 * `l` matching the `l` of `lb`.
 */
// bbcgoodfood spells the metric unit out ("1 litre / 4 cups beef stock") and
// the imperial one too ("1 litre/1¾ pints") — abbreviations alone left the
// spelled-out half sitting at the head of the ingredient name.
const METRIC_HALF = `(?:${NUM_GROUP})\\s*(?:g|kg|ml|l|grams?|kilograms?|millilitres?|milliliters?|litres?|liters?)(?![a-z])`;
const IMPERIAL_ONE = `(?:${NUM_GROUP})\\s*(?:fl\\.?\\s*oz|oz|lbs?|pounds?|ounces?|pints?|quarts?|cups?)(?![a-z])`;
const IMPERIAL_RUN = `${IMPERIAL_ONE}(?:\\s+${IMPERIAL_ONE})*`;
const METRIC_FIRST_RE = new RegExp(`^\\s*(${METRIC_HALF})\\s*\\/\\s*${IMPERIAL_RUN}\\s*`, 'i');
const IMPERIAL_FIRST_RE = new RegExp(`^\\s*${IMPERIAL_RUN}\\s*\\/\\s*(${METRIC_HALF})\\s*`, 'i');
// "2 cups / 500 ml red wine" — both halves are usable, but 500 ml is what the
// bottle says, so the metric half still wins.
const CUPS_FIRST_RE = new RegExp(
    `^\\s*(?:${NUM_GROUP})\\s*(?:cups?|tablespoons?|tbsp|teaspoons?|tsp)\\s*\\/\\s*(${METRIC_HALF})\\s*`, 'i');

const preferMetricHalf = (s: string): string => {
    for (const re of [METRIC_FIRST_RE, IMPERIAL_FIRST_RE, CUPS_FIRST_RE]) {
        const m = s.match(re);
        if (m) return `${m[1]} ${s.slice(m[0].length)}`;
    }
    return s;
};

/**
 * Section headings that introduce an ingredient rather than being one:
 * "egg wash: 1 egg white…", "Optional garnish: toasted sesame seeds",
 * "Patiekimui: grietinė". When the head of a colon is one of these, the
 * INGREDIENT is on the other side.
 */
const COLON_HEADING = new RegExp(
    '^(?:optional\\s+)?(?:garnish|topping|to serve|for serving|serving|glaze|egg wash|wash|filling'
    + '|frosting|icing|sauce|dressing|marinade|for the [a-z ]+'
    + '|patiekimui|papuošimui|padažui|įdarui|tešlai|apvolioti|užpilui|garnyrui)\\s*$', 'i');

/**
 * A colon whose tail is NOT an amount still has to be resolved — otherwise the
 * whole "X: Y" string became the ingredient name and matched nothing.
 *
 * Which side is the ingredient depends on the head. "Aliejus: kepimui" is oil
 * FOR frying — the head is the ingredient and the tail is its purpose. "Optional
 * garnish: toasted sesame seeds" is the reverse: the head is a section heading
 * and everything real is behind it.
 */
const splitNonAmountColon = (text: string, notes: string[]): string => {
    const masked = text.replace(/\([^()]*\)/g, m => ' '.repeat(m.length));
    const i = masked.indexOf(':');
    if (i <= 0 || i >= text.length - 1) return text;
    const head = text.slice(0, i).trim();
    const tail = text.slice(i + 1).trim();
    if (!head || !tail) return text;

    if (COLON_HEADING.test(head)) {
        notes.push(head);
        return tail;
    }
    // A head that is itself a plausible ingredient keeps the line; the tail is
    // the purpose or the serving note. Guarded on length so a whole sentence
    // before a colon is not mistaken for an ingredient.
    if (head.split(/\s+/).length <= 4) {
        notes.push(tail);
        return head;
    }
    return text;
};

/** receptai.lt glues the parenthetical onto the name: "pupelių(tamsios…)". */
const unglueParens = (s: string): string => s.replace(/(\S)\(/g, '$1 (').replace(/\)(\p{L})/gu, ') $1');

/**
 * The same template bug hits the AMOUNT phrase, not just the unit:
 * "šiek tiekaliejaus", "pagal skonįdruskos". Left glued, the phrase stops being
 * recognisable as "to taste" and the ingredient stops being recognisable as oil.
 */
const LT_GLUED_PHRASE = /(šiek tiek|pagal skonį|pagal skoni|pagal poreikį|pagal poreiki)(?=\p{L})/giu;
const unglueLtPhrase = (s: string): string => s.replace(LT_GLUED_PHRASE, '$1 ');

/* ───────────────────────────── the parser ──────────────────────────────── */

const EMPTY = (raw: string): ParsedIngredient => ({
    raw, name: '', nameFull: '', quantity: null, quantityMax: null, unit: null,
    note: null, optional: false, toTaste: false, ignored: true,
});

/**
 * Parse one published ingredient line. Returns one entry per ingredient — a
 * line like "Druskos, pipirų, lauro lapų" is three things to buy, and the
 * shopper should be able to strike them individually.
 */
export const parseIngredientLine = (rawLine: string, lang: Lang): ParsedIngredient[] => {
    const raw = rawLine.replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    if (isSectionHeading(raw) || isProse(raw)) return [EMPTY(raw)];

    const distributed = splitEach(raw);
    if (distributed) return distributed.flatMap(line => parseIngredientLine(line, lang));

    const parts = splitMultiIngredient(raw, lang);
    return parts.map(part => parseSingle(part, raw, lang)).map(markUnshoppable);
};

/**
 * "2 teaspoons EACH: black pepper, garlic powder, onion powder" — one amount
 * spread over several ingredients.
 *
 * Three spices reached the basket as a single ingredient literally named
 * "each", and the other two were lost entirely. The word is doing real work:
 * it says the measure repeats, so the honest reading is three lines, each
 * carrying the same amount, which the shopper can then strike individually.
 *
 * Requires a DIGIT in the head, so prose that happens to contain "each" is
 * untouched, and the split runs before everything else because the shapes it
 * produces ("2 teaspoons black pepper") are the ordinary ones.
 */
const EACH_DISTRIBUTES = /^(?<head>[^,;]*\d[^,;]*?)\s+each\b\s*:?\s+(?<rest>.+)$/i;

const splitEach = (raw: string): string[] | null => {
    const m = EACH_DISTRIBUTES.exec(raw);
    if (!m?.groups) return null;
    const { head, rest } = m.groups;
    const parts = rest.split(/\s*,\s*|\s+and\s+|\s+ir\s+/i).map(p => p.trim()).filter(Boolean);
    // One part means "each" was not distributing anything after all.
    if (parts.length < 2) return null;
    return parts.map(part => `${head} ${part}`);
};

/**
 * WATER IS NOT A PURCHASE.
 *
 * It was the single most common "unmatched ingredient" in the holdout — five
 * lines across 23 recipes — and reporting it as a failed match is wrong twice
 * over: nothing was mis-parsed, and there is nothing to put in a basket. It is
 * still returned as a line (marked ignored) so the shopper can see the recipe
 * mentioned it; it just stops counting as a miss.
 *
 * Deliberately narrow: only water with a TEMPERATURE in front of it. Mineral,
 * sparkling, coconut, rose and orange-blossom water are all things you buy, and
 * none of them survive this test.
 */
const TAP_WATER = new RegExp(
    '^(?:(?:warm|hot|cold|boiling|boiled|lukewarm|tepid|iced|ice|filtered|fresh|room temperature|'
    + 'salto|silto|karsto|verdancio|virinto|svaraus|saltas|siltas|karstas|verdantis)\\s+)*'
    + '(?:water|vanduo|vandens|vandeni)$',
    'i',
);

/**
 * Neither are these — each measured on the 180-recipe baseline sweep, each
 * reaching the basket as an unmatched row the shopper can do nothing with:
 *   · "tešlos rauginimas" — valgom.lt prints the dough-PROVING step inside its
 *     ingredient list ("1 a.š. tešlos rauginimas", ×4). It is an instruction,
 *     not a thing, and the amount it carries does not make it one — so this
 *     test is NOT gated on the quantity being empty.
 *   · "ledukai" — ice cubes are tap water in another shape (receptai.lt glues
 *     them too: "šiek tiekledukai", "200 mililitrųledukai(kubeliai)").
 *     Diminutive forms only: "ledai" is ICE CREAM, one letter away and a real
 *     product, and must never match.
 * Matched against the FOLDED name, same as TAP_WATER above.
 */
const NEVER_BOUGHT = new RegExp(
    '^(?:teslos\\s+raugini\\p{L}*'
    // "ledo gabaliukai" is the same ice one synonym over — outside this list
    // it fell through to the lexicon, where the stem 'led' means ICE CREAM,
    // and a drink recipe was silently sold "Valgomieji ledai OREO" for its
    // ice cubes. Ignored like 'ledukai', not matched to the 'Ledo kubeliai'
    // category: ice is tap water in another shape, same as the rest of this
    // list.
    //
    // The bare noun too: a cocktail's "Ledas" / "200 g ledo" is the SINGULAR
    // (ledas = ice, the substance) and it took the same lexicon fall into
    // ice cream. Anchored full-name alternatives, so the PLURAL 'ledai' —
    // which really is ice cream, one letter away — can never match.
    + '|leduk\\p{L}*|led(?:as|o)|ledo\\s+kubel\\p{L}*|ledo\\s+gabal\\p{L}*'
    + '|(?:crushed\\s+)?ice(?:\\s+cubes?)?)$', 'iu');

/**
 * KITCHEN EQUIPMENT the sites list among the ingredients — same machinery as
 * NEVER_BOUGHT, split out because these are objects, not foods in another
 * shape. Each was a judged finding ("1 lapas kepimo popieriaus" was MATCHED
 * and reached the basket) or its obvious sibling on the same line shape:
 * baking parchment, foil, cling film, skewers, toothpicks, kitchen string.
 *
 * Matched against the FOLDED whole name, so the patterns are diacritic-free.
 * Deliberately anchored and prefix-gated where a bare word could name FOOD:
 *   · "popierius" needs a kepimo/parchment-ish qualifier — "ryžių popierius"
 *     (rice paper) IS food and must never match; same for EN "rice paper"
 *     (only baking/parchment/greaseproof/wax qualify).
 *   · "iešmeliai" matches bare or with a material word ("mediniai") — but a
 *     FOOD skewer ("mėsos iešmeliai", "chicken skewers") carries its food
 *     noun in front and the anchor rejects it.
 *   · bare "string"/"twine" is safe whole-name; "string beans" never is the
 *     whole name.
 */
const NEVER_BOUGHT_KIT = new RegExp(
    // parchment / baking paper
    '^(?:(?:kepimo|sviestin\\p{L}*|pergamentin\\p{L}*)\\s+popier\\p{L}*'
    + '|kepimo\\s+pergament\\p{L}*|pergament\\p{L}*'
    + '|(?:baking|parchment|greaseproof|waxed?)\\s+paper|baking\\s+parchment|parchment'
    // foil
    + '|(?:aliuminio\\s+|maistine\\s+)?folij\\p{L}*'
    + '|(?:aluminium\\s+|aluminum\\s+|tin\\s+|kitchen\\s+)?foil'
    // cling film
    + '|(?:maistine\\s+)?plevel\\p{L}*'
    + '|cling\\s*(?:film|wrap)|plastic\\s+wrap'
    // skewers
    + '|(?:mediniai\\s+|mediniu\\s+|bambuko\\s+|bambukiniai\\s+|bambukiniu\\s+|metaliniai\\s+)?iesm\\p{L}*'
    + '|(?:wooden\\s+|bamboo\\s+|metal\\s+)?skewers?'
    // toothpicks
    + '|dantu\\s+krapstuk\\p{L}*|krapstuk\\p{L}*|toothpicks?|cocktail\\s+sticks?'
    // kitchen string
    + '|(?:kitchen\\s+|butcher\\s?s\\s+)?(?:string|twine)|virvel\\p{L}*|virvut\\p{L}*'
    + ')$', 'iu');

/**
 * "daigų papuošimui" (beatosvirtuve.lt) — a garnish INSTRUCTION: a dative of
 * purpose with no amount anywhere. The colon spelling of the same idea
 * ("Papuošimui: grietinė") names a real ingredient behind the heading and is
 * COLON_HEADING's business — this fires only when the purpose word is the
 * whole tail of a bare, amountless line. The quantity gate in markUnshoppable
 * is what keeps "100 g šokolado papuošimui" shoppable: with an amount, the
 * site is telling us to buy some.
 */
const GARNISH_INSTRUCTION = /^\p{L}+\s+(?:papuosimui|puosimui|dekoravimui)$/iu;

/**
 * A trailing PURPOSE clause — what the ingredient is FOR, never what it is:
 * "šokolado papuošimui" (chocolate for decorating), "aliejaus kepti" (oil for
 * frying), "sviesto bandelėm aptepti" (butter to brush the buns with). Left in
 * place, the tail reaches the catalog query, where `stemQuery` ANDs every word
 * and the purpose word zeroes the search — the mango row bought DRIED mangoes
 * because "konservuotų mangų Sirupo neišpilkite" found nothing and the bare
 * lexicon name did.
 *
 * The vocabulary is COLON_HEADING's Lithuanian half (the same purpose nouns,
 * met as a colon head there and as a bare dative tail here) plus the purpose
 * infinitives with their optional dative object ("bandelėm aptepti").
 * Deliberately ABSENT: "pabarstyti" — measured, stripping it turned a flagged
 * seed-mix row into a silently wrong one, the single regression of the sweep
 * that sized this rule.
 *
 * Only a line WITH an amount is stripped (see the gate in parseSingle): a bare
 * "daigų papuošimui" has nothing to buy and stays GARNISH_INSTRUCTION's
 * business, while "100 g šokolado papuošimui" is a real purchase whose tail is
 * noise. That is the same quantity gate markUnshoppable already applies, run
 * from the other side.
 */
const LT_PURPOSE_TAIL = new RegExp(
    '\\s+(?:'
    + 'kepimui|papuošimui|papuosimui|puošimui|puosimui|dekoravimui|patiekimui'
    + '|padažui|padazui|įdarui|idarui|tešlai|teslai|užpilui|uzpilui|garnyrui'
    + '|(?:\\p{L}+(?:ui|ams|oms|ems|ėms|iems|ims|ums|am|om|em|ėm|iem)\\s+)?'
    + '(?:aptepti|apvolioti|patepti|ištepti|istepti|kepti)'
    + ')\\s*$', 'iu');

/**
 * "cukraus miltelių 5 kartus daugiau(, nei baltymo)" — a PROPORTION remark
 * ("5× more than the egg white"), not part of any name. Stripped without the
 * amount gate the purpose tails need: the line legitimately carries no amount
 * of its own — the remark IS its amount — and "N kartus daugiau" can never be
 * mistaken for an ingredient, so the garnish-instruction distinction the gate
 * protects is not in play.
 */
const LT_PROPORTION_TAIL = /\s+\d+\s+kart\p{L}*\s+(?:daugiau|mažiau|maziau)\s*$/iu;

/**
 * A trailing INSTRUCTION sentence, glued on when the site appends one after
 * the amount: "Mažos skardinės konservuotų mangų (400 g) Sirupo neišpilkite."
 * — "don't discard the syrup". The imperative "-kite" is the marker (no
 * Lithuanian food noun ends that way), and the optional word before it is the
 * verb's object, part of the same sentence. Case-SENSITIVE on purpose: the
 * regex has no `i` flag so `\p{Lu}` keeps meaning a capital — the mid-name
 * capital is the start of the glued sentence.
 */
const LT_INSTRUCTION_TAIL = /\s+(?:\p{Lu}\p{L}*\s+)?(?:[Nn]e)?\p{L}{2,}kite\s*$/u;

/** Peel purpose/instruction tails off the end of a Lithuanian name. Null when
 *  nothing was stripped or stripping would empty the name. */
const stripPurposeTail = (text: string): { name: string; tail: string } | null => {
    let s = text;
    const removed: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
        const m = s.match(LT_PURPOSE_TAIL) ?? s.match(LT_INSTRUCTION_TAIL);
        if (!m || m.index == null || m.index === 0) break;
        removed.unshift(m[0].trim());
        s = s.slice(0, m.index).replace(/[\s,.;]+$/, '').trim();
    }
    if (removed.length === 0 || !s) return null;
    return { name: s, tail: removed.join(' ') };
};

const markUnshoppable = (p: ParsedIngredient): ParsedIngredient => {
    if (p.ignored) return p;
    const name = fold(p.name).trim();
    if (TAP_WATER.test(name) || NEVER_BOUGHT.test(name) || NEVER_BOUGHT_KIT.test(name)) {
        return { ...p, ignored: true };
    }
    if (p.quantity == null && p.unit == null && GARNISH_INSTRUCTION.test(name)) {
        return { ...p, ignored: true };
    }
    return p;
};

/**
 * Split "Druskos, pipirų, lauro lapų" into three.
 *
 * Deliberately conservative: only a line with NO amount anywhere, at least two
 * comma-separated parts, and every part short enough to be a bare ingredient
 * name. "chicken breasts, cut into bite-size pieces" has a long tail and stays
 * whole — that comma introduces a prep note, not a second ingredient.
 */
const splitMultiIngredient = (line: string, lang: Lang): string[] => {
    // '½ garlic clove, minced' HAS an amount even though it has no ASCII digit;
    // without the vulgar glyphs in this test it split into two ingredients, the
    // second one being the word 'minced'.
    if (new RegExp(`[\\d${VULGAR_CLASS}]`).test(line)) return [line];
    // A bracket means parseSingle still has notes to peel. Splitting first cut
    // "Naan (, optional)" at the comma INSIDE the parentheses — two
    // ingredients, "Naan (" and "optional)".
    if (/[()]/.test(line)) return [line];
    const parts = line.split(/\s*,\s*|\s+(?:ir|and)\s+/i).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return [line];
    // A part that is ONLY preparation words means the "and" joined two
    // PARTICIPLES, not two ingredients: "coriander leaves picked and finely
    // chopped" split at that "and" emitted a phantom ingredient named
    // "finely" — and the coriander row the sweep had matched went with it.
    // The whole line is one ingredient wearing its prep, so it stays whole.
    if (parts.some(isPrepOnly)) return [line];
    // Short enough to be a bare name — OR long but RECOGNISED. The length gate
    // alone silently DROPPED an ingredient: "Kosher salt and freshly ground
    // black pepper" has a four-word second part, so the line stayed whole, the
    // lexicon then read the whole thing as black pepper, and the salt never
    // reached the basket. A part the lexicon knows is an ingredient however
    // long it is; "cut into bite-size pieces" is four words the lexicon does
    // NOT know, so the prep-note case this gate protects still holds.
    const allShort = parts.every(p =>
        (p.split(/\s+/).length <= 3 && p.length <= 28) || findIngredient(stripPunct(p), lang) != null);
    if (!allShort) return [line];
    // A trailing "to taste" belongs to all of them, not to a fourth ingredient
    // — and "to serve"/"for serving" is a remark about the table, not a thing
    // to buy ("lime wedges, rice, guacamole …, to serve").
    const kept = parts
        .filter(p => !TO_TASTE_RE.test(p) || p.split(/\s+/).length > 1)
        .filter(p => !GARNISH_RE.test(p));
    // A part that is ONLY a modifier is never a thing to buy — "grietinė,
    // rūgšti" split into a bare "rūgšti", and "šviežio ir džiovinto
    // raudonėlio" into a bare "šviežio", and each then matched something
    // absurd with full confidence (a SOUR DOUGHNUT; a baby-nursery FEEDER,
    // "Šviežio maisto maitintuvas CANPOL"). Keep the line WHOLE instead:
    // splitNameAndNote folds the modifier back onto its noun ("rūgšti
    // grietinė", "marinuoti Agurkai") or notes it away — either way the noun
    // stays in charge. This also subsumes the earlier LT_IDENTITY_TAIL guard
    // here: identity participles are lexicon-null single words too.
    if (kept.some(isBareModifier)) return [line];
    return kept;
};

/** A part that is ONLY a serving remark — never an ingredient of its own. */
const GARNISH_RE = /^(?:to serve|for serving|for garnish|for dusting|optional)$/i;

/**
 * Every word of the part is a PREP word — the adverbs and participles of
 * EN_PREP_LEAD/EN_PREP_TRAIL plus their LT counterparts, as whole words. Such
 * a part can only be the second half of a "picked and finely chopped" tail,
 * so its presence proves the split found a conjunction of PARTICIPLES.
 */
const PREP_WORD = new RegExp(
    '^(?:finely|coarsely|roughly|thinly|freshly|very'
    + '|chopped|diced|minced|sliced|grated|shredded|crushed|packed|cooked|softened|melted'
    + '|beaten|peeled|drained|rinsed|juiced|halved|quartered|cubed|trimmed|picked|torn|washed'
    + '|smulkiai|stambiai|plonai|šviežiai|sviežiai'
    + '|susmulkint\\p{L}*|smulkint\\p{L}*|tarkuot\\p{L}*|pjaustyt\\p{L}*|supjaustyt\\p{L}*'
    + '|kapot\\p{L}*|grūst\\p{L}*|nulupt\\p{L}*|nuvarvint\\p{L}*|sutarkuot\\p{L}*|nuplaut\\p{L}*'
    + ')$', 'iu');

const isPrepOnly = (part: string): boolean =>
    part.split(/\s+/).every(w => PREP_WORD.test(stripPunct(w)));

/**
 * A fragment that is ONLY a modifier — an adjective or participle with no noun
 * ("rūgšti", "šviežio", "marinuoti"). The LEXICON decides, not an adjective
 * list: an enumeration would never be complete, and every modifier the
 * validation round caught was a single word that names no known food. The test
 * is deliberately one-word-only — "green salad" and "džiovinto raudonėlio" are
 * unknown to the lexicon too, but they carry their own noun and stay honest
 * split parts. The cost of the deliberate false positive (a single-word noun
 * the lexicon simply lacks) is mild: the line stays whole and the comma
 * arbitration keeps the KNOWN side as the name — never a phantom purchase.
 */
const isBareModifier = (part: string): boolean =>
    !/\s/.test(part) && /^\p{L}/u.test(part) && findIngredient(stripPunct(part)) == null;

/**
 * A heading GLUED to the first ingredient: "Optional, for creamy dressing:
 * 2 tablespoons tahini…". The colon is mid-line, so `isSectionHeading` cannot
 * see it, and the comma arbitration then returned heading + ingredient as one
 * name. The heading goes to the note; the optional flag was read before this
 * runs, so stripping "Optional," does not lose it.
 */
const HEADING_GLUE_RE = /^(?:optional\s*[,:]\s*)?(?:for|to)\s+(?:the\s+)?[\p{L}][\p{L}\s-]{0,28}:\s*/iu;

const stripHeadingGlue = (text: string, notes: string[]): string => {
    const m = text.match(HEADING_GLUE_RE);
    if (!m) return text;
    notes.push(m[0].replace(/[\s:]+$/, ''));
    return text.slice(m[0].length);
};

/**
 * skanauk.lt and receptai.lt print the amount AFTER the name, colon-separated:
 * "jautienos be kaulo: 1,3 kilogramo", "morkų: 4 (didelių)", "pipirų:
 * žiupsnelio", "druskos: pagal skonį". Taken literally the whole string
 * survived as the name and the quantity was truncated mid-decimal.
 *
 * When — and ONLY when — the colon tail is nothing but an amount, rewrite to
 * the ordinary amount-first shape and let the existing machinery do the rest.
 * The full-consumption test in `isAmountOnly` is the guard: a mid-line colon
 * can also be a glued heading, and there the tail carries a name too, so it
 * does not qualify and the line is left alone. (A colon at the very END is a
 * section heading and never reaches here — `isSectionHeading` claims it.)
 */
const refitColonAmount = (text: string, lang: Lang, notes: string[]): string => {
    // Colons inside parentheses are prose, not the separator — 'kreminis
    // sūris: 4 v. š. (pvz.: "Philadelphia")' must split at the FIRST colon,
    // so the search runs over a copy with the bracket contents blanked out.
    const masked = text.replace(/\([^()]*\)/g, m => ' '.repeat(m.length));
    const i = masked.lastIndexOf(':');
    if (i <= 0 || i >= text.length - 1) return text;
    let head = text.slice(0, i).trim();
    const tail = text.slice(i + 1).trim()
        // "laimo sultys: iš 1 vnt." (juice FROM one), "miltai: ~1,5 kilogramo"
        // (about) — approximation/derivation markers in front of the number,
        // and stray list punctuation after it ("pienas: 200 ml,").
        .replace(/^(?:iš|apie)\s+/i, '')
        .replace(/^~\s*/, '')
        .replace(/[\s.,;]+$/, '');
    if (!head || !tail || !isAmountOnly(tail, lang)) return text;
    // "Tešlai:Kiaušiniai: 4 vnt." — a heading glued in front of the name with
    // a colon of its own. The last segment is the name; the rest is heading.
    const j = head.lastIndexOf(':');
    if (j >= 0) {
        const heading = head.slice(0, j).trim();
        if (heading) notes.push(heading);
        head = head.slice(j + 1).trim();
        if (!head) return text;
    }
    return `${tail} ${head}`;
};

/**
 * 15min.lt and greitireceptai.lt write the amount INSIDE the ingredient text,
 * after the name and with no separator at all: "Bulvės 2,5 kg", "Varškė 500 g",
 * "Svogūnai 4 vnt", "Romas 4 šaukštai" (sometimes with a comma: "Romas,
 * 4 šaukštai"). Taken literally this failed twice over:
 *
 *  - the decimal COMMA of "Bulvės 2,5 kg" was read as the prep-note comma, so
 *    the name became "Bulvės 2" and the quantity was lost — every such line
 *    bought the 0.3 kg fallback instead of the 2.5 kg the dish needs, a
 *    systematic UNDERBUY the shopper cannot cook around;
 *  - the unit survived into the match query, and "Romas 4 šaukštai" (four
 *    tablespoons of rum) matched "Pietų šaukštai LAGUNA, 3" — CUTLERY, because
 *    "šaukštai" dominated the query. Every drink recipe hits this shape.
 *
 * Same cure as `refitColonAmount`: when — and ONLY when — everything from the
 * first number to the end of the line is an amount, rewrite to the ordinary
 * amount-first shape and let the existing machinery do the rest. The
 * full-consumption test in `isAmountOnly` is again the guard: "50 gramų
 * grietinėlės, 35%" has a trailing number too, but "35%" is not an amount, so
 * the line is left alone — as is "zest and juice of 1 lime", whose tail
 * "1 lime" ends in a name.
 */
const refitTrailingAmount = (text: string, lang: Lang): string => {
    // Colon lines belong to refitColonAmount/splitNonAmountColon, and a line
    // that already LEADS with an amount is the ordinary shape — a second
    // number further in ("1 28 oz. can …") is the pack-size fold's business.
    if (text.includes(':')) return text;
    if (takeQuantity(text, lang).quantity != null) return text;
    // Parentheses are notes; a number inside one must not look like the start
    // of the amount ("pagal poreikį agurkų (kiek tilps į stiklainį)").
    const masked = text.replace(/\([^()]*\)/g, m => ' '.repeat(m.length));
    const m = TRAILING_AMOUNT_START.exec(masked);
    if (!m || m.index === 0) return text;
    // The head is the name. Peel list punctuation and the approximation words
    // the colon refit also peels ("Bulvės apie 2,5 kg" must not be named
    // "Bulvės apie"); what is left has to look like a name — it ends in a
    // letter and stays short, so prose never qualifies.
    const head = text.slice(0, m.index).trim()
        .replace(/[\s,.;]+$/, '')
        .replace(/\s+(?:apie|iš)$/i, '');
    if (!head || !/\p{L}$/u.test(head) || head.split(/\s+/).length > 5) return text;
    const tail = text.slice(m.index).trim()
        .replace(/^~\s*/, '')
        .replace(/[\s,;]+$/, '');
    if (!isAmountOnly(tail, lang)) return text;
    return `${tail} ${head}`;
};

/**
 * greitireceptai.lt also prints a VAGUE amount after the name, with no number
 * anywhere: "Vanilinas žiupsnelis" (vanillin — a pinch). `refitTrailingAmount`
 * cannot help — there is no number for it to find — so the whole string
 * survived as the name and matched nothing. When the LAST word alone is a
 * pinch-word and a name precedes it, rewrite to the ordinary amount-first
 * shape ("žiupsnelis Vanilinas") and let the existing machinery read it: the
 * unit-with-no-number rule already makes it ONE pinch.
 *
 * Pinch-words ONLY, deliberately. A trailing count or package unit names a
 * PART of the product ("duonos riekelės" — bread slices, plural, count
 * unstated), and reading it as an amount of one would underbuy.
 */
const refitTrailingPinch = (text: string, lang: Lang): string => {
    if (lang !== 'lt') return text;
    const t = text.trim();
    // A digit anywhere means the ordinary paths own the line.
    if (new RegExp(`[\\d${VULGAR_CLASS}]`).test(t)) return text;
    const words = t.split(/\s+/);
    if (words.length < 2) return text;
    const last = stripPunct(words[words.length - 1]);
    if (lookupUnit(last) !== 'pinch') return text;
    return `${last} ${words.slice(0, -1).join(' ')}`;
};

/** Where a trailing amount can begin: a number token at a word start, allowing
 *  the "~" approximation prefix. First match only — with the head required
 *  digit-free-ish (it must end in a letter), a later number can only ever be
 *  part of an amount the first one starts. */
const TRAILING_AMOUNT_START = new RegExp(`(?<=\\s)~?\\s*(?:${NUM_GROUP})`, 'u');

/** Is `tail` nothing but an amount — a number, a unit, both, or a to-taste
 *  phrase? Parenthetical asides ("4 (didelių)") don't count against it. */
const isAmountOnly = (tail: string, lang: Lang): boolean => {
    const t = tail.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/[\s.,;]+$/, '');
    if (!t) return false;
    if (!t.replace(TO_TASTE_RE, ' ').trim()) return true;
    const q = takeQuantity(t, lang);
    // The size adjective sits between the number and the unit here too:
    // "špinatų lapai: 4 didelių saujų".
    const adj = takeSizeAdjective(q.rest, lang);
    const u = takeUnit(adj.rest, lang);
    if (q.quantity == null && u.unit == null) return false;
    const leftover = u.rest.replace(/[\s.,;]+$/, '');
    if (!leftover) return true;
    // "bulvės: 6 vidutinio dydžio" prints the size bare, with no unit at all.
    // A leftover that is ONLY a size adjective still qualifies. Rebuilt from
    // the adjective pass too: on "vidutinio dydžio" that pass eats just
    // "vidutinio" (the two-word form demands a trailing space), and the
    // stranded "dydžio" alone would fail the test. The appended space is what
    // the ^-anchored, space-terminated adjective patterns need to see.
    const bareSrc = [adj.adjective, leftover].filter(Boolean).join(' ');
    const bare = takeSizeAdjective(`${bareSrc} `, lang);
    return bare.adjective != null && bare.rest.trim() === '';
};

/** The spelled approximation markers, in both languages, gated on a number
 *  actually following — "apie", "maždaug", "about" in front of anything else
 *  is prose, not an amount. */
const APPROX_LEAD_RE = new RegExp(
    `^\\s*(?:apie|maždaug|mazdaug|about|approx\\.?|approximately|roughly|around)\\s+(?=[~\\d${VULGAR_CLASS}])`, 'i');

const parseSingle = (part: string, rawLine: string, lang: Lang): ParsedIngredient => {
    let text = part;
    text = text.replace(PRICE_RE, ' ').replace(CROSSREF_RE, ' ');
    text = preferMetricHalf(unglueLtPhrase(unglueParens(text)));

    // The flags are read BEFORE the heading strip below — "Optional, for
    // creamy dressing: …" must stay optional after "Optional," is stripped.
    const optional = OPTIONAL_RE.test(text);
    const toTaste = TO_TASTE_RE.test(text);

    const notes: string[] = [];
    text = stripHeadingGlue(text, notes);
    text = refitColonAmount(text, lang, notes);
    // Still carrying a colon? Then the tail was not an amount, and one of the
    // two sides is the ingredient.
    if (text.includes(':')) text = splitNonAmountColon(text, notes);
    text = refitTrailingAmount(text, lang);
    text = refitTrailingPinch(text, lang);

    // Parentheses are notes — except when the ONLY content is a size, in which
    // case it is the package the count refers to ("1 (400 g) can tomatoes") —
    // or, on a Lithuanian line, a bare list of product-DEFINING words, which
    // must reach the NAME (see bracketQualifiers: "kiauliena(kumpis, rūkytas)"
    // noted away bought raw mince for smoked ham strips).
    let packSize: { qty: number; unit: Unit } | null = null;
    const qualPre: string[] = [];
    const qualPost: string[] = [];
    // RecipeTin Eats double-wraps: "((or other cheese of choice))". One pass of a
    // non-nesting regex peels the inner pair and leaves a lone ")" stranded in
    // the product name, so peel until nothing changes, then sweep up any
    // unbalanced bracket that survived.
    for (let pass = 0; pass < 3; pass++) {
        const before = text;
        text = text.replace(/\(([^()]*)\)/g, (_, inner: string) => {
            const sized = parsePackSize(inner);
            if (sized && !packSize) { packSize = sized; return ' '; }
            const t = inner.trim();
            if (t) {
                // The bracket ALSO stays in the note when its words are
                // promoted — "juostelės" in "(kumpis, rūkytas, juostelės)" is
                // not recognised and would otherwise vanish entirely.
                if (lang === 'lt') {
                    const qual = bracketQualifiers(t);
                    if (qual) { qualPre.push(...qual.pre); qualPost.push(...qual.post); }
                }
                notes.push(t);
            }
            return ' ';
        });
        if (text === before) break;
    }
    text = text.replace(/[()]/g, ' ');

    text = text.replace(FOOTNOTE_RE, ' ').replace(/\s+/g, ' ').trim();
    text = text.replace(TO_TASTE_RE, ' ').replace(/\s+/g, ' ').trim();

    // "~500 gramų faršo" — a leading approximation tilde hides the number from
    // the quantity grammar entirely. beatosvirtuve.lt SPELLS the tilde instead
    // — "apie 400 ml vandens" — and with "apie" left standing the amount never
    // parsed and the name kept the word, so the TAP_WATER rule never saw plain
    // "vandens": tap water reached the basket as an unmatched row. The colon
    // refit already peels "apie" on its own path; this is the same courtesy on
    // the ordinary one. Digit-gated, so a name that merely STARTS with one of
    // these words loses nothing.
    text = text.replace(APPROX_LEAD_RE, '');
    text = text.replace(/^\s*~\s*/, '');
    // sallysbakingaddiction spells the mixed number: "3 and 1/4 cups". The
    // quantity grammar is whitespace-only, so the "and" stopped it at 3 and the
    // fraction leaked into the name. Anchored and fraction-required, so
    // "salt and pepper" is untouched.
    text = text.replace(/^(\s*\d+)\s+and\s+(\d+\s*\/\s*\d+)/i, '$1 $2');

    // A size adjective can LEAD the line ("Scant ½ teaspoon fine salt"), and
    // the size-adjective pass below runs after takeQuantity — too late, the
    // quantity was already unreachable behind the adjective. This early call is
    // ^-anchored, so it no-ops on every line that starts with a digit.
    const led = takeSizeAdjective(text, lang);
    if (led.adjective) notes.push(led.adjective);
    text = led.rest;

    // "zest and juice of 1 lime" — you buy the lime. Stripped BEFORE the amount
    // is read, because the number sits behind the phrase.
    if (lang === 'en') {
        const derived = text.match(EN_DERIVED_OF);
        if (derived) {
            notes.push(derived[0].trim());
            text = text.slice(derived[0].length);
        }
    }

    const head = takeQuantity(text, lang);
    let { quantity, quantityMax } = head;

    // "2 x 400g tins chopped tomatoes" — strip the multiplier so the pack-size
    // fold below sees "400g tins …" and does the arithmetic. Whitespace after
    // the x is required, so the x of a word is safe.
    let afterHead = head.rest;
    if (quantity != null) afterHead = afterHead.replace(/^\s*[x×]\s+(?=\S)/i, '');

    // "2 mažų skiltelių česnako", "2 vidutinio dydžio svogūnų", "1 large onion":
    // a size adjective sits between the amount and the unit and hides the unit
    // from the table. It is real information (a small clove is not a big one),
    // so it becomes a note rather than being thrown away.
    const sized = takeSizeAdjective(afterHead, lang);
    if (sized.adjective) notes.push(sized.adjective);
    const afterQty = sized.rest;

    const u = takeUnit(afterQty, lang);
    let unit = u.unit;
    let rest = u.rest;

    // "1 28 oz. can crushed tomatoes" — a count, then the package size, then
    // the container. Fold the package into the amount so the shopper gets one
    // 794 g tin rather than the number 1.
    if (unit == null && quantity != null) {
        const inner = takeQuantity(rest, lang);
        if (inner.quantity != null) {
            const innerUnit = takeUnit(inner.rest, lang);
            if (innerUnit.unit) {
                packSize = { qty: inner.quantity, unit: innerUnit.unit };
                rest = innerUnit.rest;
                const container = takeUnit(rest, lang);
                if (container.unit) rest = container.rest;
            }
        }
    }

    if (lang === 'en') {
        // "400g / 14oz can chickpeas" — the container strip lived only inside
        // the unit==null fold above, so once a mass unit was taken the "can"
        // survived into the name. The required trailing space keeps "canned
        // tuna" and "jarred peppers" whole.
        rest = rest.replace(/^(?:cans?|tins?|jars?|packs?|packets?|tubs?|bottles?|boxe?s?|punnets?|blocks?)\s+(?=\p{L})/iu, '');
        // "Pinch of red pepper flakes", "packet of cooked lentils" — a dangling
        // "of" after a vague unit or a just-stripped container. AFTER the
        // container strip, because the two stack. English only: LT marks the
        // relation with the genitive, not a preposition.
        rest = rest.replace(/^of\s+(?:the\s+)?/i, '');
    }

    if (packSize && quantity != null) {
        const p = packSize as { qty: number; unit: Unit };
        // Two different things live in brackets. "1 (400 g) can tomatoes" is a
        // COUNT of packages — multiply. "8 tablespoons (113g) butter" is a US
        // baking site RESTATING the measure it just wrote in metric — and
        // multiplying turned it into 904 g of butter with a perfectly clean
        // name, invisible downstream. If a mass/volume measure was already
        // taken off the line, the bracket restates it: replace.
        const dim = unit == null ? 'count' : unitDimension(unit);
        if (unit != null && (dim === 'mass' || dim === 'volume')) {
            quantity = p.qty;
            quantityMax = null;
            unit = p.unit;
        } else {
            quantity = round3(quantity * p.qty);
            quantityMax = quantityMax == null ? null : round3(quantityMax * p.qty);
            unit = p.unit;
        }
    }

    // A unit with no number in front means one of them: "Šaukšto medaus",
    // "Clove garlic". The recipe assumed the reader could count.
    if (unit != null && quantity == null) quantity = 1;

    let { name, note, nameFull } = splitNameAndNote(rest, lang);

    /**
     * English puts the sub-part AFTER the noun as often as before it: "3 garlic
     * cloves" and "2 cloves garlic" are the same shopping.
     *
     * Two guards, both learned the hard way. It runs only once the prep note has
     * been split off, because on the raw tail the last word of "garlic clove,
     * minced" is "minced". And it needs an amount: with none, "lauro lapų" (bay
     * leaves) had its head noun read as a unit and became "lauro". Lithuanian is
     * excluded outright — there the unit precedes the noun, so there is nothing
     * to gain and a genitive-plural noun to lose.
     */
    if (unit == null && quantity != null && lang === 'en') {
        const tail = takeTrailingUnit(name);
        if (tail) {
            unit = tail.unit;
            name = tail.rest;
            nameFull = takeTrailingUnit(nameFull)?.rest ?? nameFull;
        }
    }

    /**
     * FIX (measured): strip the trailing purpose clause from the NAME so it
     * never reaches the catalog query. Gated on an amount being present — the
     * exact line markUnshoppable draws from the other side: with an amount the
     * site is telling us to BUY the garnish, without one the whole line is an
     * instruction and GARNISH_INSTRUCTION ignores it. Stripped from `nameFull`
     * too: both the lexicon lookup and the recipe-phrase search arm read it,
     * and `droppedWord` would otherwise flag the tail as a lost identity word.
     */
    if (lang === 'lt' && (quantity != null || unit != null)) {
        const stripped = stripPurposeTail(name);
        if (stripped) {
            notes.push(stripped.tail);
            name = stripped.name;
            nameFull = stripPurposeTail(nameFull)?.name ?? nameFull;
        }
    }
    // The proportion remark needs no amount gate — see LT_PROPORTION_TAIL.
    if (lang === 'lt') {
        const m = name.match(LT_PROPORTION_TAIL);
        if (m && m.index != null && m.index > 0) {
            notes.push(m[0].trim());
            name = name.slice(0, m.index).replace(/[\s,.;]+$/, '').trim();
            nameFull = nameFull.replace(LT_PROPORTION_TAIL, '').replace(/[\s,.;]+$/, '').trim() || nameFull;
        }
    }

    /**
     * FIX (measured): the bracket qualifiers collected above reach the NAME —
     * "14 vienetų kiauliena(kumpis, rūkytas, juostelės)" parsed to bare
     * "kiauliena" and bought RAW 30% MINCE for smoked ham strips; "vištiena
     * (krūtinėlė)" a whole broiler instead of breast fillet. Folded LAST, once
     * the purpose/instruction tails are gone, so a stripped tail can never
     * split the qualifier from its noun. `nameFull` carries them too: the
     * lexicon and the recipe-phrase search read it, and the qualifier IS the
     * identity. Deduped by folded word so a name that already says "rūkyta"
     * does not say it twice.
     */
    if (name && (qualPre.length > 0 || qualPost.length > 0)) {
        const has = (base: string, w: string) =>
            fold(base).toLowerCase().split(/\s+/).includes(fold(w).toLowerCase());
        const pre = qualPre.filter(w => !has(name, w));
        const post = qualPost.filter(w => !has(name, w));
        name = [...pre, name, ...post].join(' ');
        nameFull = [...pre, nameFull || name, ...post].join(' ');
    }

    const allNotes = [...notes, note].filter(Boolean).join('; ') || null;

    return {
        raw: rawLine,
        name,
        nameFull: nameFull || name,
        quantity,
        quantityMax,
        unit,
        note: allNotes,
        optional,
        toTaste,
        ignored: name.length === 0,
    };
};

/** Units that name a PART of an ingredient, so they can legitimately trail the
 *  noun ("garlic cloves", "celery stalks", "bread slices"). */
const PART_UNITS = new Set<Unit>(['clove', 'slice', 'sprig', 'stalk', 'head', 'sheet', 'bunch']);

const takeTrailingUnit = (text: string): { unit: Unit; rest: string } | null => {
    const words = text.trim().split(/\s+/);
    if (words.length < 2) return null;
    const last = stripTrailingDot(words[words.length - 1].replace(/[,;]$/, ''));
    const unit = lookupUnit(last);
    if (!unit || !PART_UNITS.has(unit)) return null;
    return { unit, rest: words.slice(0, -1).join(' ') };
};

/**
 * Size adjectives, which recipes put between the amount and the unit. Kept to a
 * closed list of genuine size words: a wider net would start eating adjectives
 * that identify the PRODUCT ("saldi paprika" — sweet pepper — is not a size).
 */
const LT_SIZE_ADJ = /^(?:labai\s+)?(?:vidutinio dydžio|vidutinio|vidutinės|vidutiniai|mažų|mažas|maža|mažos|mažo|mažų|nedidelių|nedidelio|nedidelė|nedidelis|didelė|didelis|didelių|didelio|didelės|stambių|stambus|smulkių)\s+/i;
const EN_SIZE_ADJ = /^(?:extra[- ])?(?:small|medium(?:[- ]sized)?|large|big|little|whole|(?:loosely |firmly |lightly )?packed|heaped|heaping|rounded|level|scant|generous)\s+/i;

const takeSizeAdjective = (text: string, lang: Lang): { adjective: string | null; rest: string } => {
    // Trim first: the quantity match leaves a leading space, and these patterns
    // are anchored at ^, so without this every adjective survived into the
    // product name ("small yellow onion" instead of "yellow onion").
    const t = text.replace(/^\s+/, '');
    const re = lang === 'lt' ? LT_SIZE_ADJ : EN_SIZE_ADJ;
    const m = t.match(re);
    if (!m) return { adjective: null, rest: t };
    return { adjective: m[0].trim(), rest: t.slice(m[0].length) };
};

/**
 * "(400 g)" / "(28 oz.)" → a package size rather than a note.
 *
 * Only a MEASUREMENT qualifies. RecipeTin Eats writes "2 packed cups broccoli
 * (, soft cooked & finely chopped (1 head)(Note 2))", and reading "(1 head)" as
 * the package turned two cups of broccoli into one head of it. A count in
 * brackets is a remark about the shopping, not the amount of the ingredient.
 */
const parsePackSize = (inner: string): { qty: number; unit: Unit } | null => {
    const t = inner.trim();
    const m = t.match(new RegExp(`^(${NUM_GROUP})\\s*([\\p{L}.]+)$`, 'u'));
    if (!m) return null;
    const qty = numberFrom(m[1]);
    const unit = lookupUnit(stripTrailingDot(m[2]));
    if (qty == null || !unit) return null;
    const dim = unitDimension(unit);
    if (dim === 'count' || isVagueUnit(unit)) return null;
    return { qty, unit };
};

/**
 * receptai.lt-style lines put the ACTUAL product inside the brackets:
 * "kiauliena(kumpis, rūkytas, juostelės)" is smoked ham strips, not pork with
 * a footnote — noted away, the query was bare "kiauliena" and bought RAW 30%
 * MINCE for it; "vištiena (krūtinėlė)" bought a whole broiler instead of
 * breast fillet, "vynas(baltas)" landed on white wine only by luck. When the
 * bracket is a bare list of product-defining words, they must reach the name.
 *
 * Decided by what the bracket CONTAINS, never by position, because the same
 * brackets also hold amounts, prep, alternatives and serving asides — each
 * pinned by an existing test. The gates, in order:
 *   · letters, commas and spaces only — a digit is an amount, a conversion or
 *     an age ("(apie 400 g)", "(nuo 8 mėn.)"); quotes and colons are brand
 *     asides ('(pvz.: "Philadelphia")');
 *   · every comma-separated segment must be ONE bare word — "tamsios ar
 *     šviesios" (an alternative), "smulkiai supjaustyta" (prep) and "virtos
 *     su lupena" (prep, pinned on the bulvės line) are all multi-word, and a
 *     multi-word segment is exactly where certainty ends;
 *   · a surviving word still has to be RECOGNISED: an identity participle
 *     (the "Dešra, virta" list), a colour/type adjective, a named cut, or a
 *     lexicon food ("(morkų, bulvių)" — a spec-list, not a sauce). "kubeliai"
 *     matches none, so "ledukai(kubeliai)" stays ignored ice, and "didelių"
 *     stays a size note.
 * Unrecognised words stay in the note only — a lost qualifier costs a worse
 * match, a wrongly promoted one costs a wrong product.
 *
 * Adjectives go BEFORE the base noun ("baltas vynas"), cut/food nouns AFTER
 * ("vištiena krūtinėlė") — the order the catalog prints.
 */
interface BracketQualifiers { pre: string[]; post: string[] }

/** Colour/type adjectives that select the product ("baltas" wine, "rudasis"
 *  sugar). Explicit adjective endings, not a bare stem: "balt[\p{L}]*" would
 *  also promote "baltymo" — the egg WHITE of a meringue note. */
const LT_QUAL_COLOUR = /^(?:balt|juod|raudon|žali|zali|rud|tams|švies|svies)(?:as|a|i|o|u|us|os|ų|ai|ią|ios|oji|asis)$/iu;

/** Named cuts and parts — the bracket that turns a species into a product
 *  ("kiauliena(kumpis…)", "vištiena (krūtinėlė)"). Closed list: the lexicon
 *  knows few of these as single words ("krūtinėlė" alone is not an entry).
 *  "ment-" is ending-restricted so "mentelė" (a spatula) can never qualify. */
const LT_QUAL_PART = /^(?:kumpi|krūtinėl|krutinel|šlaunel|slaunel|kulšel|kulsel|blauzdel|sparnel|filė|file|nugarin|šonin|sonin|sprandin)[\p{L}]*$|^ment(?:ė|e|ės|es|ę)$/iu;

const bracketQualifiers = (inner: string): BracketQualifiers | null => {
    if (!/^[\p{L}\s,]+$/u.test(inner)) return null;
    const segs = inner.split(',').map(s => s.trim()).filter(Boolean);
    if (segs.length === 0 || segs.some(s => /\s/.test(s))) return null;
    const pre: string[] = [];
    const post: string[] = [];
    for (const w of segs) {
        if (LT_IDENTITY_TAIL.test(w) || LT_QUAL_COLOUR.test(w)) pre.push(w);
        else if (LT_QUAL_PART.test(w) || findIngredient(w) != null) post.push(w);
    }
    if (pre.length === 0 && post.length === 0) return null;
    return { pre, post };
};

/**
 * The tail after a comma is preparation, not identity: "chicken breasts, cut
 * into bite-size pieces" is still chicken breast. Lithuanian does the same with
 * participles ("bulvių, virtų ir sutarkuotų").
 *
 * A leading adjective run is NOT stripped — "alyvuogių aliejus" (olive oil) and
 * "kvietiniai miltai" (wheat flour) mean different products from "aliejus" and
 * "miltai", and the catalog knows the difference.
 */
const splitNameAndNote = (
    rest: string, lang: Lang,
): { name: string; note: string | null; nameFull: string } => {
    // The leading-punct class carries `/` because `preferMetricHalf` can leave
    // a bare slash at the head when only one half of a dual measure was eaten.
    let s = rest.replace(/^[\s,.;:–—\/-]+/, '').replace(/[\s,.;:]+$/, '').trim();
    if (!s) return { name: '', note: null, nameFull: '' };

    let note: string | null = null;
    const noteDown = (n: string): void => {
        note = [note, n.trim()].filter(Boolean).join('; ');
    };

    if (lang === 'en') {
        // "1 Tbsp. plus 1½ tsp. kasoori methi" — a SECOND amount the grammar
        // cannot add (different units, maybe different dimensions). Remove
        // "plus <number> [unit]" and keep both sides of the name; the removed
        // span goes to the note so nothing is lost. Runs here, not on the raw
        // line, so the first amount is already safely taken.
        const pm = s.match(new RegExp(`(?:^|\\s)plus\\s+(?:${NUM_GROUP})\\s*`, 'i'));
        if (pm) {
            let end = pm.index! + pm[0].length;
            const uw = s.slice(end).match(/^([\p{L}]+\.?)(?:\s+|$)/u);
            if (uw && lookupUnit(stripTrailingDot(uw[1]))) end += uw[0].length;
            noteDown(s.slice(pm.index!, end));
            s = `${s.slice(0, pm.index!)} ${s.slice(end)}`.replace(/\s+/g, ' ').trim();
        }
        // "butter plus extra for cooking" — no amount after the plus, so the
        // whole tail is a remark. Truncate only mid-name: a LEADING "plus"
        // would leave an empty name.
        const pt = s.match(/\s+plus\s+\S.*$/i);
        if (pt && pt.index! > 0) {
            noteDown(s.slice(pt.index!));
            s = s.slice(0, pt.index!).trim();
        }
        // "tahini or ½ cup whole-milk Greek yogurt" — an alternative with its
        // OWN amount is a different offer, not part of this name. Plain
        // alternatives ("chicken or vegetable stock") carry no number and stay.
        const om = s.match(new RegExp(`\\s+or\\s+(?=(?:${NUM_GROUP})(?![\\p{L}]))`, 'i'));
        if (om && om.index! > 0) {
            noteDown(s.slice(om.index!));
            s = s.slice(0, om.index!).trim();
        }
        // "cornflour / cornstarch" — a synonym pair for the SAME product. Split
        // only when BOTH halves name a known food (the same arbitration the
        // comma branch uses); a slash inside an unknown phrase stays whole.
        const sl = s.match(/^([^/]+?)\s*\/\s*(\S[^/]*)$/);
        if (sl && findIngredient(sl[1]) != null && findIngredient(sl[2]) != null) {
            noteDown(sl[2]);
            s = sl[1].trim();
        }
    }

    const comma = s.indexOf(',');
    // Set when the comma tail was folded back INTO the name below — the folded
    // word is the product's identity, and the leading-participle strip further
    // down must not peel it off again.
    let leadIsIdentity = false;
    if (comma > 0) {
        const before = s.slice(0, comma).trim();
        const after = s.slice(comma + 1).trim();
        // LT sites also write "Ingredient, preparation": "Agurkai, marinuoti",
        // "Dešra, virta". That tail is not a prep INSTRUCTION — it selects the
        // product. Noted away, "Agurkai, marinuoti, 4 vienetai" bought FRESH
        // cucumbers instead of pickled, and "Dešra, virta, 100 gramų" a VEGAN
        // pepperoni instead of a cooked sausage. Fold the word back in front of
        // the noun ("marinuoti Agurkai"), the order the catalog prints.
        // LT_IDENTITY_TAIL is the closed list of preservation/state participles
        // that name real store categories (pickled/fermented/smoked/cooked/
        // salted/dried/canned/frozen).
        //
        // Beyond the list: ANY single-word modifier folds when the head is a
        // known food — "grietinė, rūgšti" must become "rūgšti grietinė" (sour
        // cream, a real product), because noted away the adjective is lost and
        // split off it matched a SOUR DOUGHNUT. Process words ("supjaustytas")
        // are excluded — as prep they stay notes, the existing convention — as
        // is a multi-word tail ("virtų ir sutarkuotų"): an instruction, not a
        // category. So is a dative purpose word: "Aliejus, kepimui" is oil FOR
        // frying, and the colon shape of the same line ("Aliejus: kepimui")
        // already files "kepimui" as the note — the `-ui` ending marks the
        // dative, which no nominative/genitive adjective ends in.
        if (lang === 'lt' && after && (LT_IDENTITY_TAIL.test(after)
            || (isBareModifier(after) && findIngredient(before) != null
                && !LT_PREP_LEAD.test(`${after} `) && !/ui$/i.test(after)))) {
            s = `${after} ${before}`;
            leadIsIdentity = true;
        } else if (lang === 'lt' && after && LT_IDENTITY_TAIL.test(before)
            && /^[\p{L}\s]+$/u.test(after)) {
            // The MIRROR of the fold above: the comma leaves the identity
            // participle as the HEAD and the noun in the tail. "Apie 800 g
            // virtos, keptos arba rūkytos paukštienos" — cooked, fried or
            // smoked POULTRY — noted the tail away, and the bare name "virtos"
            // then confidently bought cooked SAUSAGES. The line stays whole:
            // the participle selects, the tail carries the noun. Letters-only
            // tail, so "grietinėlės, 35%" keeps its note behavior.
            s = `${before} ${after}`;
            leadIsIdentity = true;
        } else {
            // Usually the tail is preparation: "chicken breasts, cut into
            // pieces". But food.com writes "boneless, skinless chicken breast",
            // where the HEAD is the qualifier and the noun is in the tail. The
            // ingredient table arbitrates: whichever side names a food is the
            // ingredient.
            const headIsFood = findIngredient(before) != null;
            if (!headIsFood && after && findIngredient(after) != null) {
                if (before) noteDown(before);
                s = after;
            } else {
                if (after) noteDown(after);
                s = before;
            }
        }
    }

    // Leading prep participles the sites put BEFORE the noun ("finely chopped
    // shallots", "tarkuoto česnako"). Strip them so the name is the thing, but
    // keep them as the note so nothing is lost.
    // Everything before the participles are stripped — the lookup phrase.
    const nameFull = s.replace(/\s+/g, ' ').trim();
    const lead = lang === 'lt' ? LT_PREP_LEAD : EN_PREP_LEAD;
    // Skipped when the leading word was just folded in from the comma tail:
    // "virta" IS in LT_PREP_LEAD (as prep it usually is — "virtų bulvių"), and
    // stripping it here would undo the "Dešra, virta" fold one line after
    // making it.
    for (; !leadIsIdentity;) {
        const m = s.match(lead);
        if (!m) break;
        noteDown(m[0]);
        s = s.slice(m[0].length).trim();
    }
    // English puts the participle AFTER the noun just as often ("cardamom pods
    // crushed", "1 lime juiced"). Applied here, after `nameFull` is captured,
    // for the same reason the leading rule is — the fuller phrase is what the
    // knowledge base looks up. The adverb group must ride along or it strands:
    // without it "red cabbage finely shredded" became "red cabbage finely".
    if (lang === 'en') {
        for (;;) {
            const m = s.match(EN_PREP_TRAIL);
            if (!m) break;
            noteDown(m[0]);
            s = s.slice(0, m.index).trim();
        }
    }

    return { name: s.replace(/\s+/g, ' ').trim(), note, nameFull };
};

/** Prep words that lead the noun. Only unambiguous ones: a word that could be
 *  part of a product name ("rūkyta dešra" — smoked sausage IS a product) stays. */
/** "juice of 1 lemon", "zest and juice of 1 lime" — what you buy is the fruit. */
const EN_DERIVED_OF = /^(?:the\s+)?(?:zest(?:\s+and\s+juice)?|juice(?:\s+and\s+zest)?|rind|peel)\s+(?:of|from)\s+/i;

const EN_PREP_LEAD = /^(?:finely |coarsely |roughly |thinly |freshly |very )?(?:chopped|diced|minced|sliced|grated|shredded|crushed|packed|cooked|softened|melted|beaten|peeled|drained|rinsed)\s+/i;
/**
 * A comma tail that is the product's IDENTITY, not a prep instruction — the
 * preservation/state participles LT sites hang after the noun ("Agurkai,
 * marinuoti"; "Dešra, virta"). One word, whole-tail, closed list; `[\p{L}]*`
 * rather than `\w*` because the endings carry diacritics ("virtų") and `\w` is
 * ASCII-only — the same trap the "to taste" regexes already paid for.
 * Diacritic-free stems ride along for lazy-CMS input ("rukyta", "dziovinti");
 * "saldyt" doubles as folded "šaldyt" (frozen) and literal "saldyta"
 * (sweetened) — both select a product, so the collision is harmless.
 */
const LT_IDENTITY_TAIL = /^(?:marinuot|raugint|rūkyt|rukyt|virt|sūdyt|sudyt|džiovint|dziovint|konservuot|šaldyt|saldyt)[\p{L}]*$/iu;
const LT_PREP_LEAD = /^(?:smulkiai |stambiai |plonai |šviežiai |sviežiai )?(?:susmulkint\w+|smulkint\w+|tarkuot\w+|pjaustyt\w+|supjaustyt\w+|virt\w+|keptų|kapot\w+|grūst\w+|nulupt\w+|nuvarvint\w+)\s+/i;
/** …and the ones that TRAIL it. Trailing-only members (juiced, halved, …) are
 *  here and not in the lead list: "juiced lime" is not how any site writes. */
const EN_PREP_TRAIL = /\s+(?:finely |coarsely |roughly |thinly |freshly |very )?(?:chopped|diced|minced|sliced|grated|shredded|crushed|melted|softened|beaten|peeled|drained|rinsed|juiced|halved|quartered|cubed|trimmed|picked)$/i;

/**
 * Parse a whole ingredient list. Section headings and prose come back with
 * `ignored: true` rather than being dropped, so a sweep can count what a site
 * throws at us and the UI can show an honest "we skipped these" list.
 */
export const parseIngredientLines = (lines: string[], lang: Lang): ParsedIngredient[] =>
    lines.flatMap(l => parseIngredientLine(l, lang));
