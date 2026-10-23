import type { Locale } from '../../middleware/locale.js';
import { parseIngredientLines } from './ingredientParser.js';
import { type MatchedIngredient, matchIngredients } from './recipeMatcher.js';
import { RecipeParseError, extractRecipe, fetchRecipeHtml } from './recipeScraper.js';
import type { Lang, ScrapedRecipe } from './types.js';

/**
 * RECIPE IMPORT — the one function the API layer calls.
 *
 *   url → fetch → extract → parse → measure → match → preview
 *
 * The result is a PREVIEW, never a saved template. The shopper confirms the
 * name, the cover and the product list first, and the app then creates the
 * template through the endpoint it already uses. That keeps this service free of
 * write concerns and means a bad import costs nothing.
 */

export interface RecipeImportItem {
    /** Position in the published list — the app's stable key. */
    index: number;
    /** The published line, for the "this is what the recipe said" affordance. */
    raw: string;
    /** Ingredient as the recipe means it ("kvietiniai miltai"). */
    name: string;
    /** What the recipe asks for, converted: "≈21 g", "150 ml", "2 vnt.". */
    amountText: string | null;
    /** Probably in the cupboard already — grouped for one-glance removal. */
    pantry: boolean;

    productId: number | null;
    productName: string | null;
    imageUrl: string | null;
    isWeighable: boolean;
    /** How much to buy, in the product's own unit. */
    quantity: number;
    unit: 'kg' | 'vnt';
    confidence: number;
    /** Matched, but not confidently — the app should ask before trusting it. */
    needsReview: boolean;
    alternatives: { productId: number; name: string; imageUrl: string | null; confidence: number }[];
}

export interface RecipeImportPreview {
    title: string;
    sourceUrl: string;
    site: string;
    imageUrl: string | null;
    servings: number | null;
    lang: Lang;
    /** Which rung of the extraction ladder answered — diagnostics only. */
    extractor: string;
    /** Prefill for the cover sheet. */
    suggestedEmoji: string;
    items: RecipeImportItem[];
    /** Lines we could not turn into a product: section headings, prose, and
     *  ingredients with no catalog match. Shown so nothing vanishes silently. */
    skipped: { raw: string; name: string; amountText: string | null; reason: 'unmatched' | 'not_an_ingredient' }[];
    counts: { matched: number; needsReview: number; pantry: number; skipped: number };
}

export const importRecipeFromUrl = async (
    url: string, locale: Locale = 'lt', userId: string | null = null,
): Promise<RecipeImportPreview> => {
    const { html, finalUrl } = await fetchRecipeHtml(url);
    return buildPreview(extractRecipe(html, finalUrl), locale, userId);
};

/**
 * Import from HTML the CLIENT fetched.
 *
 * A few large publishers answer any datacentre IP with a bot challenge, so the
 * server can never read those pages. The phone can: it has a residential
 * address and a real browser stack. `sourceUrl` is still required — it is what
 * the recipe is attributed to, and the extractor needs it to resolve relative
 * image paths.
 */
export const importRecipeFromHtml = async (
    html: string, sourceUrl: string, locale: Locale = 'lt', userId: string | null = null,
): Promise<RecipeImportPreview> => buildPreview(extractRecipe(html, sourceUrl), locale, userId);

/** `userId` is what makes the match personal: among products that are all
 *  genuinely the ingredient, the one this shopper actually buys wins. */
