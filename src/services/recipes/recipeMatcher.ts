import { RECOGNITION } from '../../../../shared/recognitionConfig.js';
import pool from '../../config/db.js';
import type { Locale } from '../../middleware/locale.js';
import { searchProduct } from '../../models/productModel.js';
import {
    type AffinityCache, getProductAffinity, loadAffinityCache, rankAffinity,
} from '../productAffinityService.js';
import { levenshtein } from '../../utils/addressMatcher.js';
import { type MatchCandidate, findBestProductMatches } from '../../utils/productMatcher.js';
import { INGREDIENTS, INGREDIENT_INDEX, ingredientByKey } from './ingredientData.js';
import { type IngredientHit, contentWords, findIngredient, fold, formatMeasure, toMetric } from './measure.js';
import type { IngredientInfo, Lang, Measure, ParsedIngredient } from './types.js';

/**
 * RECIPE → CATALOG.
 *
 * The recipe says "3 valgomieji šaukštai aliejaus". The shop sells "Alyvuogių
 * aliejus 500 ml". Bridging that is two separate problems and this file keeps
 * them separate:
 *
 *   1. WHAT is it? The ingredient knowledge base recognises the phrase and hands
 *      back a canonical Lithuanian shopping name. This is also the translator:
 *      an English recipe's "all-purpose flour" resolves to "Kvietiniai miltai",
 *      because there is no translation service in this project and there will
 *      not be one (free-only).
 *   2. WHICH product? That is the catalog matcher this codebase already has —
 *      `searchProduct` for recall (it reaches Product names, StoreProduct names,
 *      English translations and learned receipt aliases), then
 *      `findBestProductMatches` in `typed` mode for the ranking.
 *
 * Nothing here invents a match. An ingredient we cannot name confidently comes
 * back with `product: null`, and the review screen says so.
 */

/** Typed input deserves a higher bar than OCR: the scrapers use 0.75–0.8 for
 *  clean text, and a wrong product in a shopping basket is worse than a gap. */
const AUTO_ACCEPT = RECOGNITION.match.autoApplyThreshold;   // 0.85
/**
 * A second, lower bar for matches whose score is depressed by BRANDING rather
 * than by disagreement.
 *
 * 0.85 is tuned for OCR receipt lines, where both sides are messy product labels.
 * Here the query is a short canonical name and the catalog name carries a brand
 * and a pack size, which costs points no matter how right the product is:
 * "Sviestas" → "ROKIŠKIO sviestas, 82 % rieb." and "Cukrus" → "Cukrus EXTRA LINE"
 * both land on exactly 0.78. Nearly the whole review pile was correct matches
 * like those, which trains a shopper to tap through the warnings.
 *
 * So a match also passes when the ENTIRE query survives inside the product name:
 * the product is the thing we asked for, wearing a brand. A product that drops
 * one of the query's words ("Sojos padažas" → "Majonezinis padažas su sezamais")
 * still goes to review, which is the case worth the shopper's attention.
 */
const SOFT_ACCEPT = 0.75;
const MIN_ACCEPT = 0.62;
const CANDIDATE_CAP = 40;
/**
 * HOW MANY CANDIDATES THE RANKING RULES GET TO SEE — not how many are shown.
 *
 * This was 4, the same as the display limit, and that quietly disabled every
 * rule in `rankPicks`. A search for "Kopūstai" returns the plain
 * "Lietuviški baltagūžiai kopūstai" FIRST, but scoring prefers short names, so
 * the four survivors were "Kopūstai korėjietiškai", "Rauginti kopūstai",
 * "Troškinti kopūstai" and "Marinuoti kopūstai" — four preparations and no
 * cabbage. The prepared-demotion rule then had nothing to promote, and a head
 * of green cabbage became a tub of Korean cabbage salad. The same emptied pool
 * turned beef into tinned stewed beef and turkey into tinned turkey.
 *
 * Twelve gives the gates a real pool to work with; the caller still slices the
 * top 4 for display, so nothing downstream sees more than it did.
 */
const RANKING_POOL = 12;

/**
 * The catalog sells kitchenware next to food, and a name match cannot tell them
 * apart: "cukraus pudra" matched "Cukraus pudros SIJOTUVAS" (an icing-sugar
 * sifter) at 0.86, and "vandens" matched "Vandens INDELIS" (a bowl). These words
 * name an object, never an ingredient, so a product carrying one is not a
 * candidate for a recipe at all.
 *
 * Deliberately short and unmistakable. "Rožinė druska malūnėlyje" — salt in a
 * grinder — IS salt and must stay, so a container the food comes IN is not on
 * this list; only the empty object is.
 */
/**
 * Seed packets that escaped the category rule by having NO category at all.
 *
 * Reaching into 'Nepriskirta' for fresh produce also reaches 305 garden seed
 * packets filed there. They are all named "Sėklos <CROP> <cultivar>" — the word
 * LEADS. The 88 real foods with the same word carry it later ("Garstyčių
 * sėklos", "Burnočio sėklos RIMI"), so anchoring to the start separates them
 * without touching food, which a bare `sėkl` match would not.
 */
const SEED_PACKET_NAME = /^\s*sėklos\b/i;

/**
 * Words that mark a catalog product as PREPARED rather than the raw ingredient:
 * "Morkos korėjietiškai" is a carrot SALAD, "Rauginti agurkai" are pickles,
 * "Vytinta kiauliena" is a dried snack, "Virta plėšoma jautiena" is a cooked
 * deli product. A recipe that says "morkų" wants a carrot.
 *
 * Applied only when the RECIPE did not ask for that preparation — "1 kg virtų
 * bulvių" and "konservuotų pupelių" carry the marker themselves, so those
 * queries are unaffected and still find the cooked/canned product they mean.
 * A demotion, never an exclusion: when the prepared form is all the catalog has,
 * it is still the best available answer.
 */
const PREPARED_MARKER = new RegExp(
    '(?<![\\p{L}])('
    + 'korėjietišk|marinuot|raugint|virt|kept|apkept|troškint|rūkyt|vytint|džiovint'
    + '|konservuot|sūdyt|plėšyt|plėšom|glazūruot|salot|paštet|tyrel|užkandži|vazonėl'
    // Found by the holdout: a whole composed DISH matching its main ingredient.
    // "Silkė pataluose" is herring-under-a-fur-coat, a layered salad, and it was
    // silently bought for four salted herrings the recipe batters and fries;
    // "Šaldyti daržovių kepsniai" are breaded patties, bought for a frozen
    // vegetable mix. Also "daigintos" — a punnet of living SPROUTS is not a bag
    // of raw seeds — and "malti", which is how ground ginger reached a recipe
    // asking for a chunk of the fresh root.
    + '|patalu|mišrain|misrain|sluoksniuot|kepsn|daigint|malt'
    // "savo sultyse" — tinned, in its own juice. The LOCATIVE only, never the
    // nominative "sultys": apple juice is a product a recipe can legitimately
    // ask for, a tin of turkey in its own juice is not what "ground turkey"
    // means.
    + '|sultyse|sūryme|suryme'
    // Shelf ABBREVIATIONS. "Š. rūk. pjaustyta lašišos filė" is cold-smoked
    // salmon, and spelling out "rūkyt" missed it — which also made it look like
    // a clean leader, ending the search before the alias that finds fresh
    // salmon ever ran. One unmatched abbreviation, two failures.
    + '|rūk\\.|ruk\\.|k\\.r\\.|š\\.rūk'
    // More of the same, from the produce aisle this time. "Mar. vyšniniai
    // pomidorai RIMI" is a JAR of vinegar-marinated cherry tomatoes filed in
    // 'Nepriskirta' — no category to demote it by — and it silently beat four
    // fresh cherry-tomato listings at 0.97 because "marinuot" is never spelled
    // out. "Dž. spanguolės NATURFOOD" (sweetened dried cranberries, same
    // shelf-less limbo) won the cranberry query the same way; "džiov." is the
    // longer spelling of the same abbreviation ("Fas. džiov. mėlynės GAR2").
    + '|mar\\.|dž\\.|dz\\.|džiov\\.|dziov\\.'
    // Not a preparation but a VARIETY, and it behaves the same way: heat has to
    // be asked for. A recipe saying "bell pepper" that silently receives hot
    // Padron chillies has been changed, not shopped for.
    + '|aitri'
    // Stuffed. "Saldžiosios paprikos įd.sūriu" is a cheese-stuffed deli item
    // that won the sweet-pepper query the moment it stopped losing to chillies;
    // the shelf abbreviates "įdaryti" to "įd." so both spellings are needed.
    + '|įdaryt|įd\\.'
    // Candy wearing a fruit's name. "Mėlynės šokolade LAIMA" — chocolate-coated
    // blueberries — won the blueberry query at 0.78 while "Šaldytos mėlynės
    // BERIBU" sat in the alternatives; the LOCATIVE "šokolade" only ever means
    // coated-in, never the chocolate bar itself ("šokoladas"). "Cukruotos
    // spanguolės" (sugared cranberries) are the same trick one shelf over.
    + '|šokolade|sokolade|cukruot'
    + ')\\p{L}*', 'iu');

/**
 * PET FOOD, by name, because 479 of it sits in 'Nepriskirta'.
 *
 * The proper pet departments (520-525) are already excluded by id, but the
 * uncategorised shelf that recipe search deliberately reaches into holds
 * hundreds of stragglers — and "2 lb ground turkey" was silently answered with
 * "Šald.šunų ėd. kalakutiena TOP DOG", frozen turkey DOG FOOD.
 *
 * Deliberately NOT matching 'gyvūn' ("animal"), which would also kill
 * "Vaikiški makaronai (gyvūnėlių formos)" — children's pasta in animal shapes,
 * which is real food. These five stems are feed-only: every product carrying
 * one is pet food or a pet toy, checked across the whole catalog.
 *
 * No \b: word boundaries are ASCII-only and would never fire on 'ėdal'.
 */
const PET_FOOD = /(ėdal|edal|šunų|sunu|šunims|sunims|kačių|kaciu|katėms|katems)/i;

