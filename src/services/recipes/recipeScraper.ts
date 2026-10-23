import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import net from 'node:net';
import { type Browser, chromium } from 'playwright';
import type { Extractor, Lang, ScrapedRecipe } from './types.js';

/**
 * RECIPE SCRAPER — lift a recipe out of an arbitrary public web page.
 *
 * We do NOT write a parser per site. Recipe sites publish schema.org `Recipe`
 * structured data because Google's rich results demand it, so the same JSON-LD
 * block sits on lamaistas.lt, receptai.lt, beatosvirtuve.lt, budgetbytes.com,
 * recipetineats.com and food.com alike. That is the "table embedded in the HTML
 * for SEO" — and it is a far better source than the rendered DOM, which every
 * site themes differently and rewrites twice a year.
 *
 * The ladder below is ordered by how much the site is PROMISING us:
 *   jsonld    — schema.org/Recipe in a <script type="application/ld+json">
 *   microdata — the same vocabulary expressed as itemprop attributes
 *   wprm      — WP Recipe Maker's DOM (the dominant WordPress recipe plugin)
 *   nextdata  — a Next.js/Nuxt hydration blob carrying recipeIngredient
 *   dom       — an "Ingredients"/"Ingredientai" heading followed by a list
 * `ScrapedRecipe.extractor` records which rung answered, so a sweep can show a
 * site silently degrading after a redesign instead of just getting worse.
 *
 * SPLIT ON PURPOSE: `fetchRecipeHtml` does the network, `extractRecipe` is pure.
 * Every test runs off stored HTML, and the app can hand us HTML it fetched
 * itself when a site blocks our server (see `fetchRecipeHtml`'s note on 403s).
 */

/** Real recipes are well under this; anything bigger is not a recipe page. */
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;

/**
 * A browser User-Agent, deliberately. This is a user-initiated fetch of one
 * public page they are reading, but a bare `node` UA is refused by most CDNs,
 * and being refused would just push the work onto the phone for no gain.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** What the fallback browser claims to be. Its own default announces
 *  "HeadlessChrome", which is refused on sight. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class RecipeFetchError extends Error {
    constructor(public code: 'bad_url' | 'blocked_host' | 'http_error' | 'too_large' | 'timeout' | 'network',
                public status?: number) {
        super(code);
        this.name = 'RecipeFetchError';
    }
}

export class RecipeParseError extends Error {
    constructor() { super('no_recipe'); this.name = 'RecipeParseError'; }
}

/* ────────────────────────────── SSRF guard ─────────────────────────────── */

/**
 * Every other outbound fetch in this codebase targets a hard-coded chain
 * domain. This one takes a URL from a user, which makes the server a proxy:
 * without a guard, `http://169.254.169.254/` or `http://192.168.1.212:3307`
 * would be fetched with our network position and handed back to the caller.
 *
 * So: http(s) only, no embedded credentials, and the resolved ADDRESS must be
 * public — checked per redirect hop, because a public host is free to redirect
 * to a private one.
 */
const isPrivateAddress = (ip: string): boolean => {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;         // link-local / cloud metadata
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        if (a >= 224) return true;                        // multicast + reserved
        return false;
    }
    if (net.isIPv6(ip)) {
        const h = expandIpv6(ip);
        if (!h) return true;                                  // unparseable → refuse
        if (h.every(x => x === 0)) return true;               // ::
        if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return true; // ::1

        // An IPv4 address wearing an IPv6 coat. TRAP: `new URL()` rewrites
        // "[::ffff:10.0.0.1]" to "[::ffff:a00:1]", so a regex looking for a
        // dotted quad sees nothing and the private address sails through. Read
        // the low 32 bits instead of the spelling.
        const mappedPrefix = h.slice(0, 5).every(x => x === 0);
        if (mappedPrefix && (h[5] === 0xffff || h[5] === 0)) {
            const v4 = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join('.');
            return isPrivateAddress(v4);
        }
        if ((h[0] & 0xfe00) === 0xfc00) return true;           // fc00::/7 unique-local
        if ((h[0] & 0xffc0) === 0xfe80) return true;           // fe80::/10 link-local
        return false;
    }
    return true; // unparseable → refuse
};

/** IPv6 text → its eight 16-bit groups, or null when it isn't one. Handles the
 *  `::` run and a trailing dotted quad. */
