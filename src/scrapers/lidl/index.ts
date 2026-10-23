import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Page } from 'playwright';
import { upsertPromo } from '../shared/promoUpsert.js';
import { joinBrand as joinBrandShared } from '../shared/net.js';
import { notifyTelegram } from '../shared/telegramAlert.js';
import { extractLidlSizes } from './parseLidlProduct.js';

chromium.use(StealthPlugin());

const LIDL_CHAIN_ID = 5;
const BASE_URL = 'https://www.lidl.lt';

// Hub pages that expose /a{digits} product sub-category links when JS-rendered.
// Homepage catches campaign banners; these catch permanent sub-categories and
// themed pages (Japanese cuisine, French flavours, etc.) not shown on the homepage.
const CATEGORY_HUBS = [
    '/c/kainu-leidiniai/s10020254',                    // offers / promo hub
    '/c/maistas-gerimai-ir-buities-prekes/s10068374',  // food & drinks
    '/c/virtuve-ir-buitis/s10068166',                  // kitchen & household
    '/c/sodas-ir-dirbtuves/s10068222',                 // garden & workshop
    '/c/sportas-ir-laisvalaikis/s10068226',            // sports & leisure
    '/c/namai-ir-interjeras/s10068371',                // home & interior
    '/c/apranga-ir-aksesuarai/s10068373',              // clothing
    '/c/prekes-vaikams-ir-kudikiams-zaislai/s10068225',// kids
    '/c/alkoholiniai-gerimai/s10019968',               // alcohol
    '/c/jubiliejus/s10092396',                         // anniversary promos
];

interface LidlProduct {
    name: string;
    basePriceText: string;
    imageUrl: string | null;
    regularPrice: number;
    promoPrice: number | null; // null = Super Kaina (no comparison price)
    promoStart: Date | null;   // window open (future promos scraped early); null = already active
    promoEnd: Date;
    requiresCoupon: boolean;
    productId: number;
    /** Pre-derived size (gridbox tiles: from €/kg) — bypasses extractLidlSizes. */
    directSize?: { amount: number | null; unit: string | null; isWeighable: boolean };
    /** ERP item code (gridbox detail page) — same code space as leaflet + receipts. */
    itemCode?: string | null;
    /** Website names are authoritative (leaflet typos self-heal against them). */
    nameAuthority?: boolean;
    /**
     * Verbatim offer badge from `price.discount.discountText` — the CONDITION,
     * which nothing else carries. Observed values (2026-08-17, 210 tiles):
     * multi-buy "3 už" / "5 už", percentages "-33%", labels "Super kaina" /
     * "SUMAŽINTA", and occasionally size text that leaks into the same field.
     *
     * A multi-buy tile prices the WHOLE BUNDLE: "3 už" + price 2.00 +
     * basePrice "3 x 95 g / 1 kg = 7,05 €" means three croissants for €2, and
     * extractLidlSizes correctly derives 285 g so €/kg stays right. What the
     * shopper still needs is that buying ONE does not get this price.
     */
    offerText?: string | null;
    /** `price.discount.percentageDiscount` — Lidl's own figure, not derived. */
    offerPct?: number | null;
    /** True when the price came from the Lidl Plus branch (card required). */
    isLidlPlus?: boolean;
}

/** Offer badge, preferring the branch the price was actually read from. */
function offerTextOf(node: any): string | null {
    const t = node?.discount?.discountText ?? node?.price?.discount?.discountText;
    return typeof t === 'string' && t.trim() ? t.trim().replace(/\s+/g, ' ') : null;
}
function offerPctOf(node: any): number | null {
    const n = node?.discount?.percentageDiscount ?? node?.price?.discount?.percentageDiscount;
    return typeof n === 'number' && n > 0 ? n : null;
}

/** Prepend the chain-declared brand to the title unless it's already there. The
 *  brand is a strong matcher signal (we store it in the name, not a column). */
function joinBrand(brand: any, name: string): string {
    const b = brand?.showBrand && typeof brand?.name === 'string' ? brand.name : null;
    return joinBrandShared(b, name);
}