const NOT_FOOD = /\b(sijotuvas|sijotuv|indelis|indeliai|dubenėlis|dubenėliai|keptuvė|puodas|puodai|formelė|formelės|kepimo forma|peiliukas|peiliai|trintuvė|tarkuotuvas|pjaustyklė|maišeliai|servetėlės|žvakė|žvakės|plovimo|valymo|šveitimo)\b/i;

/**
 * Category words a recipe uses when it does NOT care which product you buy —
 * "vaisiai pagal skonį", "uogos (mėlynės ar avietės)", "600 g mėsos". A phrase
 * made ONLY of these words cannot be answered by any single product, so a
 * match for one must never be silent (see `genericAsk` in `matchIngredient`).
 *
 * Both the nominative and the genitive of every LT word are listed and pushed
 * through `contentWords`, because the blunt stemmer does not always collapse
 * the pair on its own ("žuvis"/"žuvies" both stem to "zuv", but only because
 * both endings happen to be in the list — spelling the forms out here means a
 * stemmer tweak cannot silently open a hole in this guard). Deliberately
 * ABSENT: "grybai" — the knowledge base maps plain mushrooms to champignons,
 * which genuinely are the default mushroom in every LT shop, and flagging
 * every mushroom soup would drown the review pile the way the early
 * dropped-word rule did.
 */
const GENERIC_CATEGORY_WORDS: ReadonlySet<string> = new Set([
    'vaisiai', 'vaisių', 'uogos', 'uogų', 'prieskoniai', 'prieskonių',
    'žalumynai', 'žalumynų', 'mėsa', 'mėsos', 'žuvis', 'žuvies', 'žuvys',
    'sėklos', 'sėklų', 'riešutai', 'riešutų', 'daržovės', 'daržovių',
    'grūdai', 'grūdų',
    'fruit', 'fruits', 'berry', 'berries', 'spice', 'spices',
    'seasoning', 'seasonings', 'greens', 'meat', 'fish', 'seed', 'seeds',
    'nut', 'nuts', 'vegetable', 'vegetables', 'veggies', 'grain', 'grains',
].flatMap(w => contentWords(w)));

/**
 * Is the phrase NOTHING BUT a category word? "mėsos" is; "rūkytos mėsos" and
 * "šaldytų uogų" are not — a qualifier narrows the category enough that a
 * product carrying it (a frozen berry MIX for "frozen berries") can genuinely
 * be the thing asked for, and flagging those would re-break the case the
 * recipe-phrase arm exists to solve. Judged on the recipe's own words, not the
 * canonical query: the knowledge base maps "šaldytų uogų" to the generic
 * "Uogos" on purpose, and the generalisation must not inherit the flag.
 */
const namesOnlyACategory = (name: string): boolean => {
    const words = contentWords(firstAlternative(name));
    return words.length > 0 && words.every(w => GENERIC_CATEGORY_WORDS.has(w));
};

/**
 * Ground-spice entries whose bare word ALSO names a piece-countable vegetable,
 * keyed to the entry for that vegetable.
 *
 * Only paprika earns a row today: the paprika_ground entry owns the bare word
 * deliberately (EN "1 tsp paprika" is always the spice), and the veto in
 * `matchIngredient` needs somewhere to send a counted "1 vienetas paprika".
 * Ginger, garlic and onion do not need one — their bare words already belong
 * to the fresh entries, and their powders are only reachable through phrases
 * that say so ("ground ginger", "garlic powder").
 */
const PIECE_COUNT_REDIRECT: ReadonlyMap<string, string> = new Map([
    ['paprika_ground', 'bell_pepper'],
]);

/**
 * Whole DEPARTMENTS that sell nothing a recipe can use — excluded by category
 * id, because their products are named exactly like food and outscore it.
 *
 * The worst is 656 "Daržovių sėklos": 584 SEED PACKETS named head-noun-first
 * ("Bulvės SOLTASTIC H", "Morkos Koral", "Kopūstai Polar", a bare "Bazilikai"),
 * so they beat the real produce ("Šviežios/Lietuviškos X") on BOTH raw score
 * and the lead tie-break — 46 confident wrong picks in one sweep, the 7th most
 * common category the matcher landed in. Around them sit pet food ("Sausas šunų
 * ėdalas … su vištiena"), cosmetics ("Kompaktinė pudra", "Vonios druska"),
 * kitchenware and books, which leak the same way.
 *
 * By category id, NOT by a name regex: a `sėkl` regex also kills "Skrudintos
 * sezamų sėklos SAITAKU" — real food, cat 260. The id ranges are the three
 * non-food department subtrees, verified against the dev category tree
 * (2026-07-26): 442–517 "Kosmetika ir higiena", 518–571 "Švaros ir gyvūnų
 * prekės", 572–658 + 689–695 "Namai ir laisvalaikis" (687 is a stray LEGO
 * category). Every food department's ids fall outside these ranges; 688
 * "Nepriskirta" never reaches us (searchProduct's CAT_GATE drops it).
 *
 * Accepted cost, measured before shipping: cukinijos/salierai/moliūgai lose
 * their ONLY reachable candidates (all were seed packets) and now return null —
 * the honest answer — and "Brokoliai BON VIA", real broccoli mis-filed into
 * 656, is lost rather than the rule weakened ("Mažieji brokoliai" covers it).
 */
const NON_FOOD_CATEGORY = (id: number): boolean =>
    // 688 'Nepriskirta' is CARVED OUT deliberately. It is not a department at
    // all — it is 18 000 uncategorised products, and most of the fresh produce a
    // recipe asks for lives there ("Valgomieji batatai", the whole fresh tomato
    // shelf, "Žaliosios cukinijos"). It used to be unreachable, so sweeping it
    // into the non-food range cost nothing; now that recipe search reaches the
    // uncategorised shelf on purpose, excluding it here would throw away exactly
    // what that change unlocked. The seed packets hiding in it are caught by
    // name instead (SEED_PACKET_NAME).
    id !== 688 && ((id >= 442 && id <= 658) || (id >= 687 && id <= 695));

export interface ProductPick {
    productId: number;
    /** Which shelf the product sits on — the only thing that separates a pot of
     *  living basil from a jar of dried basil, since the names are identical. */
    categoryId: number;
    /** Looks like a SEED PACKET rather than the vegetable — see
     *  `suspectSeedPacket`. A demotion, never an exclusion. */
    suspectSeed: boolean;
    /** Uncategorised AND with no recorded size — see `unlistedInUncategorised`.
     *  Loses every tie, and can never be a silent match. */
    unlisted: boolean;
    name: string;
    imageUrl: string | null;
    isWeighable: boolean;
    /** Package size of the representative product, when the catalog knows it —
     *  what lets "150 ml of milk" become "1 carton" instead of "0.15". */
    packAmount: number | null;
    packUnit: string | null;
    confidence: number;
    /**
     * How much THIS shopper wants this product, relative to the other candidates
     * for the same ingredient. Set once the candidates are known; 0 for an
     * anonymous import and for a shopper with no history.
     */
    affinity: number;
    /**
     * Everybody's decayed interaction score, carried straight off the search row
     * (`browseSelect` already selects it). Kept so affinity never has to ask the
     * database for something the caller was handed and threw away.
     */
    globalScore: number;
}

export interface MatchedIngredient {
    ingredient: ParsedIngredient;
    /** Knowledge-base key, null when the phrase is not in the table. */
    key: string | null;
    /** The Lithuanian name we searched the catalog with. */
    query: string | null;
    measure: Measure;
    /** "≈21 g", "150 ml", "2 vnt." — ready to render. */
    measureText: string | null;
    /** Probably already in the cupboard, so the shopper can strike it fast. */
    pantry: boolean;
    product: ProductPick | null;
    /** Runner-up products, so swapping is one tap instead of a new search. */
    alternatives: ProductPick[];
    /** Confident enough to add without asking. */
    confident: boolean;
    /** Why not, when `confident` is false — for the sweep, and for telling the
     *  shopper what we were unsure about. */
    reviewReason: 'low_score' | 'dropped_word' | 'generic_fallback' | 'generic_ingredient'
        | 'unit_conflict' | 'unlisted_product' | null;
    /** How much to actually buy, in the product's own unit. */
    shopQuantity: number;
    shopUnit: 'kg' | 'vnt';
}

/**
 * Resolve one parsed ingredient.
 *
 * `lang` is the RECIPE's language: it decides whether the raw phrase is usable
 * as a catalog query when the knowledge base has no entry. A Lithuanian phrase
 * still has a chance — the catalog is Lithuanian and `searchProduct` stems — but
 * an unknown English phrase has none, and guessing would put "curing salt" into
 * a basket as something else entirely.
 */
/** Catalog searches, memoised for the lifetime of ONE import: a recipe that says
 *  "druskos" three times must not pay for it three times. */
export type QueryCache = Map<string, ProductPick[]>;