const expandIpv6 = (raw: string): number[] | null => {
    let s = raw.toLowerCase().replace(/%.*$/, '');            // drop any zone id
    const dotted = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) {
        const b = dotted[1].split('.').map(Number);
        if (b.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        s = s.slice(0, dotted.index)
            + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
    }
    const runs = s.split('::');
    if (runs.length > 2) return null;
    const part = (v: string) => (v ? v.split(':').filter(Boolean) : []);
    let groups: string[];
    if (runs.length === 1) {
        groups = part(runs[0]);
        if (groups.length !== 8) return null;
    } else {
        const left = part(runs[0]);
        const right = part(runs[1]);
        const fill = 8 - left.length - right.length;
        if (fill < 0) return null;
        groups = [...left, ...Array(fill).fill('0'), ...right];
    }
    const nums = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return nums.some(n => !Number.isFinite(n)) ? null : nums;
};

/** Throws unless `raw` is a public http(s) URL we're willing to fetch. */
export const assertFetchableUrl = async (raw: string): Promise<URL> => {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new RecipeFetchError('bad_url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RecipeFetchError('bad_url');
    if (url.username || url.password) throw new RecipeFetchError('bad_url');

    // A bare IP literal skips DNS; check it directly.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
        if (isPrivateAddress(host)) throw new RecipeFetchError('blocked_host');
        return url;
    }
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new RecipeFetchError('blocked_host');
    }
    let addrs: { address: string }[];
    try { addrs = await dns.lookup(host, { all: true }); } catch { throw new RecipeFetchError('bad_url'); }
    if (addrs.length === 0 || addrs.some(a => isPrivateAddress(a.address))) {
        throw new RecipeFetchError('blocked_host');
    }
    return url;
};

/* ─────────────────────────────── fetching ──────────────────────────────── */

/**
 * Fetch a recipe page as HTML.
 *
 * Redirects are followed BY HAND (`redirect: 'manual'`) so every hop passes the
 * SSRF guard again, and the body is read in chunks so a hostile or merely
 * enormous response can be cut off at MAX_HTML_BYTES instead of being buffered
 * whole.
 *
 * Some publishers (the Dotdash Meredith network — allrecipes.com,
 * seriouseats.com, simplyrecipes.com) refuse this request with 402/403 and a
 * one-kilobyte challenge page. `renderRecipeHtml` is the answer; see the note
 * there for what actually triggers it, which is NOT what it looks like.
 */
export const fetchRecipeHtml = async (rawUrl: string): Promise<{ html: string; finalUrl: string }> => {
    let url = await assertFetchableUrl(rawUrl);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let res: Response;
        try {
            res = await fetch(url, {
                redirect: 'manual',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: {
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'lt-LT,lt;q=0.9,en-US,en;q=0.8',
                },
            });
        } catch (e: any) {
            throw new RecipeFetchError(e?.name === 'TimeoutError' ? 'timeout' : 'network');
        }

        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) throw new RecipeFetchError('http_error', res.status);
            url = await assertFetchableUrl(new URL(loc, url).toString());
            continue;
        }
        if (BOT_CHALLENGE.has(res.status)) return renderRecipeHtml(url.toString(), res.status);
        if (!res.ok) throw new RecipeFetchError('http_error', res.status);

        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > MAX_HTML_BYTES) throw new RecipeFetchError('too_large');
        return { html: await readCapped(res), finalUrl: url.toString() };
    }
    throw new RecipeFetchError('http_error');
};

/**
 * Statuses that mean "we think you are a robot" rather than "no such page".
 * 402 is the Dotdash network's chosen refusal; 403 and 429 are the usual ones.
 */
const BOT_CHALLENGE = new Set([402, 403, 429]);

/**
 * Read the page in a REAL browser, for publishers that refuse everything else.
 *
 * WHAT IS ACTUALLY GOING ON — measured, because the obvious explanations are
 * all wrong and one of them was written into this file:
 *   · Not the IP. The same request from a residential connection is refused.
 *   · Not the headers. Byte-identical headers to a curl request that succeeds
 *     still return 402 from Node.
 *   · Not the HTTP version. Node over HTTP/1.1 fails where curl over HTTP/1.1
 *     succeeds, same machine, same second.
 * What is left is the TLS handshake fingerprint — the ClientHello extension
 * order and GREASE values that identify the CLIENT LIBRARY — and Node exposes
 * no way to change it. Headless Chromium is refused too, on its
 * "HeadlessChrome" user agent and `navigator.webdriver`; a Chromium given a
 * normal user agent with that flag masked is served the article in full.
 *
 * Chromium is already a production dependency here (the chain scrapers use it)
 * and is installed in the runtime image, so this costs no new dependency — only
 * the second or so a browser takes to start, which is why it runs ONLY after a
 * refusal and never on the fast path.
 */