function isLidlPlusCoupon(lp: any): boolean {
    const texts = [lp?.highlightText, lp?.lidlPlusText, lp?.coupon?.discountText, lp?.price?.discount?.discountText]
        .filter(Boolean).join(' ');
    return /kupon/i.test(texts);
}

function parseGridData(raw: any): LidlProduct | null {
    if (!raw?.havingPrice) return null;
    const rawName = (raw.fullTitle as string | undefined)?.trim();
    if (!rawName) return null;
    const name = joinBrand(raw.brand, rawName);

    const imageUrl = (raw.image as string | null) ?? null;
    const badge = raw.stockAvailability?.badgeInfoV2?.[0];
    const validUntilTs: number | undefined = badge?.validUntil ?? raw.storeEndDate;
    if (!validUntilTs) return null;
    const promoEnd = new Date(validUntilTs * 1000);
    // Window OPEN — a promo/price scraped before it starts (Lidl staggers the
    // week). Null when already active; the calc shows the regular price until it.
    const validFromTs: number | undefined = badge?.validFrom ?? raw.storeStartDate;
    const promoStart = validFromTs && validFromTs * 1000 > Date.now() ? new Date(validFromTs * 1000) : null;
    const productId = raw.productId as number;

    const p = raw.price;

    // Regular discount: price.price is promo, price.discount.deletedPrice is regular
    if (p?.price > 0 && p?.discount?.deletedPrice > 0 && p?.discount?.showDiscount) {
        if (p.price >= p.discount.deletedPrice) return null;
        return {
            name, imageUrl, promoStart, promoEnd, productId,
            regularPrice: p.discount.deletedPrice,
            promoPrice: p.price,
            requiresCoupon: false,
            basePriceText: p.basePrice?.text ?? '',
            offerText: offerTextOf(p), offerPct: offerPctOf(p), isLidlPlus: false,
        };
    }

    // Lidl Plus discount (with or without coupon)
    const lp = (raw.lidlPlus as any[] | undefined)?.[0];
    if (lp?.price?.price > 0 && lp?.price?.discount?.deletedPrice > 0) {
        if (lp.price.price >= lp.price.discount.deletedPrice) return null;
        return {
            name, imageUrl, promoStart, promoEnd, productId,
            regularPrice: lp.price.discount.deletedPrice,
            promoPrice: lp.price.price,
            requiresCoupon: isLidlPlusCoupon(lp),
            basePriceText: lp.price.basePrice?.text ?? p?.basePrice?.text ?? '',
            offerText: offerTextOf(lp.price) ?? offerTextOf(p),
            offerPct: offerPctOf(lp.price) ?? offerPctOf(p),
            isLidlPlus: true,
        };
    }

    // Super Kaina: has price + validity window but no comparison/deleted price.
    // Store as a normal (non-discounted) price observation so the product is
    // still tracked; the UI won't show it as a sale because promoPrice is null.
    if (p?.price > 0) {
        return {
            name, imageUrl, promoStart, promoEnd, productId,
            regularPrice: p.price,
            promoPrice: null,
            requiresCoupon: false,
            basePriceText: p.basePrice?.text ?? '',
            offerText: offerTextOf(p), offerPct: offerPctOf(p), isLidlPlus: false,
        };
    }

    return null; // no usable price data
}

async function collectItems(page: Page): Promise<any[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-grid-data]')).map(d => {
            try { return JSON.parse(d.getAttribute('data-grid-data')!); } catch { return null; }
        }).filter(Boolean),
    );
}

interface GridBoxRaw { webId: string; name: string; price: number; href: string | null; img: string | null; text: string; }

/** The SECOND product tile type ("product-grid-box", e.g. the Superiniai fresh
 *  offers — Šilauogės). NOT in [data-grid-data]; tile text carries prices,
 *  €/kg and the window; the detail page carries the ERP item code. */