export const matchIngredient = async (
    ing: ParsedIngredient,
    lang: Lang,
    locale: Locale = 'lt',
    cache: QueryCache = new Map(),
    userId: string | null = null,
    affinityCache?: AffinityCache,
): Promise<MatchedIngredient> => {
    // Look up the FULLER phrase first: "crushed tomatoes" is a different product
    // from "tomatoes", and the prep-stripped display name no longer says so.
    const hit = findIngredient(ing.nameFull || ing.name, lang) ?? findIngredient(ing.name, lang);
    let info: IngredientInfo | null = hit?.info ?? null;
    let measure = toMetric(ing, info);
    /**
     * A COUNTED PIECE VETOES A GROUND-SPICE READING.
     *
     * "1 vienetas paprika" resolved to the paprika_ground entry (which owns the
     * bare word for the sake of EN "1 tsp paprika") and silently bought "Malta
     * saldžioji paprika ALVO" — a ground-spice JAR — at 0.91. Nobody buys "one
     * unit" of a powder: a piece count on an entry with no piece weight means
     * the WHOLE thing was meant, and for paprika the whole thing is the
     * vegetable. Two judges flagged this independently in the same round.
     *
     * The redirect only fires when the recipe genuinely counted pieces
     * (`measure` came out as 'pcs', which cannot happen for tsp/tbsp/gram
     * lines — those convert through gramsPerMl), and only for entries listed
     * in PIECE_COUNT_REDIRECT, where a fresh twin verifiably exists. If the
     * twin ever disappears from the table the match is not redirected but it
     * is also never silent (`unit_conflict`).
     */
    let unitConflict = false;
    if (info && measure.unit === 'pcs' && (measure.qty ?? 0) > 0 && info.gramsPerPiece == null
        && PIECE_COUNT_REDIRECT.has(info.key)) {
        const whole = ingredientByKey(PIECE_COUNT_REDIRECT.get(info.key)!);
        if (whole) {
            info = whole;
            // Re-measure with the twin: bell pepper knows a piece weight, so
            // "1 vienetas" becomes ~150 g and shops as ~0.15 kg of peppers.
            measure = toMetric(ing, whole);
        } else {
            unitConflict = true;
        }
    }
    const query = info?.ltName ?? (lang === 'lt' ? ing.name : null);
    /**
     * A GENERIC HEAD NOUN IS A QUESTION, NEVER AN ANSWER.
     *
     * "Vaisiai pagal skonį" (fruit, to taste) silently bought "Margainių
     * vaisiai ŽOLYNĖLIS" — a dried herbal SUPPLEMENT powder. "šiek tiek
     * prieskoniai" dropped "Prieskoniai CURRY KOTANYI" into a cheese pasta,
     * "žalumynų" bought a dried Tuscan spice blend, "600 g mėsos" bought
     * French-marinated chicken kebabs, "uogos" bought dried barberries and
     * "sėklų" bought seeded bread CRISPS. Six silent errors, one shape: when
     * the recipe names only a CATEGORY, every product that scores well is a
     * specific thing the recipe never asked for, so no single product can be
     * right. The candidates are still offered — the shopper knows which fruit
     * they meant — but the basket is never filled in on a guess.
     */
    const genericAsk = namesOnlyACategory(ing.name);

    const base: MatchedIngredient = {
        ingredient: ing,
        key: info?.key ?? null,
        query,
        measure,
        measureText: formatMeasure(measure, lang),
        pantry: info?.pantry ?? false,
        product: null,
        alternatives: [],
        confident: false,
        reviewReason: null,
        shopQuantity: 1,
        shopUnit: 'vnt',
    };
    // Some ingredients are not shopping. Tap water is recognised and measured,
    // but every catalog search for it lands on a bottle or a bowl.
    if (ing.ignored || !query || info?.notSold) return base;

    /**
     * Search with the canonical name AND, for a Lithuanian recipe, the words the
     * recipe actually used.
     *
     * The knowledge base deliberately generalises: "šaldytų uogų" resolves to the
     * entry for berries, whose shopping name is "Uogos" — and searching that
     * alone found dried barberries while "Šaldytas uogų mišinys" sat in the
     * catalog untouched. The recipe's own phrase carries qualifiers the table
     * does not model, so it gets a vote too, and the better-scoring product wins.
     *
     * But ONLY when the phrase actually adds a word. Run unconditionally, this
     * arm queried the recipe's bare genitive ("sviesto", "druskos") — which is
     * exactly the form a catalog name uses when the noun MODIFIES a different
     * head — and its confidences were merged with the canonical arm's as if they
     * were on one scale. "sviesto" found "Sviesto skonio OBELIŲ rapsų aliejus"
     * (butter-flavoured OIL) and "druskos" found "Druskos dribsniai ICA" at 0.97,
     * an exact-token score that measures nothing about salt-ness, and both went
     * into baskets. 72% of the knowledge base's Lithuanian surface forms add no
     * content word over their own ltName, so for them the arm can contribute
     * nothing BUT genitive-modifier products. `firstAlternative` is load-bearing
     * here: "pieno arba vandens" must not re-open the arm through "arba/vandens".
     */
    // `ltName` first (it is the canonical name the ranking judges against),
    // then the lexicon's catalog-facing aliases, then the recipe's own wording.
    const queries = unique([
        query,
        ...(info?.aliases ?? []),
        recipeArm(ing.nameFull, query, lang),
        recipeArm(ing.name, query, lang),
    ]);
    let picks = await findProducts(queries, ing, info, locale, cache, userId, affinityCache);

    /**
     * Nothing at all — or nothing that IS the thing? Try the head noun on its own.
     *
     * Our shopping name and the shop's label often disagree on the qualifier:
     * the table says "Kepimo soda", every Lithuanian shop says "Maistinė soda",
     * and requiring both words found zero rows while the product sat there.
     * Dropping to "soda" finds it — but we just threw away the word that made the
     * name specific, so whatever comes back is offered for review, never
     * auto-accepted.
     *
     * Gating this on ZERO rows was a trap: "Vištienos šlaunelės" returned
     * exactly ONE row — a cooked deli kumpelis — so the fallback never ran and
     * the ham was auto-accepted at 0.90, while "Šlaunelės" had 24 rows of fresh
     * broiler thigh one query away (the fresh shelf says "broileris/viščiukas",
     * not "vištiena"). So a SINGLE survivor that does not carry the query as
     * its own head noun triggers the fallback too, and the survivor stays in
     * the pool — the shopper sees both, and `generic_fallback` keeps it all
     * out of the basket without a question.
     */
    /**
     * A THIRD trigger, and the one the corpus caught: candidates exist and are
     * plentiful, but not one of them passes acceptance because our shopping name
     * carries a qualifier the shelf does not print. "Džiovinti raudonėliai" found
     * "Raudonėliai SALDVA" at 0.97 — dried oregano in a jar, exactly right — and
     * rejected it for lacking the word "džiovinti", which no spice jar prints.
     * Same for "Džiovinti čiobreliai" and "Šviežias imbieras" → "Imbieras" (1.00).
     * Dropping to the head noun recovers the product; `generic_fallback` still
     * sends it to review, so the qualifier we dropped is never dropped silently.
     */
    const nonePassed = picks.length > 0
        && !picks.some(p => p.confidence >= SOFT_ACCEPT && queryFullyPresent(query, p.name));

    let fellBack = false;
    /**
     * What acceptance is judged against. After a fallback it is the HEAD NOUN,
     * not the original name: we deliberately dropped the qualifier to find the
     * product, so re-imposing it would reject the very row the fallback went
     * looking for ("Raudonėliai SALDVA" has no "džiovinti" and never will).
     * The dropped word is not forgiven, only deferred — `generic_fallback`
     * still routes the match to review.
     */
    let acceptQuery = query;
    if (picks.length === 0 || nonePassed
        || (picks.length === 1 && !carriesQueryAsHead(query, picks[0].name))) {
        const head = headNoun(query);
        // Never generalise onto a form noun — that is not a wider search, it is
        // a different product with the same packaging word.
        if (head && !GENERIC_FORM_NOUN.test(fold(head))) {
            const wider = await findProducts([head], ing, info, locale, cache, userId, affinityCache);
            if (wider.length > 0) {
                const merged = new Map<number, ProductPick>(picks.map(p => [p.productId, p]));
                for (const p of wider) {
                    const prev = merged.get(p.productId);
                    if (!prev || p.confidence > prev.confidence) merged.set(p.productId, p);
                }
                picks = rankPicks([...merged.values()], query, ing.nameFull || ing.name, info).slice(0, 4);
                fellBack = true;
                acceptQuery = head;
            }
        }
    }
    if (picks.length === 0) return base;

    /**
     * The best pick that actually PASSES the identity bar — not simply the first
     * one in the list.
     *
     * Ranking runs before this, so anything that reorders the list (the shopper's
     * own history, most of all) could push a candidate into slot 0 that fails
     * `queryFullyPresent` — and judging only slot 0 then returned NOTHING for the
     * whole ingredient while a 1.00 exact match sat at index 1. Acceptance is a
     * property of a candidate, so it is asked of each in turn; the order still
     * decides WHICH acceptable one wins.
     */
    const acceptable = (p: ProductPick) =>
        p.confidence >= SOFT_ACCEPT && queryFullyPresent(acceptQuery, p.name);
    const chosenIndex = picks.findIndex(acceptable);
    const best = chosenIndex >= 0 ? picks[chosenIndex] : picks[0];
    const rest = picks.filter((_, i) => i !== (chosenIndex >= 0 ? chosenIndex : 0));
    /**
     * Auto-accept needs BOTH a decent score and the whole query present in the
     * product's name. Score alone was not enough: "black beans" scored 0.91
     * against "Konservuotos raudonosios pupelės" — red beans — because the shared
     * matcher saw one strong shared noun and no reason to doubt. Requiring the
     * qualifier to survive turns that into a question for the shopper instead of a
     * silent substitution, and costs nothing on the branded matches that the soft
     * bar exists for.
     *
     * And when the bar is NOT cleared, no pick is returned at all. Returning
     * the best guess anyway made "Kakavos milteliai" the universal answer for
     * any "X milteliai" (onion powder, chilli powder) and "Prieskoniai CURRY"
     * for any unknown spice — a wrong product pre-filled into a basket, wearing
     * a warning most shoppers tap through. The candidates go into
     * `alternatives`, which the review screen already renders as a choice.
     */
    if (chosenIndex < 0) {
        return { ...base, alternatives: picks.slice(0, 3), reviewReason: 'low_score' };
    }

    const shop = shoppingAmount(measure, best, info);
    const dropped = droppedWord(ing, hit, query, best.name, lang);
    const reason: MatchedIngredient['reviewReason'] =
        // A category-only ingredient outranks every other reason: whatever
        // won, it is a specific product for an unspecific request.
        genericAsk ? 'generic_ingredient'
        : unitConflict ? 'unit_conflict'
        : fellBack ? 'generic_fallback'
        : dropped ? 'dropped_word'
        // Uncategorised with no size the catalog knows of. It won because
        // nothing better existed, and that is precisely when to ask.
        : best.unlisted ? 'unlisted_product'
        : null;
    return {
        ...base,
        product: best,
        alternatives: rest.slice(0, 3),
        confident: reason == null,
        reviewReason: reason,
        shopQuantity: shop.quantity,
        shopUnit: shop.unit,
    };
};

