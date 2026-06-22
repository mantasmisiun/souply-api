import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { parseSize } from '../shared/parseSize.js';
import { upsertPromo } from '../shared/promoUpsert.js';
import { notifyTelegram } from '../shared/telegramAlert.js';

chromium.use(StealthPlugin());

const BARBORA_CHAIN_ID = 1;   // Maxima LT — Barbora is Maxima's online platform

const BASE_URL = 'https://barbora.lt';
const OFFERS_URL = `${BASE_URL}/aciu-akcijos`;

interface BarboraProduct {
    id: string;
    title: string;
    price?: number;
    retail_price?: number;
    image?: string;
    big_image?: string;
    ShowInOffersTo?: string;
    units?: Array<{ price?: number; retail_price?: number }>;
}

function extractFromHtml(html: string): BarboraProduct[] {
    const m = html.match(/window\.b_productList\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
    if (!m) return [];
    try { return JSON.parse(m[1]) as BarboraProduct[]; } catch { return []; }
}

function extractSubcategorySlugs(html: string): string[] {
    const matches = [...html.matchAll(/href="\/aciu-akcijos\/([^"/?]+)"/g)];
    return [...new Set(matches.map(m => m[1]))];
}

async function fetchAllProducts(): Promise<BarboraProduct[]> {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();

        // Main page — also gets us past Cloudflare for subsequent navigations.
        // Rocket Loader defers inline scripts; wait for sidebar links to appear.
        await page.goto(OFFERS_URL, { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction(
            () => document.querySelector('a.category-item--title') !== null,
            { timeout: 15000 },
        ).catch(() => {}); // continue even if sidebar never appears
        let html = await page.content();

        const byId = new Map<string, BarboraProduct>();
        extractFromHtml(html).forEach(p => byId.set(p.id, p));

        const slugs = extractSubcategorySlugs(html);
        console.log(`[Barbora] Main page: ${byId.size} products, ${slugs.length} subcategories`);

        for (const slug of slugs) {
            await page.goto(`${BASE_URL}/aciu-akcijos/${slug}`, { waitUntil: 'load', timeout: 30000 });
            html = await page.content();
            const before = byId.size;
            extractFromHtml(html).forEach(p => { if (!byId.has(p.id)) byId.set(p.id, p); });
            console.log(`[Barbora]   ${slug}: +${byId.size - before} new (${byId.size} total)`);
        }

        return Array.from(byId.values());
    } finally {
        await browser.close();
    }
}

interface PricedProduct {
    raw: BarboraProduct;
    promoPrice: number;
    regularPrice: number;
    promoEnd: Date;
    imageUrl: string | null;
}

function resolvePrice(p: BarboraProduct): PricedProduct | null {
    if (!p.ShowInOffersTo) return null;

    const promoEnd = new Date(p.ShowInOffersTo);
    if (!Number.isFinite(promoEnd.getTime())) return null;

    // Price may be at top level or in units[0]
    const promoPrice = p.price ?? p.units?.[0]?.price ?? 0;
    const regularPrice = p.retail_price ?? p.units?.[0]?.retail_price ?? 0;

    if (promoPrice <= 0 || regularPrice <= 0 || promoPrice >= regularPrice) return null;

    return {
        raw: p,
        promoPrice,
        regularPrice,
        promoEnd,
        imageUrl: p.big_image ?? p.image ?? null,
    };
}

export async function runBarboraPromoScraper(): Promise<void> {
    console.log('[Barbora] Starting promo scrape…');
    let inserted = 0, skipped = 0, spCreated = 0, productCreated = 0, parseErrors = 0;

    try {
        const allRaw = await fetchAllProducts();
        const products = allRaw.map(resolvePrice).filter((p): p is PricedProduct => p !== null);
        console.log(`[Barbora] ${allRaw.length} total, ${products.length} with valid promo price`);

        for (let i = 0; i < products.length; i++) {
            const item = products[i];
            try {
                const { storeProductName, amount, unit, isWeighable } = parseSize(item.raw.title);
                const result = await upsertPromo({
                    chainId: BARBORA_CHAIN_ID,
                    storeProductName,
                    amount,
                    unit,
                    isWeighable,
                    imageUrl: item.imageUrl,
                    regularPrice: item.regularPrice,
                    promoPrice: item.promoPrice,
                    promoEnd: item.promoEnd,
                });
                if (result === 'skipped')              skipped++;
                else if (result === 'sp_created')      spCreated++;
                else if (result === 'product_created') { spCreated++; productCreated++; }
                else inserted++;
            } catch (e: any) {
                parseErrors++;
                console.warn(`[Barbora] upsert failed for "${item.raw.title}": ${e.message}`);
            }
            if ((i + 1) % 50 === 0) {
                console.log(`[Barbora] processed ${i + 1}/${products.length} — inserted: ${inserted}, skipped: ${skipped}, errors: ${parseErrors}`);
            }
        }

        const summary = `[Barbora] Done — inserted: ${inserted}, skipped: ${skipped}, new SPs: ${spCreated}, new Products: ${productCreated}, errors: ${parseErrors}`;
        console.log(summary);

        const errorNote = parseErrors > 0 ? `\n⚠️ ${parseErrors} upsert errors — check logs` : '';
        await notifyTelegram(
            `✅ <b>Barbora</b> scrape done\n` +
            `📦 Inserted: ${inserted}\n` +
            `⏭ Skipped: ${skipped}\n` +
            `🆕 New SPs: ${spCreated} (${productCreated} new Products)\n` +
            errorNote,
        );
    } catch (e: any) {
        // Failure alerting is owned by runScraperWithRetry — surface + rethrow.
        console.error(`[Barbora] scrape failed: ${(e as Error).message}`);
        throw e;
    }
}