async function collectGridBoxes(page: Page): Promise<GridBoxRaw[]> {
    return page.evaluate(() => {
        const out: any[] = [];
        for (const b of Array.from(document.querySelectorAll('[data-gridbox-impression]'))) {
            try {
                const imp = JSON.parse(decodeURIComponent(b.getAttribute('data-gridbox-impression') ?? ''));
                if (!imp?.name || typeof imp.price !== 'number') continue;
                const a = b.querySelector('a[href]');
                const img = b.querySelector('img');
                out.push({
                    webId: String(imp.id ?? ''),
                    name: String(imp.name),
                    price: Number(imp.price),
                    href: a?.getAttribute('href') ?? null,
                    img: img?.getAttribute('src') ?? img?.getAttribute('data-src') ?? null,
                    text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
                });
            } catch { /* skip malformed tile */ }
        }
        return out;
    });
}

/** Parse a gridbox tile into a LidlProduct. Self-validating like the leaflet:
 *  a printed -N% must agree with the price pair, €/kg derives the pack size. */
function parseGridBox(raw: GridBoxRaw): LidlProduct | null {
    const promo = raw.price;
    if (!promo || promo <= 0) return null;
    const perKgM = raw.text.match(/1\s*(kg|l)\s*=\s*(\d+[.,]\d+)\s*€/i);
    const perKg = perKgM ? parseFloat(perKgM[2].replace(',', '.')) : null;
    const pctM = raw.text.match(/-(\d+)\s*[%﹪]/);
    const winM = raw.text.match(/(\d{2})\s+(\d{2})\s*[-–]\s*(\d{2})\s+(\d{2})/);
    // candidate old price: a €-suffixed number that is neither promo nor €/kg
    const nums = [...raw.text.matchAll(/(\d+[.,]\d{2})\s*€/g)].map(m => parseFloat(m[1].replace(',', '.')));
    const old = nums.find(n => Math.abs(n - promo) > 0.005 && (perKg == null || Math.abs(n - perKg) > 0.005) && n > promo) ?? null;
    if (old != null && pctM) {
        const implied = (1 - promo / old) * 100;
        if (Math.abs(implied - Number(pctM[1])) > 8) return null; // mispaired — never insert
    }
    // window (year from now; scraper runs within the flyer week)
    let promoStart: Date | null = null;
    let promoEnd: Date | null = null;
    if (winM) {
        const now = new Date();
        promoEnd = new Date(now.getFullYear(), +winM[3] - 1, +winM[4], 23, 59, 59);
        if (promoEnd < now) promoEnd.setFullYear(promoEnd.getFullYear() + 1);
        const s = new Date(promoEnd.getFullYear(), +winM[1] - 1, +winM[2], 0, 0, 0);
        if (s > promoEnd) s.setFullYear(s.getFullYear() - 1);
        promoStart = s > now ? s : null;
    }
    if (!promoEnd) return null; // no window — not a priced offer tile
    // pack size from €/kg|€/l (validated derivation, same rule as Barbora)
    let directSize: LidlProduct['directSize'] = { amount: null, unit: null, isWeighable: false };
    if (perKg && perKg > 0) {
        const qty = promo / perKg;
        if (qty >= 0.9 && qty <= 1.1) directSize = { amount: 1, unit: perKgM![1].toLowerCase(), isWeighable: perKgM![1].toLowerCase() === 'kg' };
        else if (qty >= 0.005 && qty <= 25) {
            const solid = perKgM![1].toLowerCase() === 'kg';
            directSize = { amount: Math.round(qty * 1000 / 5) * 5, unit: solid ? 'g' : 'ml', isWeighable: false };
        }
    }
    return {
        name: raw.name,
        basePriceText: '',
        imageUrl: raw.img,
        regularPrice: old ?? promo,
        promoPrice: old != null ? promo : null,
        promoStart,
        promoEnd,
        requiresCoupon: false,
        productId: Number(raw.webId) || 0,
        directSize,
        itemCode: null, // filled from the detail page
        nameAuthority: true,
    };
}

/** ERP item code from the product detail page's payload — anchored on the
 *  serialized `,"<code>",{"brand"` neighborhood (verified live). */
