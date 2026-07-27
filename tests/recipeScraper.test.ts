import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    RecipeFetchError, RecipeParseError, assertFetchableUrl, cleanText, detectLang, extractRecipe,
} from '../src/services/recipes/recipeScraper.js';

/**
 * Fixtures are REAL pages, reduced to the parts that matter: each site's verbatim
 * JSON-LD block inside a minimal skeleton. Verbatim is the point — the quirks
 * these tests pin (raw control characters inside JSON strings, HTML entities that
 * never got decoded, units glued to ingredient names) are exactly what a
 * hand-written fixture would tidy away.
 *
 * Provenance for every fixture is in tests/fixtures/recipes/sources.json.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recipes');
const sources = JSON.parse(readFileSync(join(FIXTURES, 'sources.json'), 'utf8'));
const load = (name: string) => ({
    html: readFileSync(join(FIXTURES, `${name}.html`), 'utf8'),
    url: sources[name].url as string,
});

const scrape = (name: string) => {
    const { html, url } = load(name);
    return extractRecipe(html, url);
};

describe('extractRecipe — real pages', () => {
    it.each([
        ['lamaistas', 'lt', 7],
        ['receptai_glued', 'lt', 12],
        ['receptai_raw_newline', 'lt', 17],
        ['beatos', 'lt', 12],
        ['budgetbytes', 'en', 9],
        ['recipetineats', 'en', 15],
        ['food', 'en', 8],
    ])('%s yields a recipe from JSON-LD', (name, lang, ingredientCount) => {
        const r = scrape(name as string);
        expect(r.extractor).toBe('jsonld');
        expect(r.lang).toBe(lang);
        expect(r.title.length).toBeGreaterThan(3);
        expect(r.ingredientLines).toHaveLength(ingredientCount as number);
        expect(r.ingredientLines.every(l => l.trim().length > 0)).toBe(true);
        expect(r.site).not.toMatch(/^www\./);
    });

    /**
     * receptai.lt embeds raw newlines inside `recipeInstructions`, which makes the
     * whole block invalid JSON. Before the lenient parse, JSON.parse rejected it
     * and the recipe — ingredients included — was simply lost.
     */
    it('recovers a recipe from JSON-LD that strict JSON.parse rejects', () => {
        const { html } = load('receptai_raw_newline');
        const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
        expect(() => JSON.parse(block)).toThrow();

        const r = scrape('receptai_raw_newline');
        expect(r.ingredientLines[0]).toContain('kilogramo');
    });

    it('decodes HTML entities that the site left in the JSON strings', () => {
        const r = scrape('recipetineats');
        expect(r.ingredientLines.join(' ')).not.toMatch(/&(amp|quot|#\d+);/);
    });

    it('reads servings and an image where the page publishes them', () => {
        const r = scrape('lamaistas');
        expect(r.servings).toBe(2);
        expect(r.imageUrl).toMatch(/^https?:\/\//);
    });
});

describe('extractRecipe — the fallback ladder', () => {
    const page = (body: string, head = '') =>
        `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;

    it('falls back to microdata when there is no JSON-LD', () => {
        const r = extractRecipe(page(`
            <div itemscope itemtype="https://schema.org/Recipe">
              <h2 itemprop="name">Microdata Pie</h2>
              <span itemprop="recipeYield">6 servings</span>
              <li itemprop="recipeIngredient">2 cups flour</li>
              <li itemprop="recipeIngredient">1 tsp salt</li>
            </div>`), 'https://example.com/r');
        expect(r.extractor).toBe('microdata');
        expect(r.title).toBe('Microdata Pie');
        expect(r.servings).toBe(6);
        expect(r.ingredientLines).toEqual(['2 cups flour', '1 tsp salt']);
    });

    it('falls back to WP Recipe Maker markup', () => {
        const r = extractRecipe(page(`
            <h2 class="wprm-recipe-name">WPRM Soup</h2>
            <li class="wprm-recipe-ingredient"><span>2</span> <span>tbsp</span> <span>olive oil</span></li>
            <li class="wprm-recipe-ingredient"><span>1</span> <span>onion</span></li>`), 'https://example.com/r');
        expect(r.extractor).toBe('wprm');
        expect(r.ingredientLines).toEqual(['2 tbsp olive oil', '1 onion']);
    });

    it('falls back to a hydration blob', () => {
        const blob = JSON.stringify({ props: { recipe: { name: 'Hydrated', recipeIngredient: ['3 eggs', '200 g sugar'] } } });
        const r = extractRecipe(page(`<script id="__NEXT_DATA__">${blob}</script>`), 'https://example.com/r');
        expect(r.extractor).toBe('nextdata');
        expect(r.ingredientLines).toEqual(['3 eggs', '200 g sugar']);
    });

    it('falls back to an Ingredients heading followed by a list', () => {
        const r = extractRecipe(page(`
            <h1>Plain Cake</h1>
            <h2>Ingredientai</h2>
            <ul><li>200 g miltų</li><li>2 kiaušiniai</li><li>100 g cukraus</li></ul>`), 'https://example.com/r');
        expect(r.extractor).toBe('dom');
        expect(r.ingredientLines).toHaveLength(3);
    });

    /** A navigation list under an "Ingredients" heading is not an ingredient
     *  list. Without this guard the DOM rung turns any page into a "recipe". */
    it('refuses a list that does not look like ingredients', () => {
        expect(() => extractRecipe(page(`
            <h2>Ingredients</h2>
            <ul><li>About us</li><li>Contact</li><li>Privacy policy</li></ul>`), 'https://example.com/x'))
            .toThrow(RecipeParseError);
    });

    it('refuses a page with no recipe at all', () => {
        expect(() => extractRecipe(page('<p>Just an article about food.</p>'), 'https://example.com/x'))
            .toThrow(RecipeParseError);
    });

    it('drops a line the site published twice', () => {
        const blob = JSON.stringify({
            '@type': 'Recipe', name: 'Dupe', recipeIngredient: ['1 tsp salt', '1 tsp salt', '2 eggs'],
        });
        const r = extractRecipe(page(`<script type="application/ld+json">${blob}</script>`), 'https://example.com/r');
        expect(r.ingredientLines).toEqual(['1 tsp salt', '2 eggs']);
    });
});

describe('detectLang', () => {
    it('trusts the ingredient text over a wrong lang attribute', () => {
        // Lithuanian sites ship lang="en" from theme defaults more often than not.
        expect(detectLang('en', '2 šaukštai aliejaus, druskos pagal skonį')).toBe('lt');
    });
    it('reads Lithuanian unit vocabulary even when the diacritics are missing', () => {
        // A CMS that strips diacritics still prints "gramu"/"vienetai", and that
        // vocabulary is Lithuanian no matter how it is spelled.
        expect(detectLang(undefined, '200 gramu miltu, 2 vienetai kiausiniu')).toBe('lt');
        expect(detectLang('lt-LT', '200 g flour')).toBe('lt');
    });
    it('defaults to English', () => {
        expect(detectLang('en-US', '2 cups flour, 1 tsp salt')).toBe('en');
    });
});

describe('cleanText', () => {
    it('decodes named, decimal and hex entities', () => {
        expect(cleanText('salt &amp; pepper &#189; cup &#x2153; tsp')).toBe('salt & pepper ½ cup ⅓ tsp');
    });
    it('collapses whitespace and non-breaking spaces', () => {
        expect(cleanText('  2 tbsp   oil \n ')).toBe('2 tbsp oil');
    });
    it('leaves an unknown entity alone rather than mangling it', () => {
        expect(cleanText('a &nosuchentity; b')).toBe('a &nosuchentity; b');
    });
});

/**
 * SSRF. This is the only endpoint in the codebase that fetches a host the CALLER
 * chooses, which turns the server into a proxy sitting inside our own network.
 * These cases short-circuit before DNS, so the test needs no network.
 */
describe('assertFetchableUrl', () => {
    const rejects = async (url: string, code: string) => {
        await expect(assertFetchableUrl(url)).rejects.toMatchObject({ code });
    };

    it('refuses non-http protocols', async () => {
        await rejects('file:///etc/passwd', 'bad_url');
        await rejects('gopher://example.com/', 'bad_url');
        await rejects('not a url', 'bad_url');
    });

    it('refuses embedded credentials', async () => {
        await rejects('http://user:pass@example.com/r', 'bad_url');
    });

    it('refuses loopback, link-local and private literals', async () => {
        await rejects('http://127.0.0.1/', 'blocked_host');
        await rejects('http://localhost:3000/', 'blocked_host');
        await rejects('http://169.254.169.254/latest/meta-data/', 'blocked_host');  // cloud metadata
        await rejects('http://10.0.0.5/', 'blocked_host');
        await rejects('http://192.168.1.212:3307/', 'blocked_host');                // our own dev DB
        await rejects('http://172.16.4.4/', 'blocked_host');
        await rejects('http://[::1]/', 'blocked_host');
        // `new URL()` rewrites this to [::ffff:a00:1] — the check must read the
        // address, not its spelling.
        await rejects('http://[::ffff:10.0.0.1]/', 'blocked_host');
        await rejects('http://[::ffff:a00:1]/', 'blocked_host');
        await rejects('http://[fd00::1]/', 'blocked_host');
        await rejects('http://[fe80::1]/', 'blocked_host');
        await rejects('http://printer.local/', 'blocked_host');
    });

    it('allows a public IP literal', async () => {
        await expect(assertFetchableUrl('https://93.184.216.34/recipe')).resolves.toBeInstanceOf(URL);
    });
});

describe('RecipeFetchError', () => {
    it('carries a machine-readable code and an optional status', () => {
        const e = new RecipeFetchError('http_error', 403);
        expect(e.code).toBe('http_error');
        expect(e.status).toBe(403);
        expect(e).toBeInstanceOf(Error);
    });
});