/**
 * Does every meaning-bearing word of the query appear in what the product IS?
 *
 * "What it is" stops at "su" (with). Lithuanian labels use that word to list what
 * a product CONTAINS, and matching inside that list is how three wrong products
 * became confident matches:
 *
 *   soy sauce     → "Majonezinis padažas SU sezamais ir sojomis"  (a mayo sauce)
 *   cukraus pudra → "Varškės spurga SU cukraus pudra"             (a doughnut)
 *   druska        → "Sviestas SU jūros druska"                    (butter)
 *
 * Each contains the ingredient. None of them IS the ingredient. So only the head
 * of the name counts — everything from "su" onward describes the filling.
 */
const CONTAINS_MARKER = /\b(su|with)\b/i;

const queryFullyPresent = (query: string, productName: string): boolean => {
    const words = contentWords(query);
    if (words.length === 0) return false;
    const head = productName.split(CONTAINS_MARKER)[0];
    const inName = contentWords(head);
    return words.every(w => isCovered(w, inName));
};

/**
 * Nouns that name a FORM, not a food: any powder is "milteliai", any sauce is
 * "padažas". Dropping the qualifier in front of one of these does not generalise
 * the search, it destroys the identity — "Svogūnų milteliai" falling back to
 * "milteliai" is how onion powder became COCOA powder, and "Sojos padažas"
 * falling back to "padažas" is how soy sauce became a mayonnaise dip.
 *
 * A real ingredient noun ("raudonėliai", "šlaunelės", "soda") is safe to fall
 * back to: it still names the thing, and only a preparation word was lost.
 */
const GENERIC_FORM_NOUN = new RegExp(
    '^(miltelia|milteli|padaž|padaz|sultys|sulči|sulci|mišin|misin|prieskon'
    + '|dribsni|tyrel|tyrė|kremas|sirup|ekstrakt|pasta|užpil|uzpil|koncentrat)', 'i');

/**
 * Stamp each candidate with the shopper's affinity for it.
 *
 * Ordering happens LATER and only among candidates that already passed every
 * identity gate — affinity decides between products that are all genuinely the
 * ingredient, never whether something IS the ingredient. A shopper who buys
 * ROKIŠKIO butter every week should get ROKIŠKIO butter; they should not get a
 * butter-flavoured oil because they once bought one.
 */
const withAffinity = async (
    picks: ProductPick[], userId: string | null, cache?: AffinityCache,
): Promise<ProductPick[]> => {
    if (!userId || picks.length === 0) return picks;
    // The global half rides along on the search row, so the only thing left to
    // ask the database for is this shopper's own history — and even that is
    // asked once per import, not once per ingredient.
    const globals = new Map(picks.map(p => [p.productId, p.globalScore]));
    const facts = await getProductAffinity(userId, picks.map(p => p.productId), globals, cache);
    // Ranked against EACH OTHER, never on an absolute scale: `global` is the sum
    // of every user's `personal`, so the two are not comparable per product and
    // blending them there can only ever penalise a preference.
    const ranked = rankAffinity([...facts.values()]);
    return picks.map(p => ({ ...p, affinity: ranked.get(p.productId) ?? 0 }));
};

/** The noun a Lithuanian shopping name is built around — its last word. */
const headNoun = (query: string): string | null => {
    const words = query.trim().split(/\s+/);
    return words.length >= 2 ? words[words.length - 1] : null;
};

/**
 * Is this product the query, possibly wearing a brand suffix — or something
 * else that merely mentions it? "Citrinų sultys LIMMI" carries "Citrinų
 * sultys" as its own head and is the thing; "Virtas vištienos šlaunelių mėsos
 * kumpelis" contains every query word yet OPENS with a different noun — it is
 * a kumpelis made OF the query. The distinction decides whether a lone search
 * survivor can be trusted or the head-noun fallback should widen the net.
 */
const carriesQueryAsHead = (query: string, name: string): boolean => {
    const lead = contentWords(name)[0];
    return queryFullyPresent(query, name) && lead != null && isCovered(lead, contentWords(query));
};

/**
 * Did we quietly drop a word that changes what the thing IS?
 *
 * The knowledge base generalises on purpose — "juodųjų serbentų lapų"
 * (blackcurrant LEAVES) resolves to the blackcurrant entry, whose shopping name
 * is "Juodieji serbentai". Searching that matched "Degtinė BAJORŲ IR JUODIEJI
 * SERBENTAI" — blackcurrant vodka — at 0.94, which is above the auto-accept bar.
 * The confidence was honest about the NAMES and blind to the fact that the word
 * carrying the meaning never took part.
 *
 * So: if the recipe used a content word that appears in neither the query nor
 * the chosen product, we may still offer the product — but never silently.
 */
const droppedWord = (
    ing: ParsedIngredient,
    hit: IngredientHit | null,
    query: string,
    productName: string,
    lang: Lang,
): string | null => {
    if (lang !== 'lt') {
        /**
         * For an English recipe the query and the product are Lithuanian by
         * construction, so NO English word could ever appear in them — the LT
         * check below, applied blindly, flagged every ingredient of every
         * English recipe. But returning null instead disabled the guard
         * ENTIRELY for English (a 1295-row sweep had zero `dropped_word`), and
         * that silence is what turned "red pepper" into black pepper, "sweet
         * potatoes" into potatoes and "self-raising flour" into plain flour.
         *
         * The honest reference is the knowledge-base window that recognised the
         * phrase: any phrase word OUTSIDE it was never accounted for by anyone.
         * Only identity-changing words count as dropped — flagging every extra
         * word put correct matches ("extra-virgin olive oil", prep participles)
         * into review while teaching the shopper to tap through warnings.
         */
        if (!hit) return null;
        const covered = new Set(hit.form.split(' '));
        return fold(firstAlternative(ing.nameFull || ing.name)).split(' ')
            .find(w => EN_IDENTITY_QUALIFIERS.has(w) && !covered.has(w)) ?? null;
    }
    const covered = [...contentWords(query), ...contentWords(productName)];
    return contentWords(firstAlternative(ing.nameFull || ing.name))
        .find(w => !isCovered(w, covered)) ?? null;
};

/**
 * English words that change WHAT the ingredient is, not how it is prepared.
 * Dropping one of these silently is a substitution ("red" pepper → black,
 * "sweet" potatoes → potatoes, "distilled" vinegar → apple cider); dropping a
 * prep participle ("chopped", "melted") or a marketing grade ("extra-virgin",
 * measured correct in all 10 sweep rows) is not, so those are deliberately
 * absent — the wider "any uncovered word" rule flagged 27% of confident rows,
 * this list flags the 5.7% that are real identity questions.
 */
const EN_IDENTITY_QUALIFIERS = new Set([
    // colour / variety
    'red', 'white', 'green', 'black', 'yellow', 'brown', 'purple', 'golden', 'dark',
    'wild', 'baby', 'cherry', 'plum', 'roma', 'sweet', 'sour', 'new',
    // grain / dairy
    'basmati', 'jasmine', 'arborio', 'risotto', 'wholemeal', 'wholewheat', 'wholegrain',
    'self-raising', 'gluten-free', 'semi-skimmed', 'skimmed', 'full-fat', 'low-fat',
    'double', 'single', 'heavy', 'condensed', 'evaporated', 'desiccated',
    // acid / vinegar
    'distilled', 'balsamic', 'cider', 'sherry', 'malt',
    // processing that changes the product on the shelf
    'smoked', 'dried', 'cured', 'pickled', 'canned', 'tinned', 'frozen', 'roasted',
    'salted', 'unsalted', 'toasted', 'ground', 'whole', 'flaked', 'boneless',
    'skinless', 'kosher', 'coarse', 'instant', 'seasoned',
]);

/**
 * Recipes offer choices — "pieno arba vandens", "medaus arba cukraus", "klevų
 * sirupo ar skysto medaus". Only the FIRST option has to be accounted for: the
 * others are permission, not a requirement, and counting them as words we
 * dropped sent correct matches ("pieno arba vandens" → "UAT pienas MŪ") to
 * review for failing to also be water.
 */
const ALTERNATIVE_MARKER = /\s(?:arba|ar|or)\s/i;
const firstAlternative = (name: string): string => name.split(ALTERNATIVE_MARKER)[0];

/**
 * The recipe's own phrase earns a query arm only by ADDING a content word over
 * the canonical name ("šaldytų uogų" adds "šaldyt" over "Uogos" — the arm is
 * what finds the frozen mix, and deleting it outright broke that case). A
 * phrase that is just the canonical noun in another case ("sviesto" vs
 * "Sviestas") can only find products where the noun modifies something else.
 */
const recipeArm = (phrase: string | null | undefined, canonical: string, lang: Lang): string | null => {
    if (lang !== 'lt' || !phrase) return null;
    const covered = contentWords(canonical);
    return contentWords(firstAlternative(phrase)).some(w => !isCovered(w, covered)) ? phrase : null;
};

/**
 * One edit of slack, because the stemmer is blunt on purpose. "sulčių" stems to
 * `sulc` and "sultys" to `sult` — the same word to any reader, a mismatch to a
 * set lookup, and it flagged the perfectly correct "citrinos sulčių → Citrinų
 * sultys LIMMI" for review. One substitution is the difference between two case
 * endings; two is a different word.
 */
const isCovered = (word: string, covered: string[]): boolean =>
    covered.some(c => c === word
        // One stem is a truncation of the other — the stemmer stopped at a
        // different ending ("meda" vs "med" for medus/medaus).
        || (Math.min(word.length, c.length) >= 3
            && (word.startsWith(c) || c.startsWith(word)))
        // Or they differ by a single letter, which is one case ending
        // ("sulc" vs "sult" for sulčių/sultys).
        || (word.length >= 4 && c.length >= 4 && levenshtein(word, c) <= 1));