const renderRecipeHtml = async (url: string, status: number): Promise<{ html: string; finalUrl: string }> => {
    let browser: Browser | null = null;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const context = await browser.newContext({
            userAgent: BROWSER_UA,
            locale: 'en-US',
            viewport: { width: 1280, height: 800 },
        });
        // The one tell that survives a real user agent.
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        /**
         * A browser will happily follow a redirect to anywhere, including the
         * private addresses `assertFetchableUrl` exists to keep us away from.
         * Every navigation is re-validated, and everything that is not the
         * document itself is refused — we want the HTML, not the images, the
         * ads or the trackers, and blocking them is most of the speed back.
         */
        await context.route('**/*', async (route, request) => {
            if (request.resourceType() !== 'document') return route.abort();
            try {
                await assertFetchableUrl(request.url());
                return route.continue();
            } catch {
                return route.abort();
            }
        });

        const page = await context.newPage();
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT_MS * 2 });
        if (res && BOT_CHALLENGE.has(res.status())) throw new RecipeFetchError('http_error', res.status());
        const html = await page.content();
        if (html.length > MAX_HTML_BYTES) throw new RecipeFetchError('too_large');
        return { html, finalUrl: page.url() };
    } catch (e) {
        if (e instanceof RecipeFetchError) throw e;
        // The browser failing is not a different outcome from being blocked:
        // the caller's next move (ask the phone to fetch it) is the same.
        throw new RecipeFetchError('http_error', status);
    } finally {
        await browser?.close().catch(() => {});
    }
};

const readCapped = async (res: Response): Promise<string> => {
    const reader = res.body?.getReader();
    if (!reader) return res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_HTML_BYTES) { await reader.cancel(); throw new RecipeFetchError('too_large'); }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
};

/* ────────────────────────────── extraction ─────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
    hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', deg: '°', middot: '·', bull: '•', times: '×',
    frac12: '½', frac14: '¼', frac34: '¾', frac13: '⅓', frac23: '⅔',
    eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä',
};

/** Decode entities and normalise whitespace. JSON-LD is *text* inside a script
 *  tag, so the browser never decodes it for us — `&amp;` and `&quot;` arrive
 *  verbatim in `recipeIngredient` strings (recipetineats.com does exactly this). */
export const cleanText = (s: string): string =>
    s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
        .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const safeCodePoint = (n: number): string => {
    try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; } catch { return ''; }
};

/**
 * JSON-LD in the wild is not valid JSON. receptai.lt embeds raw newlines inside
 * `recipeInstructions` strings, which `JSON.parse` rejects outright — and with
 * it the whole recipe, ingredients and all. Escape the control characters that
 * are only ever illegal inside a string, then parse.
 */
const parseLooseJson = (raw: string): unknown => {
    const attempts = [raw, escapeControlChars(raw), escapeControlChars(cleanText(raw))];
    for (const a of attempts) {
        try { return JSON.parse(a); } catch { /* next */ }
    }
    return null;
};

const escapeControlChars = (s: string): string =>
    s.replace(/[\u0000-\u001f]/g, c => {
        if (c === '\n') return '\\n';
        if (c === '\r') return '\\r';
        if (c === '\t') return '\\t';
        return '';
    });

/** Depth-first walk over anything JSON-shaped. */
function* walkNodes(node: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(node)) {
        for (const n of node) yield* walkNodes(n);
    } else if (node && typeof node === 'object') {
        yield node as Record<string, unknown>;
        for (const v of Object.values(node as Record<string, unknown>)) yield* walkNodes(v);
    }
}

const isRecipeNode = (n: Record<string, unknown>): boolean => {
    const t = n['@type'];
    const types = Array.isArray(t) ? t : [t];
    return types.some(x => typeof x === 'string' && x.toLowerCase() === 'recipe');
};

const asStringList = (v: unknown): string[] => {
    if (typeof v === 'string') return v.split(/\r?\n/).map(cleanText).filter(Boolean);
    if (!Array.isArray(v)) return [];
    return v.flatMap(x => {
        if (typeof x === 'string') return [cleanText(x)];
        if (x && typeof x === 'object') {
            const o = x as Record<string, unknown>;
            const s = o.name ?? o.text ?? o.item;
            return typeof s === 'string' ? [cleanText(s)] : [];
        }
        return [];
    }).filter(Boolean);
};

const firstImage = (v: unknown): string | null => {
    for (const node of walkNodes(v)) {
        if (typeof node.url === 'string') return node.url;
    }
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return null;
};