async function fetchErpCode(page: Page, href: string): Promise<string | null> {
    try {
        await gotoWithRetry(page, href.startsWith('http') ? href : BASE_URL + href, 30000);
        const html = await page.content();
        const m = html.match(/,"(\d{5,7})",\{"brand"/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/** goto with one retry — a single transient timeout shouldn't drop a whole page
 *  (which, on the weekly-offers page, can zero the run). */
async function gotoWithRetry(page: Page, url: string, timeout = 45000): Promise<void> {
    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout });
    } catch {
        await page.waitForTimeout(1500);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    }
}

async function scrapeUrl(page: Page, url: string): Promise<any[]> {
    try {
        await gotoWithRetry(page, url);
        // "Rodyti daugiau" — VERIFIED live 2026-07: on current lidl.lt it expands
        // the BROCHURE masonry grid (ux-masonry-grid__expander), NOT product rows;
        // clicking added +0 [data-grid-data]. All products load up-front. Keep a
        // GROWTH-GATED loop as insurance: click only while the product count
        // actually grows, so a future product-paginating layout is still covered
        // but today's no-op costs a single probe instead of 25 blind clicks.
        for (let i = 0; i < 25; i++) {
            const btn = await page.$('button:has-text("Rodyti daugiau")');
            if (!btn) break;
            const before = await page.evaluate(() => document.querySelectorAll('[data-grid-data]').length);
            await btn.click().catch(() => {});
            await page.waitForTimeout(1500);
            const after = await page.evaluate(() => document.querySelectorAll('[data-grid-data]').length);
            if (after <= before) break; // brochure expander, not product pagination
        }
        return collectItems(page);
    } catch (e: any) {
        console.warn(`[Lidl] Skipping ${url.replace(BASE_URL, '')}: ${e.message}`);
        return [];
    }
}

function collectLinks(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const found = new Set<string>();
        document.querySelectorAll<HTMLAnchorElement>('a[href^="/c/"]').forEach(a => {
            const href = a.getAttribute('href')!;
            if (!href.includes('?') && !href.includes('#') && /\/[as]\d+$/.test(href)) {
                found.add(href);
            }
        });
        return Array.from(found);
    });
}

async function discoverCategoryUrls(page: Page): Promise<string[]> {
    const seen = new Set<string>();

    // Homepage — campaign banner links (a{digits}) injected by JS
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    const homePaths = await collectLinks(page);
    for (const p of homePaths) seen.add(p);
    console.log(`[Lidl] Homepage → ${homePaths.length} links`);

    // Category hubs — each exposes permanent /a{digits} sub-categories
    // (themed pages like Japanese cuisine only appear here, not on the homepage)
    for (const hub of CATEGORY_HUBS) {
        try {
            await page.goto(BASE_URL + hub, { waitUntil: 'networkidle', timeout: 45000 });
            const paths = await collectLinks(page);
            const before = seen.size;
            for (const p of paths) seen.add(p);
            const added = seen.size - before;
            if (added > 0) console.log(`[Lidl] Hub ${hub} → +${added} new links`);
        } catch (e: any) {
            console.warn(`[Lidl] Hub discovery failed ${hub}: ${e.message}`);
        }
    }

    console.log(`[Lidl] Discovered ${seen.size} total category URLs`);
    return Array.from(seen).map(p => BASE_URL + p);
}

interface Counters {
    inserted: number;
    skipped: number;
    spCreated: number;
    productCreated: number;
    parseErrors: number;
}

export interface FetchOpts {
    /** Cap the number of category URLs scraped (dry-run / quick sampling). */
    limitCategories?: number;
    /** Skip discovery and scrape exactly these paths (e.g. ['/c/kainu-leidiniai/s10020254']). */
    overridePaths?: string[];
}