const findProducts = async (
    queries: string[],
    ing: ParsedIngredient,
    info: IngredientInfo | null,
    locale: Locale,
    cache: QueryCache,
    userId: string | null = null,
    affinityCache?: AffinityCache,
): Promise<ProductPick[]> => {
    const best = new Map<number, ProductPick>();
    for (const q of queries) {
        const key = `${q.toLowerCase()}|${locale}`;
        let picks = cache.get(key);
        if (!picks) {
            picks = await findProductsFor(q, ing, info, locale);
            cache.set(key, picks);
        }
        for (const pick of picks) {
            const prev = best.get(pick.productId);
            if (!prev || pick.confidence > prev.confidence) best.set(pick.productId, pick);
        }
        /**
         * Each extra query is another five ranked SQL arms, so stop as soon as
         * the answer is in hand — but only for an answer we would actually KEEP.
         *
         * Testing raw confidence alone stopped the search on products the
         * ranking was about to throw away: "Plovas su kalakutiena" (a pilaf)
         * scores 0.97 for "Kalakutiena", which ended the loop before the alias
         * that finds actual turkey ever ran. A leader that carries a demotion
         * marker is not a reason to stop looking.
         */
        const leader = [...best.values()]
            .filter(p => !PREPARED_MARKER.test(p.name) && !/ (?:su|with|ir|and) /i.test(` ${p.name} `))
            .sort((a, b) => b.confidence - a.confidence)[0];
        if (leader && leader.confidence >= AUTO_ACCEPT) break;
    }
    // Affinity is stamped BEFORE ranking, because ranking is what reads it.
    // Stamping afterwards (the first cut) left the order already decided and the
    // shopper's history with no effect at all.
    const stamped = await withAffinity([...best.values()], userId, affinityCache);
    // Rank against the FIRST query — the canonical shopping name, which is the
    // one the head-noun preference is meaningful for.
    return rankPicks(stamped, queries[0], ing.nameFull || ing.name, info).slice(0, 4);
};

/**
 * Order the candidates, breaking near-ties in favour of the product that LEADS
 * with what we asked for.
 *
 * "Cukrus" matched "Vanilinis cukrus" at 0.97 — vanilla sugar, a different
 * product — while "Cukrus EXTRA LINE" trailed at 0.78. Both contain the word, so
 * name similarity alone cannot separate them. Lithuanian product naming can:
 * the head noun comes FIRST and brand and pack detail follow it ("Grietinė
 * DVARO, 30 %", "Alyvuogių aliejus BASSO"), whereas a different VARIANT puts its
 * qualifier in front ("Vanilinis cukrus", "Rudasis cukrus", "Cinamoninis
 * cukrus"). So within a narrow confidence band, a name that begins with the
 * query beats one that merely contains it.
 *
 * Confidence still rules outside the band, and inside it a leading match never
 * loses to a lower score — an exact 1.00 stays first.
 */
const TIE_BAND = 0.06;
/**
 * The band is much wider for a BARE NOUN query ("Cukrus", "Druska", "Grietinė").
 *
 * Those are the generic staples, and they are exactly where the variant trap
 * lives: sugar has vanilla, cinnamon and brown siblings whose names are SHORTER
 * than a branded plain sugar, so the shared matcher's length weighting ranks the
 * wrong product first — "Vanilinis cukrus" 0.97 over "Cukrus EXTRA LINE" 0.78.
 * When the query is one word, leading with that word is worth more than the
 * points a brand name costs. For a multi-word query the qualifier already did
 * this work, so the band stays tight.
 *
 * 0.20 is the width that trap actually needs: 0.19 is the measured cost of a
 * brand + pack suffix (exact variant 0.97 vs branded plain 0.78), and that is
 * the ONLY gap this band exists to bridge. The original 0.25 also let a 0.75
 * near-miss beat a 0.97 exact hit, which is not a tie by any honest reading —
 * a lower score should never win by that margin.
 */
const LEAD_BAND = 0.20;

/**
 * @param query  the canonical shopping name we searched with
 * @param phrase the RECIPE's own words — they carry the preparation the shopper
 *               asked for ("rūkytos šoninės"), which the canonical name drops
 *               ("Šoninė"). Judging preparation on the query alone demoted the
 *               smoked bacon a recipe explicitly wanted.
 */
/** Content words in the product name that the query never asked for. */
const extraWords = (p: ProductPick, query: string): number => {
    const asked = new Set(contentWords(query));
    return contentWords(p.name).filter(w => !asked.has(w)).length;
};

const rankPicks = (
    picks: ProductPick[], query: string, phrase = '', info: IngredientInfo | null = null,
): ProductPick[] => {
    const bareNoun = normalise(query).split(' ').length === 1;
    const band = bareNoun ? LEAD_BAND : TIE_BAND;
    // Did the RECIPE ask for a preparation? If not, a product advertising one is
    // a different thing — and it beats the raw ingredient on the lead rule
    // whenever the preparation word comes SECOND: "Morkos korėjietiškai" (a
    // carrot salad) leads with "morkos" while the real "Plautos morkos" does not.
    const wanted = PREPARED_MARKER.exec(query)?.[0] ?? PREPARED_MARKER.exec(phrase)?.[0] ?? null;
    const queryPrepared = wanted != null;
    /**
     * 0 = fine, 1 = carries a preparation nobody asked for.
     *
     * When the recipe DID name a preparation, a product carrying a DIFFERENT one
     * is just as wrong as an unwanted one: "Čiobreliai vazonėlyje" is a living
     * potted plant, and a recipe asking for dried thyme wants the jar. Matching
     * on the marker's stem rather than the exact word keeps this working across
     * the case endings ("džiovint|as|i|ų").
     */
    const prepared = (p: ProductPick) => {
        const found = PREPARED_MARKER.exec(p.name)?.[0];
        if (!found) return 0;
        if (!queryPrepared) return 1;
        /**
         * Same preparation when one folded form is a PREFIX of the other,
         * compared over at most 5 letters. A fixed slice(0, 6) equality broke
         * both directions the abbreviations need: "Dž." folds to "dz" and
         * could never equal "dziovi", so a recipe asking for "džiovintų
         * spanguolių" saw the very product it wanted demoted as a stranger —
         * and "rūkyta" vs "rūkytos" differed at the 6th letter, so even two
         * case endings of ONE word read as different preparations. Five is
         * still enough to keep every marker pair apart ("marin"/"malt",
         * "raugi"/"rukyt", "sudyt"/"surym" all diverge by then).
         */
        const a = fold(found);
        const b = fold(wanted!);
        const n = Math.min(a.length, b.length, 5);
        return n > 0 && a.slice(0, n) === b.slice(0, n) ? 0 : 1;
    };
    /**
     * "Leads with the query" requires the SAME SURFACE FORM, not the same stem.
     * The stemmed comparison read "Druskos dribsniai" and "Sviesto skonio …
     * aliejus" as leading with druska/sviestas — but a Lithuanian name that
     * OPENS with the genitive of our noun is naming a product OF the noun, not
     * the noun ("Druskos dribsniai" are flakes, the oil is butter-FLAVOURED),
     * and the lead bonus handed both of them the win. A product that IS the
     * thing opens with the same case the canonical name uses: "Cukrus EXTRA
     * LINE", "Kopūstai Polar", "Citrinų sultys LIMMI" all still lead.
     *
     * Short tokens are skipped before comparing (same floor as `contentWords`,
     * WITHOUT its stemming): "UAT pienas MŪ" opens with a process abbreviation,
     * not a noun, and reading "UAT" as its head handed the bare-noun band to
     * "Pienas be laktozės A2" — lactose-free milk beating plain milk.
     */
    const lead0 = (s: string): string => {
        const tokens = fold(s).split(' ');
        return tokens.find(t => t.length >= 4) ?? tokens[0] ?? '';
    };
    /**
     * "Y SU X" is Y WITH something — a different product from plain Y.
     *
     * "Grikiai su mėsa" is a tin of buckwheat-and-meat ready meal and it was
     * silently bought for 200 g of plain groats, beating "Grikiai WELL DONE" at
     * the identical score. "Krevetės džiūvėsėliuose su padažu" is a breaded
     * snack with a dipping sauce, bought for raw prawns. Both lead with the
     * right noun, which is exactly why they won.
     *
     * "ir"/"and" is the same shape one conjunction over: "Liet. smulk. kiauliena
     * IR jautiena" is a pork-and-beef blend, and a recipe asking for 200 g of
     * beef should get beef, not half of it. Pure "Šviežia smulkinta jautiena"
     * scores identically and is what the shopper meant.
     *
     * Only when the RECIPE did not ask for the accompaniment: "varškė su
     * grietine" in a recipe line still finds the product that says so.
     */
    const JOINED = / (?:su|with|ir|and) /i;
    const querySu = JOINED.test(` ${query} `) || JOINED.test(` ${phrase} `);
    const accompanied = (p: ProductPick) => (!querySu && JOINED.test(` ${p.name} `) ? 1 : 0);

    /** 1 = on the wrong shelf for the form the recipe asked for. */
    const wantsFresh = FRESH_WORD.test(phrase) || (info != null && FRESH_KEYS.has(info.key));
    const wantsDried = !wantsFresh && (DRIED_WORD.test(query) || DRIED_WORD.test(phrase));
    /**
     * Only demote the processed aisle when the fresh one actually has something
     * to offer. A catalog that stocks only the tinned form should still return
     * it — the rule is "prefer fresh", not "refuse processed".
     *
     * Tracked PER AXIS: a fresh MEAT candidate says nothing about tomatoes.
     * The produce axis was missing entirely — the old single flag only ever
     * looked at FRESH_MEAT_FISH, so the marinated/dried shelves never lost a
     * produce query no matter how much fresh produce stood in the pool
     * (dried barberries beat fresh blueberries, a vinegar jar beat four fresh
     * cherry-tomato listings).
     */
    const freshMeatOnOffer = picks.some(p => FRESH_MEAT_FISH.has(p.categoryId));
    const freshProduceOnOffer = picks.some(p => FRESH_PRODUCE_CATEGORY(p.categoryId));
    const wrongShelf = (p: ProductPick) => {
        if (wantsFresh && DRIED_SPICE_SHELF.has(p.categoryId)) return 1;
        if (wantsDried && p.categoryId === FRESH_HERB_CATEGORY) return 1;
        // The recipe naming a preparation ("smoked", "rūkytos") is what makes
        // the processed aisle the right one, so leave those alone.
        if (!queryPrepared && freshMeatOnOffer && PROCESSED_CATEGORY(p.categoryId)) return 1;
        // `!wantsDried` on top of `!queryPrepared`, because PREPARED_MARKER is
        // Lithuanian-only: inside the head-noun fallback the query is a bare
        // "bazilikai" and the only trace of an EN recipe's "dried" is the
        // phrase — which DRIED_WORD reads in both languages. Without this
        // gate, "1 tsp dried basil" demoted the dried-spice shelf it was
        // asking for and handed the win to an uncategorised pot of fresh basil.
        if (!queryPrepared && !wantsDried && freshProduceOnOffer
            && PROCESSED_PRODUCE_CATEGORY(p.categoryId)) return 1;
        return 0;
    };

    const qLead = lead0(query);
    const leads = (p: ProductPick) => (lead0(p.name) === qLead ? 0 : 1);
    /**
     * THE DEMOTIONS HAVE TO BE PART OF THE SCORE, not a tie-break after it.
     *
     * They used to sit BELOW a raw-confidence short-circuit, which made this
     * comparator non-transitive and quietly disabled them whenever the wrong
     * product simply scored higher: tinned "Troškinta jautiena" at 0.97 beat
     * fresh "Šviežia smulkinta jautiena" at 0.75 on the 0.20 band before
     * anything asked whether one of them was a tin. Every rule below — prepared,
     * wrong shelf, "su X", seed packet, unlisted, multipack — was reachable only
     * for candidates that already scored within a hair of each other.
     *
     * Subtracting them from the score fixes both problems at once: the order is
     * a single scalar (transitive, so `sort` cannot produce input-dependent
     * results), and a demotion now outweighs the score gap it was meant to
     * overrule. When EVERY candidate is penalised — a catalog that only stocks
     * the tinned form — they all move together and the best of them still wins,
     * which is the behaviour a demotion should have.
     */
    const adjusted = (p: ProductPick): number =>
        p.confidence
        - PENALTY.prepared * prepared(p)
        - PENALTY.accompanied * accompanied(p)
        - PENALTY.wrongShelf * wrongShelf(p)
        - PENALTY.unlisted * Number(p.unlisted)
        - PENALTY.seed * Number(p.suspectSeed)
        - PENALTY.multipack * Number(MULTIPACK.test(p.name));

    return [...picks].sort((a, b) => {
        const adj = adjusted(a) - adjusted(b);
        if (Math.abs(adj) > band) return -adj;
        // Within a band of each other on the adjusted score, the same order of
        // preference as before decides — starting with what the shopper buys.
        /**
         * A MULTIPACK is the right product in the wrong shape. Two pinches of
         * brown sugar were silently answered with "Rudasis cukrus RIMI,
         * 50 X 3 g" — a box of fifty coffee-stall sachets — while the ordinary
         * bag sat beside it at the same score. Nobody bakes from sachets.
         */
        const multi = Number(MULTIPACK.test(a.name)) - Number(MULTIPACK.test(b.name));
        if (multi !== 0) return multi;
        /**
         * THE SHOPPER'S OWN HISTORY, ahead of every name heuristic that remains.
         *
         * By this point both candidates have cleared the identity gates, so the
         * question is no longer "which is the ingredient" but "which one does
         * this person buy" — and for that, what they actually bought beats any
         * spelling similarity. It is also why price plays no part here: the
         * basket calculator decides where the chosen product is cheapest, later
         * and per store. Affinity picks WHAT, price picks WHERE.
         */
        if (a.affinity !== b.affinity) return b.affinity - a.affinity;
        /**
         * The same structural signals again, now as ORDERING rather than
         * arithmetic. They have to appear in both places: as a penalty they
         * overrule a score gap wider than the band, and as a tie-break they
         * decide inside it. Leaving them only in the penalty let a dried basil
         * jar beat a living basil plant — 0.25 of shelf penalty is invisible
         * when the two names already score 0.19 apart, and the comparison then
         * fell through to counting words, where the shorter brand won.
         */
        const prep = prepared(a) - prepared(b);
        if (prep !== 0) return prep;
        const shelf = wrongShelf(a) - wrongShelf(b);
        if (shelf !== 0) return shelf;
        const joined = accompanied(a) - accompanied(b);
        if (joined !== 0) return joined;
        const listed = Number(a.unlisted) - Number(b.unlisted);
        if (listed !== 0) return listed;
        const seed = Number(a.suspectSeed) - Number(b.suspectSeed);
        if (seed !== 0) return seed;
        const packs = Number(MULTIPACK.test(a.name)) - Number(MULTIPACK.test(b.name));
        if (packs !== 0) return packs;
        const lead = leads(a) - leads(b);
        if (lead !== 0) return lead;
        /**
         * PLAINEST NAME LAST, because a tie here used to be settled by row order.
         *
         * Four holdout misses shared one shape: the right product and a
         * more-elaborate one scored IDENTICALLY, and the elaborate one happened
         * to come first — a frozen vegetable MIX lost to breaded vegetable
         * PATTIES, plain salmon to salmon in oil. Worse, plain salt and
         * "Česnakinė druska" (garlic salt) tied at exactly 0.78 on an ingredient
         * appearing five times, one coin-flip from silently seasoning a recipe
         * with garlic.
         *
         * Every extra content word is something the recipe did not ask for, so
         * the candidate carrying fewest of them is the closest thing to the bare
         * ingredient. It ranks BELOW affinity deliberately: if the shopper
         * actually buys the elaborate one, that is not a tie any more.
         */
        const extra = extraWords(a, query) - extraWords(b, query);
        if (extra !== 0) return extra;
        return adjusted(b) - adjusted(a);
    });
};