/** `recipeYield` is "4", "4 servings", "6 porcijos", or an array of both. */
const parseServings = (v: unknown): number | null => {
    const pick = Array.isArray(v) ? v : [v];
    for (const raw of pick) {
        const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
        const m = s.match(/\d+/);
        if (m) {
            const n = Number(m[0]);
            if (Number.isFinite(n) && n > 0 && n <= 200) return n;
        }
    }
    return null;
};

interface RawRecipe { title: string; ingredients: string[]; servings: number | null; image: string | null }

const fromJsonLd = ($: cheerio.CheerioAPI): RawRecipe | null => {
    for (const el of $('script[type="application/ld+json"]').toArray()) {
        const data = parseLooseJson($(el).text());
        if (!data) continue;
        for (const node of walkNodes(data)) {
            if (!isRecipeNode(node)) continue;
            const ingredients = asStringList(node.recipeIngredient ?? node.ingredients);
            if (ingredients.length === 0) continue;
            return {
                title: cleanText(typeof node.name === 'string' ? node.name : ''),
                ingredients,
                servings: parseServings(node.recipeYield),
                image: firstImage(node.image),
            };
        }
    }
    return null;
};

const fromMicrodata = ($: cheerio.CheerioAPI): RawRecipe | null => {
    const scope = $('[itemtype*="schema.org/Recipe" i]').first();
    // `$.root()` is a Document node; scoping to <body> keeps one element type so
    // the same traversal works whether or not the page declares the itemtype.
    const root = scope.length ? scope : $('body');
    const ingredients = root
        .find('[itemprop="recipeIngredient"], [itemprop="ingredients"]')
        .toArray()
        .map(el => cleanText($(el).text()))
        .filter(Boolean);
    if (ingredients.length === 0) return null;
    return {
        title: cleanText(root.find('[itemprop="name"]').first().text()),
        ingredients,
        servings: parseServings(root.find('[itemprop="recipeYield"]').first().text()),
        image: root.find('[itemprop="image"]').first().attr('src') ?? null,
    };
};

/** WP Recipe Maker — the plugin behind a large share of WordPress food blogs.
 *  Its markup splits amount/unit/name into spans, which we simply re-join: the
 *  ingredient parser is better at reading "2 šaukštai aliejaus" than we are at
 *  trusting three CSS classes to always be present. */
const fromWprm = ($: cheerio.CheerioAPI): RawRecipe | null => {
    const rows = $('.wprm-recipe-ingredient').toArray();
    if (rows.length === 0) return null;
    const ingredients = rows.map(el => cleanText($(el).text())).filter(Boolean);
    if (ingredients.length === 0) return null;
    return {
        title: cleanText($('.wprm-recipe-name').first().text()),
        ingredients,
        servings: parseServings($('.wprm-recipe-servings').first().text()),
        image: $('.wprm-recipe-image img').first().attr('src') ?? null,
    };
};

/** Hydration blobs: `__NEXT_DATA__`, `__NUXT__`, or any inline JSON carrying a
 *  recipeIngredient key. Sites that render client-side keep the recipe here. */
const fromHydrationBlob = ($: cheerio.CheerioAPI): RawRecipe | null => {
    const scripts = $('script').toArray();
    for (const el of scripts) {
        const text = $(el).text();
        if (!text.includes('recipeIngredient') && !text.includes('"ingredients"')) continue;
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) continue;
        const data = parseLooseJson(text.slice(start, end + 1));
        if (!data) continue;
        for (const node of walkNodes(data)) {
            const ingredients = asStringList(node.recipeIngredient ?? node.ingredients);
            if (ingredients.length < 2) continue;   // one string is usually a label, not a list
            return {
                title: cleanText(typeof node.name === 'string' ? node.name
                    : typeof node.title === 'string' ? node.title : ''),
                ingredients,
                servings: parseServings(node.recipeYield ?? node.servings ?? node.yield),
                image: firstImage(node.image),
            };
        }
    }
    return null;
};

const INGREDIENT_HEADING = /^(ingredientai|ingridientai|sudėtis|sudetis|reikės|reikes|produktai|ingredients)\b/i;

/** Last resort: an "Ingredients" heading followed by a list. Only trusted when
 *  the list looks like ingredients (short lines, mostly starting with a digit). */
const fromHeadingList = ($: cheerio.CheerioAPI): RawRecipe | null => {
    for (const h of $('h1,h2,h3,h4,strong,b').toArray()) {
        if (!INGREDIENT_HEADING.test(cleanText($(h).text()))) continue;
        const list = $(h).nextAll('ul,ol').first();
        if (!list.length) continue;
        const items = list.find('li').toArray().map(li => cleanText($(li).text())).filter(Boolean);
        if (items.length < 2) continue;
        const plausible = items.filter(s => s.length <= 120).length / items.length;
        const numbered = items.filter(s => /\d/.test(s)).length / items.length;
        if (plausible < 0.8 || numbered < 0.4) continue;
        return {
            title: cleanText($('h1').first().text()),
            ingredients: items,
            servings: null,
            image: null,
        };
    }
    return null;
};