export async function fetchAllProducts(opts: FetchOpts = {}): Promise<LidlProduct[]> {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();

        let categoryUrls = opts.overridePaths?.length
            ? opts.overridePaths.map(p => (p.startsWith('http') ? p : BASE_URL + p))
            : await discoverCategoryUrls(page);
        if (opts.limitCategories && opts.limitCategories > 0) {
            categoryUrls = categoryUrls.slice(0, opts.limitCategories);
        }
        console.log(`[Lidl] Scraping ${categoryUrls.length} category URLs…`);

        const byId = new Map<number, LidlProduct>();
        const gridBoxes = new Map<string, GridBoxRaw>(); // webId → raw tile

        for (const url of categoryUrls) {
            const rawItems = await scrapeUrl(page, url);
            // second tile type (Superiniai fresh offers) on the same page
            for (const gb of await collectGridBoxes(page).catch(() => [] as GridBoxRaw[])) {
                if (gb.webId && !gridBoxes.has(gb.webId)) gridBoxes.set(gb.webId, gb);
            }
            if (!rawItems.length && !gridBoxes.size) continue;

            let added = 0;
            for (const raw of rawItems) {
                const product = parseGridData(raw);
                if (!product || byId.has(product.productId)) continue;
                byId.set(product.productId, product);
                added++;
            }
            if (added > 0) {
                console.log(`[Lidl] ${url.replace(BASE_URL, '')} → +${added} (${byId.size} total)`);
            }
        }

        // Parse gridbox tiles + fetch their ERP codes (one detail visit each).
        let gbAdded = 0;
        for (const gb of gridBoxes.values()) {
            const product = parseGridBox(gb);
            if (!product || byId.has(product.productId)) continue;
            if (gb.href) product.itemCode = await fetchErpCode(page, gb.href);
            byId.set(product.productId, product);
            gbAdded++;
        }
        if (gbAdded) console.log(`[Lidl] gridbox tiles → +${gbAdded} (${byId.size} total)`);

        return Array.from(byId.values());
    } finally {
        await browser.close();
    }
}

export async function runLidlPromoScraper(): Promise<void> {
    console.log('[Lidl] Starting promo scrape…');
    const c: Counters = { inserted: 0, skipped: 0, spCreated: 0, productCreated: 0, parseErrors: 0 };

    try {
        const products = await fetchAllProducts({});
        console.log(`[Lidl] ${products.length} discounted products across all categories`);

        for (let i = 0; i < products.length; i++) {
            const item = products[i];
            try {
                const sizes = item.directSize
                    ? [item.directSize]
                    : extractLidlSizes(item.basePriceText, {
                        promoPrice: item.promoPrice,
                        regularPrice: item.regularPrice,
                    });
                for (const { amount, unit, isWeighable } of sizes) {
                    const result = await upsertPromo({
                        chainId: LIDL_CHAIN_ID,
                        storeProductName: item.name,
                        amount,
                        unit,
                        isWeighable,
                        imageUrl: item.imageUrl,
                        regularPrice: item.regularPrice,
                        promoPrice: item.promoPrice,
                        promoStart: item.promoStart,
                        promoEnd: item.promoEnd,
                        requiresCoupon: item.requiresCoupon,
                        itemCodes: item.itemCode ? [item.itemCode] : undefined,
                        nameAuthority: item.nameAuthority,
                    });
                    if (result === 'skipped')              c.skipped++;
                    else if (result === 'sp_created')      c.spCreated++;
                    else if (result === 'product_created') { c.spCreated++; c.productCreated++; }
                    else                                   c.inserted++;
                }
            } catch (e: any) {
                c.parseErrors++;
                console.warn(`[Lidl] upsert failed for "${item.name}": ${e.message}`);
            }
            if ((i + 1) % 50 === 0) {
                console.log(`[Lidl] processed ${i + 1}/${products.length} — inserted: ${c.inserted}, skipped: ${c.skipped}, errors: ${c.parseErrors}`);
            }
        }

        const summary = `[Lidl] Done — inserted: ${c.inserted}, skipped: ${c.skipped}, new SPs: ${c.spCreated}, new Products: ${c.productCreated}, errors: ${c.parseErrors}`;
        console.log(summary);

        const errorNote = c.parseErrors > 0 ? `\n⚠️ ${c.parseErrors} upsert errors — check logs` : '';
        await notifyTelegram(
            `✅ <b>Lidl</b> scrape done\n` +
            `📦 Inserted: ${c.inserted}\n` +
            `⏭ Skipped: ${c.skipped}\n` +
            `🆕 New SPs: ${c.spCreated} (${c.productCreated} new Products)\n` +
            errorNote,
        );
    } catch (e: any) {
        // Failure alerting is owned by runScraperWithRetry — surface + rethrow.
        console.error(`[Lidl] scrape failed: ${(e as Error).message}`);
        throw e;
    }
}