/**
 * THE PRICE OF UNLOCKING 'Nepriskirta', and how it is paid.
 *
 * Category 688 is not a department, it is 18 000 unsorted products, and recipe
 * search has to reach it because most fresh produce lives there. What ALSO
 * lives there: 1 817 books, toys, shampoos and hair dyes. A recipe asking for
 * fish stock was silently sold "Knyga ŽUVIS VANDENYJE" — a BOOK — with a pet
 * toy as the runner-up, and a butternut squash was sold a packet of pumpkin
 * SEEDS for planting.
 *
 * What separates them is not the name, it is whether the catalog knows how the
 * thing is SOLD. Every real grocery listing in 688 carries a unit — kilograms
 * for loose produce, vnt for a piece, grams or millilitres for a package. The
 * book has none, the seed packets have none, and 6 412 rows of 688 have none.
 *
 * DEMOTED AND NEVER SILENT, not excluded. Excluding was tried first and cost
 * real food: "Rabarbarai" is a genuine product whose size the catalog simply
 * never recorded, and dropping it turned a correct match into no match at all.
 * So an unlisted row always loses to a properly listed one — which is enough to
 * fix every case that matters, since the seed packets sit beside real produce
 * ("Žaliosios cukinijos BON VIA" now wins) and the book sits beside real fish —
 * and when it is genuinely all there is, it is offered for review rather than
 * added silently. Nothing this weak should ever reach a basket unannounced.
 */
const unlistedInUncategorised = (r: any): boolean =>
    Number(r.categoryId ?? 0) === 688 && Number(r.hasListing ?? 0) === 0;

/**
 * A seed packet wearing a vegetable's name, in the one category that cannot be
 * excluded wholesale.
 *
 * Seed packets are named EXACTLY like the plant — "Cukinijos GENOVESE",
 * "Bulvės SOLTASTIC H" — so only the category normally tells them apart, and
 * category 656 'Daržovių sėklos' does. But the holdout found the same packets
 * filed under 688 'Nepriskirta' too (32637, 32667), where they are
 * indistinguishable by id and were silently bought as courgettes.
 *
 * What gives them away is that the SAME PACKET is usually also listed properly:
 * "Cukinijos GENOVESE" in 688 is the name of "Cukinijos GENOVESE, AGRONOM" in
 * 656, minus the brand. So a 688 name that opens a real seed listing is a seed
 * listing, wherever it was filed.
 *
 * TWO conditions, and the second is what makes it safe. Matching on the head
 * noun alone would flag "Cukinija", "Pomidorai", "Krapai" and "Melionai" — the
 * plain vegetables themselves — because a packet is called "Cukinija Black
 * Beauty". Requiring a SECOND word means the name must carry the cultivar, and
 * that took the match count over the whole uncategorised shelf from 8 rows to
 * 4, all four of them genuine packets.
 *
 * Tried and rejected: "no weight and no package size", which is true of seed
 * packets but equally true of most real produce in 688, so it flagged every
 * courgette; and cultivar-token matching, which subtracts any token that also
 * appears on food and so lost "GENOVESE" to pesto.
 *
 * A demotion, never an exclusion — when a packet really is the closest thing
 * the catalog has, it is still offered.
 */
let SEED_NAMES: Set<string> | null = null;

const loadSeedNames = async (): Promise<Set<string>> => {
    if (SEED_NAMES) return SEED_NAMES;
    try {
        const [rows]: any = await pool.query(
            `SELECT name FROM Product WHERE categoryId = ?`, [SEED_CATEGORY_ID]);
        SEED_NAMES = new Set((rows as any[])
            .map(r => normalise(String(r.name ?? '')))
            .filter(n => n.length >= 6));
    } catch {
        // A catalog read failing must not fail the import; without the set the
        // check simply never fires, which is where this started.
        SEED_NAMES = new Set();
    }
    return SEED_NAMES;
};

const SEED_CATEGORY_ID = 656;

const suspectSeedPacket = (c: MatchCandidate | undefined, seedNames: Set<string>): boolean => {
    if (c == null || c.categoryId !== 688) return false;
    const name = normalise(c.storeProductName);
    // The head noun alone is the vegetable, not a variety of it.
    if (name.length < 6 || name.split(' ').length < 2) return false;
    for (const seed of seedNames) if (seed === name || seed.startsWith(`${name} `)) return true;
    return false;
};