/**
 * Lithuanian or English?
 *
 * `<html lang>` is authoritative when present and unambiguous, but plenty of
 * Lithuanian sites ship `lang="en"` from a theme default, so the ingredient
 * text gets a vote too: Lithuanian-specific letters (ąčęėįšųūž) and the unit
 * vocabulary are decisive, and no English recipe contains them.
 */
export const detectLang = (htmlLang: string | undefined, sample: string): Lang => {
    const lt = /[ąčęėįšųūž]/i.test(sample)
        || /\b(šaukšt|šaukštel|gramų|mililitrų|vienetas|vienetai|skiltelė|druskos|pagal skonį)/i.test(sample);
    if (lt) return 'lt';
    const declared = (htmlLang ?? '').slice(0, 2).toLowerCase();
    if (declared === 'lt') return 'lt';
    return 'en';
};

/**
 * receptai.lt sells the last slot of its ingredient <ul> to an advertiser:
 * "Geriausias ingredientų kainas tikrink - akcijos.lt" sits as a sibling <li>
 * of the real ingredients, so the DOM rung (or any other that reads the list)
 * swallows it whole — and a price-comparison advert reached two baskets as an
 * "ingredient" on the 180-recipe sweep. A line is dropped only when it BOTH
 * names a bare domain and talks prices/deals: an ingredient naming a brand
 * ("Pikant fix", „dansukker“) has neither and must survive.
 */
const PROMO_DOMAIN_RE = /(?<![\p{L}\d.])[\p{L}\d-]{2,}\.(?:lt|com|eu|net|org)(?![\p{L}\d])/iu;
const PROMO_PITCH_RE = /(?<![\p{L}])(?:kain\p{L}*|akcij\p{L}*|nuolaid\p{L}*|tikrink\p{L}*|prices?|deals?|discounts?)(?![\p{L}])/iu;

const isPromoLine = (s: string): boolean => PROMO_DOMAIN_RE.test(s) && PROMO_PITCH_RE.test(s);

/**
 * Pull a recipe out of a page. Pure — give it stored HTML and it behaves
 * exactly as it does live, which is what makes the fixture corpus meaningful.
 */
export const extractRecipe = (html: string, sourceUrl: string): ScrapedRecipe => {
    const $ = cheerio.load(html);
    const ladder: [Extractor, (c: cheerio.CheerioAPI) => RawRecipe | null][] = [
        ['jsonld', fromJsonLd],
        ['microdata', fromMicrodata],
        ['wprm', fromWprm],
        ['nextdata', fromHydrationBlob],
        ['dom', fromHeadingList],
    ];

    for (const [extractor, fn] of ladder) {
        const raw = fn($);
        if (!raw || raw.ingredients.length === 0) continue;
        // The advert filter runs before the rung is accepted: a list that was
        // NOTHING but adverts is not a recipe, and a lower rung deserves a try.
        const ingredientLines = dedupe(raw.ingredients).filter(l => !isPromoLine(l));
        if (ingredientLines.length === 0) continue;

        const title = raw.title || cleanText($('h1').first().text())
            || cleanText($('title').first().text()) || 'Receptas';
        let site = '';
        try { site = new URL(sourceUrl).hostname.replace(/^www\./, ''); } catch { /* keep '' */ }

        return {
            sourceUrl,
            site,
            title,
            imageUrl: absoluteUrl(raw.image ?? ogImage($), sourceUrl),
            servings: raw.servings,
            // A site occasionally repeats a line (a section header printed in
            // both the summary and the detail block); the shopper should not
            // see it twice. Deduped and advert-filtered above.
            ingredientLines,
            lang: detectLang($('html').attr('lang'), raw.ingredients.join(' ')),
            extractor,
        };
    }
    throw new RecipeParseError();
};

const ogImage = ($: cheerio.CheerioAPI): string | null =>
    $('meta[property="og:image"]').attr('content')
    ?? $('meta[name="twitter:image"]').attr('content')
    ?? null;

const absoluteUrl = (raw: string | null, base: string): string | null => {
    if (!raw) return null;
    try { return new URL(raw, base).toString(); } catch { return null; }
};

const dedupe = (lines: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of lines) {
        const k = l.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(l);
    }
    return out;
};
