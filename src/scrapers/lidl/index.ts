import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Page } from 'playwright';
import { upsertPromo } from '../shared/promoUpsert.js';
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
    promoEnd: Date;
    requiresCoupon: boolean;
    productId: number;
}

function isLidlPlusCoupon(lp: any): boolean {
    const texts = [lp?.highlightText, lp?.lidlPlusText, lp?.coupon?.discountText, lp?.price?.discount?.discountText]
        .filter(Boolean).join(' ');
    return /kupon/i.test(texts);
}

function parseGridData(raw: any): LidlProduct | null {
    if (!raw?.havingPrice) return null;
    const name = (raw.fullTitle as string | undefined)?.trim();
    if (!name) return null;

    const imageUrl = (raw.image as string | null) ?? null;
    const validUntilTs: number | undefined =
        raw.stockAvailability?.badgeInfoV2?.[0]?.validUntil ?? raw.storeEndDate;
    if (!validUntilTs) return null;
    const promoEnd = new Date(validUntilTs * 1000);
    const productId = raw.productId as number;

    const p = raw.price;

    // Regular discount: price.price is promo, price.discount.deletedPrice is regular
    if (p?.price > 0 && p?.discount?.deletedPrice > 0 && p?.discount?.showDiscount) {
        if (p.price >= p.discount.deletedPrice) return null;
        return {
            name, imageUrl, promoEnd, productId,
            regularPrice: p.discount.deletedPrice,
            promoPrice: p.price,
            requiresCoupon: false,
            basePriceText: p.basePrice?.text ?? '',
        };
    }

    // Lidl Plus discount (with or without coupon)
    const lp = (raw.lidlPlus as any[] | undefined)?.[0];
    if (lp?.price?.price > 0 && lp?.price?.discount?.deletedPrice > 0) {
        if (lp.price.price >= lp.price.discount.deletedPrice) return null;
        return {
            name, imageUrl, promoEnd, productId,
            regularPrice: lp.price.discount.deletedPrice,
            promoPrice: lp.price.price,
            requiresCoupon: isLidlPlusCoupon(lp),
            basePriceText: lp.price.basePrice?.text ?? p?.basePrice?.text ?? '',
        };
    }

    // Super Kaina: has price + validity window but no comparison/deleted price.
    // Store as a normal (non-discounted) price observation so the product is
    // still tracked; the UI won't show it as a sale because promoPrice is null.
    if (p?.price > 0) {
        return {
            name, imageUrl, promoEnd, productId,
            regularPrice: p.price,
            promoPrice: null,
            requiresCoupon: false,
            basePriceText: p.basePrice?.text ?? '',
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

async function scrapeUrl(page: Page, url: string): Promise<any[]> {
    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        // One click of "Rodyti daugiau" loads all remaining items for the page
        const btn = await page.$('button:has-text("Rodyti daugiau")');
        if (btn) {
            await btn.click();
            await page.waitForTimeout(2500);
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

async function fetchAllProducts(): Promise<LidlProduct[]> {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();

        const categoryUrls = await discoverCategoryUrls(page);
        console.log(`[Lidl] Scraping ${categoryUrls.length} category URLs…`);

        const byId = new Map<number, LidlProduct>();

        for (const url of categoryUrls) {
            const rawItems = await scrapeUrl(page, url);
            if (!rawItems.length) continue;

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

        return Array.from(byId.values());
    } finally {
        await browser.close();
    }
}

export async function runLidlPromoScraper(): Promise<void> {
    console.log('[Lidl] Starting promo scrape…');
    const c: Counters = { inserted: 0, skipped: 0, spCreated: 0, productCreated: 0, parseErrors: 0 };

    try {
        const products = await fetchAllProducts();
        console.log(`[Lidl] ${products.length} discounted products across all categories`);

        for (let i = 0; i < products.length; i++) {
            const item = products[i];
            try {
                const sizes = extractLidlSizes(item.basePriceText, {
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
                        promoEnd: item.promoEnd,
                        requiresCoupon: item.requiresCoupon,
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