/**
 * FRESH HERBS ARE NOT DRIED HERBS, and their names are the same word.
 *
 * "Bazilikai WELL DONE" is a living plant, "Bazilikai SALDVA" is a jar of dried
 * leaves, and nothing in either NAME says which — so a salad calling for 1/3 cup
 * of chopped fresh basil was silently given the spice jar at 0.97 confidence.
 * The catalog does know: category 9 is 'Prieskoninės daržovės ir žolelės' (the
 * fresh shelf) and 245 is 'Grynieji prieskoniai ir žolelės' (the dried one).
 *
 * What the recipe wants is read from the lexicon rather than guessed: an entry
 * that HAS a `_dried` sibling is by construction the fresh one, so `thyme` wants
 * fresh and `thyme_dried` wants dried, without either having to say so.
 */
const FRESH_HERB_CATEGORY = 9;
const DRIED_SPICE_CATEGORY = 245;

/**
 * THE SAME IDEA ONE AISLE OVER: fresh meat and fish versus what has been done
 * to them. The catalog separates these cleanly and the matcher was ignoring it,
 * which turned out to be one cause behind three of the worst misses in a single
 * holdout round — bacon lardons became raw pork belly in Caucasian BBQ
 * marinade, and salmon fillets became a TIN of salmon in oil, twice, with the
 * entire fresh-fish aisle never visited.
 *
 * Processed names are short and score well ("Lašiša aliejuje" against
 * "Lašiša"), while the fresh product carries a long descriptive name — so the
 * processed aisle wins on spelling every time unless something says otherwise.
 *
 * 127 'Šoninė ir lašiniai' counts as FRESH-side deliberately: cured is what
 * bacon IS, and that aisle is where a recipe asking for bacon should land.
 */
const FRESH_MEAT_FISH = new Set([97, 98, 99, 100, 101, 102, 103, 106, 108, 109, 127]);

const PROCESSED_CATEGORY = (id: number): boolean =>
    (id >= 104 && id <= 105)      // marinated pork/poultry
    || (id >= 110 && id <= 126)   // salmon/herring goods, tins, smoked, cured, snacks
    || (id >= 128 && id <= 144)   // ready meals, salads, sausages, pâté, meat tins
    || (id >= 146 && id <= 150);  // canned food

/**
 * THE SAME AXIS AGAIN, FOR PRODUCE AND BERRIES — because it only existed for
 * meat and fish, and the holdout paid for the gap four times over: fresh
 * cherry tomatoes silently became a vinegar-marinated JAR, cranberries became
 * NATURFOOD's sweetened dried ones, and blueberries became dried barberry
 * spice, all at 0.78–0.97 while the fresh listings sat in the alternatives.
 * The processed name is short and the fresh one is long and descriptive, so
 * the processed shelf wins on spelling every time something does not say
 * otherwise — exactly the mechanism already documented at FRESH_MEAT_FISH.
 *
 * FRESH side: the produce department subtree, 1–21 under 'Daržovės ir
 * vaisiai', MINUS 10 'Marinuotos, raugintos ir sūdytos daržovės' — a pickled
 * shelf that happens to be filed among the fresh ones. 309 'Šaldytos uogos ir
 * vaisiai' counts as fresh-side deliberately: for berries the frozen bag is
 * the honest answer half the year, and it is what the demotion should be
 * allowed to promote when a recipe says "spanguolių" in January.
 *
 * Ids verified against the dev category tree (2026-07-27) — including the
 * trap that the marinated tomatoes and dried cranberries above are NOT in any
 * of these categories at all (they sit in 688 'Nepriskirta'); those are
 * caught by the "Mar."/"Dž." abbreviations in PREPARED_MARKER instead, and
 * both guards are needed.
 */
const FRESH_PRODUCE_CATEGORY = (id: number): boolean =>
    (id >= 1 && id <= 21 && id !== 10) || id === 309;

/**
 * The dried-herb-and-spice shelves, as a set because the fresh-herb rule needs
 * them too: the wantsFresh demotion used to name 245 alone, but KOTANYI's
 * blends ("Toskanos žalumynai", "Sriubos žalumynai") live in 246/660 and
 * outscored the fresh shelf from there. 244 pepper, 247/248/661 seasoning
 * preps round out the same aisle.
 */
const DRIED_SPICE_SHELF: ReadonlySet<number> = new Set(
    [244, DRIED_SPICE_CATEGORY, 246, 247, 248, 660, 661]);

/**
 * PROCESSED side of the produce axis. Only ever consulted when fresh produce
 * is actually in the pool, and never when the recipe asked for the
 * preparation itself ("džiovintų spanguolių" keeps its dried cranberries —
 * queryPrepared gates the rule, same as for meat).
 *
 *   10        marinated / fermented / salted vegetables
 *   147–157,
 *   159–160,
 *   162       canned vegetables, mushrooms, fruit, purées ('Konservuotas
 *             maistas' subtree — 158 jams and 161 honey are carved out: a jam
 *             is a product a recipe asks for AS ITSELF, and it never competes
 *             with fresh fruit on a fruit query anyway)
 *   221–224   dried fruit / berries / mushrooms and their mixes
 *   664,
 *   666–668   the health-food twins of the same shelves ('Sėklos ir jų
 *             mišiniai' is where the Margainių supplement powder lives)
 *   spice     the whole DRIED_SPICE_SHELF — dried herbs are processed produce
 *             whenever the fresh herb is on offer and nobody said "dried"
 *
 * Deliberately absent: the raw nut/seed shelves (225–227, 662–663, 665) — raw
 * seeds ARE the product a seed recipe means, and a stray fresh pumpkin in the
 * pool must not demote them.
 */
const PROCESSED_PRODUCE_CATEGORY = (id: number): boolean =>
    id === 10
    || (id >= 147 && id <= 157) || id === 159 || id === 160 || id === 162
    || (id >= 221 && id <= 224)
    || id === 664 || (id >= 666 && id <= 668)
    || DRIED_SPICE_SHELF.has(id);

/** Keys with a `_dried` twin — i.e. the ones that mean the fresh thing. */
const FRESH_KEYS: ReadonlySet<string> = new Set(
    INGREDIENTS.map(i => i.key).filter(k => INGREDIENTS.some(o => o.key === `${k}_dried`)),
);

const FRESH_WORD = /(?:^|\W)(?:fresh|šviež|sviez)/iu;
const DRIED_WORD = /(?:^|\W)(?:dried|ground|džiovint|dziovint|malt)/iu;

/**
 * How much each disqualifying signal costs a candidate, in confidence points.
 *
 * `prepared` is the heaviest because it is the difference between an ingredient
 * and a finished dish; 0.30 is enough to put a 0.97 tin below a 0.75 fresh cut,
 * which is the case that exposed all of this. `multipack` is the lightest — a
 * box of fifty sugar sachets is still sugar.
 */
const PENALTY = {
    prepared: 0.30,
    accompanied: 0.30,
    wrongShelf: 0.25,
    unlisted: 0.20,
    seed: 0.25,
    multipack: 0.10,
} as const;

/** "50 X 3 g", "4x100g" — a case of small units rather than one package. */
const MULTIPACK = /\d+\s*[x×]\s*\d/i;

const normalise = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const findProductsFor = async (
    query: string,
    ing: ParsedIngredient,
    info: IngredientInfo | null,
    locale: Locale,
): Promise<ProductPick[]> => {
    // Recipes need the uncategorised shelf: most fresh produce lives there.
    const rows = await searchProduct(query, locale, { includeUncategorised: true });
    if (rows.length === 0) return [];

    const candidates: MatchCandidate[] = rows
        .filter((r: any) => !NOT_FOOD.test(String(r.name ?? ''))
            && !PET_FOOD.test(String(r.name ?? ''))
            && !NON_FOOD_CATEGORY(Number(r.categoryId ?? 0)))
        .slice(0, CANDIDATE_CAP).map((r: any) => ({
        id: Number(r.id),
        productId: Number(r.id),
        categoryId: Number(r.categoryId ?? 0),
        categoryName: r.categoryName ?? null,
        categoryL2Name: null,
        storeProductName: String(r.name ?? ''),
        brandName: null,
        // Product rows carry the size RANGE across every chain that sells it;
        // the smallest package is the closest thing to "the" size and is what a
        // shopper reaches for.
        amount: numOrNull(r.minAmount),
        unit: r.unit ?? null,
        isWeighable: Boolean(r.hasWeighable),
        imageUrl: firstImage(r.imageUrls),
        isCatalog: true,
    }));

    /**
     * NO amount signal. The matcher reads amount+unit as the PACKAGE the product
     * comes in and penalises a size mismatch — correct for a receipt line, where
     * the number IS the pack bought. A recipe's number is how much you USE: an
     * exact "Kvietiniai miltai" match scored 1.00 for "kvietinių miltų" and 0.57
     * for "200 g kvietinių miltų", because a 1 kg bag is not a 200 g bag. Taking
     * 200 g out of a kilo is just baking. The recipe's amount decides HOW MANY to
     * buy (see `shoppingAmount`); it must not decide WHAT to buy.
     */
    const matches = findBestProductMatches(
        query,
        null,
        null,
        candidates,
        MIN_ACCEPT - 0.12,               // recall a little below the accept bar so
        RANKING_POOL,                    // near-misses can be offered as options
        // NOT `info.weighable`. That field says how shops USUALLY sell the thing,
        // but the matcher treats the flag as a hard form GATE: passing `true` for
        // avocado rejected all 28 avocado rows, "Avokadas" at 0.98 included,
        // because the catalog files them as packaged. The catalog is the
        // authority on its own products; the hint is only used afterwards, to
        // decide whether to shop in kilograms or in units.
        null,
        { typed: true },
    );

    const globalById = new Map<number, number>(
        rows.map((r: any) => [Number(r.id), Number(r.globalScore) || 0]),
    );
    const byId = new Map<number, MatchCandidate>(candidates.map(c => [c.productId, c]));
    const seedNames = await loadSeedNames();
    const unlistedById = new Map<number, boolean>(
        rows.map((r: any) => [Number(r.id), unlistedInUncategorised(r)]),
    );
    return matches.map(m => ({
        // Affinity is stamped later, once the caller knows who is shopping.
        affinity: 0,
        globalScore: globalById.get(m.productId) ?? 0,
        productId: m.productId,
        name: m.name,
        imageUrl: m.imageUrl,
        isWeighable: m.isWeighable,
        packAmount: m.amount,
        packUnit: m.unit,
        confidence: m.confidence,
        suspectSeed: suspectSeedPacket(byId.get(m.productId), seedNames),
        categoryId: byId.get(m.productId)?.categoryId ?? 0,
        unlisted: unlistedById.get(m.productId) ?? false,
    }));
};

