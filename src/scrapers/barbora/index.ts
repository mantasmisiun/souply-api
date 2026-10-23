import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Page } from 'playwright';
import { parseSize } from '../shared/parseSize.js';
import { upsertPromo } from '../shared/promoUpsert.js';
import { joinBrand } from '../shared/net.js';
import { notifyTelegram } from '../shared/telegramAlert.js';

chromium.use(StealthPlugin());

const BARBORA_CHAIN_ID = 1;   // Maxima LT — Barbora is Maxima's online platform

const BASE_URL = 'https://barbora.lt';
const OFFERS_URL = `${BASE_URL}/aciu-akcijos`;

interface BarboraProduct {
    id: string;
    title: string;
    brand_name?: string | null;
    price?: number;
    retail_price?: number;
    image?: string;
    big_image?: string;
    ShowInOffersTo?: string;
    category_name_full_path?: string | null;
    comparative_unit?: string | null;          // "kg" | "l" | "vnt" …
    comparative_unit_price?: number | null;    // € per comparative unit (current price)
    units?: Array<{ price?: number; retail_price?: number }>;
}

/** One quick retry on a transient navigation failure — a single blip shouldn't
 *  drop a subcategory (the outer runScraperWithRetry layer waits 1h). */
async function gotoWithRetry(page: Page, url: string, timeout: number): Promise<void> {
    try {
        await page.goto(url, { waitUntil: 'load', timeout });
    } catch {
        await page.waitForTimeout(1500);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    }
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

export async function fetchAllProducts(): Promise<BarboraProduct[]> {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();

        // Main page — also gets us past Cloudflare for subsequent navigations.
        // Rocket Loader defers inline scripts; wait for sidebar links to appear.
        await gotoWithRetry(page, OFFERS_URL, 60000);
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
            await gotoWithRetry(page, `${BASE_URL}/aciu-akcijos/${slug}`, 30000);
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
    siteCategory: string | null;
    /** Pack size derived from €/kg|€/l comparative price when the title has none. */
    derivedAmount: number | null;
    derivedUnit: string | null;
}

export function resolvePrice(p: BarboraProduct): PricedProduct | null {
    if (!p.ShowInOffersTo) return null;

    const promoEnd = new Date(p.ShowInOffersTo);
    if (!Number.isFinite(promoEnd.getTime())) return null;

    // Price may be at top level or in units[0]
    const promoPrice = p.price ?? p.units?.[0]?.price ?? 0;
    const regularPrice = p.retail_price ?? p.units?.[0]?.retail_price ?? 0;

    if (promoPrice <= 0 || regularPrice <= 0 || promoPrice >= regularPrice) return null;

    // Pack size from the comparative price (€/kg, €/l): amount = price / rate.
    // Only trusted within sane grocery bounds; the CURRENT price is the promo
    // price on the offers page, so divide promo by the comparative rate.
    let derivedAmount: number | null = null;
    let derivedUnit: string | null = null;
    const compUnit = (p.comparative_unit ?? '').toLowerCase();
    const rate = p.comparative_unit_price ?? 0;
    if ((compUnit === 'kg' || compUnit === 'l') && rate > 0) {
        const qty = promoPrice / rate; // in kg or l
        if (qty >= 0.005 && qty <= 25) {
            if (qty < 1) { derivedAmount = Math.round(qty * 1000); derivedUnit = compUnit === 'kg' ? 'g' : 'ml'; }
            else { derivedAmount = +qty.toFixed(3); derivedUnit = compUnit; }
        }
    }

    return {
        raw: p,
        promoPrice,
        regularPrice,
        promoEnd,
        imageUrl: p.big_image ?? p.image ?? null,
        siteCategory: (p.category_name_full_path ?? null)?.slice(0, 255) ?? null,
        derivedAmount,
        derivedUnit,
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
                // Brand into the name (dedup-safe) — same convention as Lidl.
                const parsed = parseSize(joinBrand(item.raw.brand_name, item.raw.title));
                let { amount, unit } = parsed;
                // Comparative-price size only fills a MISSING size — never overrides
                // one parsed from the title (title is authoritative).
                if (amount == null && item.derivedAmount != null) {
                    amount = item.derivedAmount; unit = item.derivedUnit;
                }
                const result = await upsertPromo({
                    chainId: BARBORA_CHAIN_ID,
                    storeProductName: parsed.storeProductName,
                    amount,
                    unit,
                    isWeighable: parsed.isWeighable,
                    imageUrl: item.imageUrl,
                    siteCategory: item.siteCategory,
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