const buildPreview = async (
    recipe: ScrapedRecipe, locale: Locale, userId: string | null = null,
): Promise<RecipeImportPreview> => {
    const parsed = parseIngredientLines(recipe.ingredientLines, recipe.lang);
    if (parsed.every(p => p.ignored)) throw new RecipeParseError();

    const matched = await matchIngredients(parsed, recipe.lang, locale, userId);

    const items: RecipeImportItem[] = [];
    const skipped: RecipeImportPreview['skipped'] = [];

    matched.forEach((m, i) => {
        if (m.ingredient.ignored) {
            skipped.push({ raw: m.ingredient.raw, name: m.ingredient.name, amountText: null, reason: 'not_an_ingredient' });
            return;
        }
        if (!m.product) {
            skipped.push({
                raw: m.ingredient.raw,
                name: m.ingredient.name,
                amountText: m.measureText,
                reason: 'unmatched',
            });
            return;
        }
        items.push(toItem(m, i));
    });

    return {
        title: recipe.title,
        sourceUrl: recipe.sourceUrl,
        site: recipe.site,
        imageUrl: recipe.imageUrl,
        servings: recipe.servings,
        lang: recipe.lang,
        extractor: recipe.extractor,
        suggestedEmoji: suggestEmoji(recipe.title),
        items,
        skipped,
        counts: {
            matched: items.length,
            needsReview: items.filter(i => i.needsReview).length,
            pantry: items.filter(i => i.pantry).length,
            skipped: skipped.length,
        },
    };
};

const toItem = (m: MatchedIngredient, index: number): RecipeImportItem => ({
    index,
    raw: m.ingredient.raw,
    name: m.ingredient.name,
    amountText: m.measureText,
    pantry: m.pantry,
    productId: m.product!.productId,
    productName: m.product!.name,
    imageUrl: m.product!.imageUrl,
    isWeighable: m.product!.isWeighable,
    quantity: m.shopQuantity,
    unit: m.shopUnit,
    confidence: m.product!.confidence,
    needsReview: !m.confident,
    alternatives: m.alternatives.map(a => ({
        productId: a.productId, name: a.name, imageUrl: a.imageUrl, confidence: a.confidence,
    })),
});

/**
 * A first guess at the cover emoji, from the dish name. The shopper can change
 * it in the same sheet where they confirm the name, so being roughly right is
 * worth more than being cautious — an empty default makes every imported recipe
 * look identical in the list.
 */
const EMOJI_HINTS: [RegExp, string][] = [
    [/tort|pyrag|cake|keks|muffin|bandel/i, '🍰'],
    [/sausain|cookie|biscuit/i, '🍪'],
    [/sriub|soup|borš|barš/i, '🍲'],
    [/salot|salad|mišrain/i, '🥗'],
    [/makaron|pasta|spaget|lazanij|lasagn|noodle/i, '🍝'],
    [/picc?a|pizza/i, '🍕'],
    [/vištien|chicken|kalakut/i, '🍗'],
    [/jautien|steak|kepsn|beef|burger|mėsos|farš|kotlet|meatball|meatloaf/i, '🥩'],
    [/kiaulien|šonin|kumpi|bacon|pork/i, '🥓'],
    [/žuv|lašiš|fish|salmon|silk|tuna|krevet|shrimp/i, '🐟'],
    [/blyn|pancake|vafl|waffle|varškėč/i, '🥞'],
    [/duon|bread|čiabat|sourdough|bagel/i, '🍞'],
    [/koktei|smoothie|glotnut|drink|arbat|kav[ao]|latte/i, '🥤'],
    [/desert|ledai|ice cream|pudin|želė|mousse|tiramis/i, '🍨'],
    [/uogien|jam|marmelad|sirup/i, '🍯'],
    [/cepelin|kugel|virtinuk|dumpling|koldūn/i, '🥟'],
    [/bulvi|potato|apkep|casserole|troškin|stew|plov|risott|curry|kar[iy]/i, '🍛'],
    [/kiaušin|egg|omlet/i, '🍳'],
    [/sūri|cheese|varšk/i, '🧀'],
    [/daržov|vegetab|veggie|cukinij|moliūg|burokėl/i, '🥕'],
    [/agurk|pomidor|marinuot|raugint|pickle/i, '🥒'],
];

export const suggestEmoji = (title: string): string => {
    for (const [re, emoji] of EMOJI_HINTS) if (re.test(title)) return emoji;
    return '🍽️';
};