/**
 * How much to put in the basket.
 *
 * The recipe's amount and the SHOPPING amount are different questions, and
 * conflating them produced the worst results in the first sweep: five
 * peppercorns became five jars of pepper, and a handful of parsley became five
 * bunches. The rules, in the order they fire:
 *
 *   pantry            → exactly one. You are topping up a cupboard staple, and
 *                       nobody buys five jars of pepper for one pinch.
 *   sold by weight    → kilograms, floored at 100 g (no counter weighs out 12 g)
 *                       and capped at 5 kg so a mis-parse cannot order a sack.
 *   countable pieces  → the count, but only for things actually SOLD by the
 *                       piece (the table knows a piece weight): eggs, onions,
 *                       lemons. Capped at 12.
 *   a package size we
 *   can compare with  → need ÷ package, rounded up, capped at 6.
 *   anything else     → one. The honest default.
 */
const MAX_KG = 5;
const MAX_PIECES = 12;
const MAX_PACKS = 6;

/**
 * Grams for a VOLUME of something the shop weighs.
 *
 * Recipes measure solids by the spoon ("3 tbsp fresh ginger") and the ingredient
 * table only knows a density for some of them. Without one this returned
 * nothing and the caller fell back to a full kilogram; a coarse density is much
 * closer to the truth than that. 0.5 g/ml is the rough middle of chopped and
 * grated produce — the answer is bounded by the same floor and ceiling as every
 * other weight, and the displayed amount already reads as an approximation.
 */
const GENERIC_SOLID_DENSITY = 0.5;

const gramsFromVolume = (measure: Measure, info: IngredientInfo | null): number | null => {
    if (measure.unit !== 'ml' || measure.qty == null || !(measure.qty > 0)) return null;
    return measure.qty * (info?.gramsPerMl ?? GENERIC_SOLID_DENSITY);
};

export const shoppingAmount = (
    measure: Measure,
    pick: ProductPick,
    info: IngredientInfo | null,
): { quantity: number; unit: 'kg' | 'vnt' } => {
    if (info?.pantry) {
        // A staple is a top-up, not a stock-up. One package is right for a jar or
        // a bag; for something the shop WEIGHS, one kilogram is not — a recipe
        // using 2.5 ml of ground ginger was ordering a kilo of ginger root. Buy
        // what the recipe needs, within sane bounds.
        if (!pick.isWeighable) return { quantity: 1, unit: 'vnt' };
        const grams = measure.unit === 'g' ? measure.qty : gramsFromVolume(measure, info);
        /**
         * THE CAP APPLIES TO THE GUESS, NOT TO A KNOWN NEED.
         *
         * A flat 0.5 kg ceiling made a recipe calling for 600 g of flour buy
         * 500 g — the shopper gets home short, which is worse than any
         * over-buy this cap was protecting against. The cap exists because an
         * UNKNOWN pantry amount used to become a kilo; so it now bounds the
         * fallback, while a recipe that states how much it needs gets it.
         */
        if (grams == null || !(grams > 0)) return { quantity: 0.1, unit: 'kg' };
        const kg = Math.round(grams / 10) / 100;
        return { quantity: Math.min(MAX_KG, Math.max(0.05, kg)), unit: 'kg' };
    }

    if (pick.isWeighable) {
        const grams = measure.unit === 'g' ? measure.qty
            : measure.unit === 'pcs' && info?.gramsPerPiece != null ? measure.qty! * info.gramsPerPiece
            : gramsFromVolume(measure, info);
        /**
         * 0.3 kg, not 1 kg. With nothing to go on, a whole kilogram is a
         * confident answer to a question we cannot answer — it put a kilo of
         * fresh ginger in a basket that wanted three tablespoons. A third of a
         * kilo is roughly "a couple of them" for anything sold by weight, and
         * being modestly short of a guess beats being four times over it.
         */
        if (grams == null || !(grams > 0)) return { quantity: 0.3, unit: 'kg' };
        const kg = Math.round(grams / 10) / 100;
        return { quantity: Math.min(MAX_KG, Math.max(0.1, kg)), unit: 'kg' };
    }

    // A count only means "buy this many" when the shop sells the thing that way.
    // "5 vnt." of peppercorns is a count of peppercorns, not of pepper jars, and
    // the table's piece weight is what distinguishes the two.
    if (measure.unit === 'pcs' && measure.qty != null && measure.qty > 0 && info?.gramsPerPiece != null) {
        /**
         * ...and a count of things much SMALLER than the package is a count of
         * the contents, not of packages. Nine sprigs of thyme are nine sprigs;
         * buying nine packs of thyme for them is the same mistake as five jars
         * of peppercorns, one level down. When the whole amount fits in a single
         * package, one package is the answer.
         */
        const packOne = packInBaseUnit(pick);
        const wanted = measure.qty * info.gramsPerPiece;
        // Under 100 g in total, whatever the package is. Nine sprigs of thyme
        // weigh 27 g and are one bunch; three cloves of garlic are one head; one
        // lemon is one lemon. You cannot buy a fraction of a bunch, and the
        // catalog frequently records no size at all for fresh herbs, so this has
        // to hold without knowing the package.
        if (wanted < 100) return { quantity: 1, unit: 'vnt' };
        if (packOne && packOne.dim === 'mass' && packOne.value > 0 && wanted <= packOne.value) {
            return { quantity: 1, unit: 'vnt' };
        }
        return { quantity: Math.min(MAX_PIECES, Math.max(1, Math.ceil(measure.qty))), unit: 'vnt' };
    }

    const pack = packInBaseUnit(pick);
    const needed = neededInBaseUnit(measure);
    // Same dimension only. A 120 ml handful of parsley divided by a 25 g bunch
    // is not four bunches — it is a unit error, and it shipped one.
    if (pack && needed && pack.dim === needed.dim && pack.value > 0) {
        return {
            quantity: Math.min(MAX_PACKS, Math.max(1, Math.ceil(round2(needed.value / pack.value)))),
            unit: 'vnt',
        };
    }
    return { quantity: 1, unit: 'vnt' };
};

type Dimensioned = { value: number; dim: 'mass' | 'volume' };

/** Package size, normalised to grams or millilitres — with its dimension kept,
 *  because grams and millilitres are only interchangeable for water. */
const packInBaseUnit = (pick: ProductPick): Dimensioned | null => {
    if (pick.packAmount == null || !pick.packUnit) return null;
    const u = pick.packUnit.toLowerCase();
    if (u === 'g') return { value: pick.packAmount, dim: 'mass' };
    if (u === 'kg') return { value: pick.packAmount * 1000, dim: 'mass' };
    if (u === 'ml') return { value: pick.packAmount, dim: 'volume' };
    if (u === 'l') return { value: pick.packAmount * 1000, dim: 'volume' };
    return null;
};

const neededInBaseUnit = (m: Measure): Dimensioned | null => {
    if (m.qty == null) return null;
    if (m.unit === 'g') return { value: m.qty, dim: 'mass' };
    if (m.unit === 'ml') return { value: m.qty, dim: 'volume' };
    return null;
};

const numOrNull = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
};

const firstImage = (v: unknown): string | null => {
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    if (typeof v === 'string' && v) return v;
    return null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const unique = (xs: (string | null)[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
        const v = (x ?? '').trim();
        if (!v || seen.has(v.toLowerCase())) continue;
        seen.add(v.toLowerCase());
        out.push(v);
    }
    return out;
};

/**
 * How many ingredients are resolved at once.
 *
 * `searchProduct` fires up to five ranked SQL arms per call, so a 20-ingredient
 * recipe let loose all at once would drop a hundred-odd queries on a 20-slot
 * pool in one burst — for a single tap, while other requests wait. Strictly
 * sequential was the first cut and took 16 seconds on a long recipe, which is
 * not a tap either. Four at a time is the compromise: a wide enough pipe to hide
 * the latency, narrow enough to leave the pool for everyone else.
 */
const MATCH_CONCURRENCY = 4;

/**
 * Resolve a whole ingredient list, in order.
 *
 * Two caches do the real work: identical ingredient phrases are resolved once,
 * and identical catalog QUERIES are searched once even across different phrases
 * (both "druskos" and "jūros druskos" ask the catalog for "Druska").
 */
export const matchIngredients = async (
    ingredients: ParsedIngredient[],
    lang: Lang,
    locale: Locale = 'lt',
    userId: string | null = null,
): Promise<MatchedIngredient[]> => {
    const queryCache: QueryCache = new Map();
    // The shopper's whole score table, fetched ONCE. Asking per ingredient cost
    // 31 round trips on a 16-ingredient recipe for work the database does in
    // 0.055 ms — almost all of it latency.
    const affinityCache = userId ? await loadAffinityCache(userId) : undefined;
    const byPhrase = new Map<string, Promise<MatchedIngredient>>();
    const out: MatchedIngredient[] = new Array(ingredients.length);

    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= ingredients.length) return;
            const ing = ingredients[i];
            const key = `${ing.name.toLowerCase()}|${ing.quantity}|${ing.unit}`;
            let pending = byPhrase.get(key);
            if (!pending) {
                pending = matchIngredient(ing, lang, locale, queryCache, userId, affinityCache);
                byPhrase.set(key, pending);
            }
            out[i] = { ...(await pending), ingredient: ing };
        }
    };
    await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, ingredients.length) }, worker));
    return out;
};

/** Does the knowledge base know this exact surface form? Used by the sweep to
 *  report coverage without going near the database. */
export const knowsForm = (form: string): boolean => INGREDIENT_INDEX.has(form.toLowerCase());
