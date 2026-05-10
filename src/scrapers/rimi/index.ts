import * as cheerio from 'cheerio';
import { parseSize } from '../shared/parseSize.js';
import { upsertPromo } from '../shared/promoUpsert.js';
import { notifyTelegram } from '../shared/telegramAlert.js';

const RIMI_CHAIN_ID = 2;

// Rimi weekly promos run Monday–Monday (e.g. 28.04–11.05 includes that Monday).
// promoEnd = next Monday at 23:59:59.
function getWeekEnd(): Date {
    const d = new Date();
    const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(23, 59, 59, 0);
    return d;
}

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'lt-LT,lt;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

const PAGE_SIZE = 80;

async function fetchPage(pageNum: number): Promise<string> {
    const url = `https://www.rimi.lt/e-parduotuve/lt/akcijos?currentPage=${pageNum}&pageSize=${PAGE_SIZE}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${pageNum}`);
    return res.text();
}

function getTotalPages(html: string): number {
    const $ = cheerio.load(html);
    let max = 1;
    $('[data-page]').each((_, el) => {
        const n = parseInt($(el).attr('data-page') ?? '1', 10);
        if (n > max) max = n;
    });
    return max;
}

interface ScrapedProduct {
    name: string;
    imageUrl: string | null;
    regularPrice: number;
    promoPrice: number;
}

// Extract a euro price from sr-only text like "1.79 € per kg" or "1,99 €"
function parseSrOnly(text: string): number | null {
    const m = text.match(/([\d]+[.,][\d]+|[\d]+)\s*€/);
    if (!m) return null;
    const val = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(val) && val > 0 ? val : null;
}

// Build major.cents from separate span elements (Rimi card price layout)
function parseMajorCents($el: cheerio.CheerioAPI, scope: cheerio.Cheerio<any>): number | null {
    const major = scope.find('.major').first().text().trim();
    const cents = scope.find('.cents').first().text().trim();
    if (!major) return null;
    const val = parseFloat(`${major}.${cents.padStart(2, '0')}`);
    return Number.isFinite(val) && val > 0 ? val : null;
}

function parseProducts(html: string): ScrapedProduct[] {
    const $ = cheerio.load(html);
    const products: ScrapedProduct[] = [];

    $('li.product-grid__item').each((_, el) => {
        const card = $(el);
        const container = card.find('[data-product-code]').first();
        if (!container.length) return;

        // Name — prefer GTM JSON (cleaned), fall back to visible text
        let name = '';
        try {
            const gtm = JSON.parse(container.attr('data-gtm-eec-product') ?? '');
            name = gtm?.name ?? '';
        } catch {}
        if (!name) name = card.find('.card__name').first().text().trim();
        if (!name) return;

        // Image — lazy-loaded src is in data-src; skip KGM_LT fallback placeholder
        const imgEl = card.find('.card__image-wrapper img, img.card__image').first();
        const rawImg = imgEl.attr('data-src') || imgEl.attr('src') || null;
        const imageUrl = rawImg && !rawImg.includes('KGM_LT') ? rawImg : null;

        // ── Price parsing ────────────────────────────────────────────────────
        // Rimi promo page has two layouts:
        //
        //  Type A — Rimi loyalty card price:
        //    .price-label holds the card price (major + cents)
        //    .price-tag.card__price .sr-only holds the regular shelf price
        //
        //  Type B — Plain markdown (crossed-out price):
        //    .card__price-wrapper.-has-discount
        //      .price-tag.card__price .sr-only  → current (promo) price
        //      .old-price-tag .sr-only           → original price
        //
        // Both types require regularPrice AND promoPrice; skip if either is missing.

        let regularPrice: number | null = null;
        let promoPrice: number | null = null;

        const hasDiscount = card.find('.card__price-wrapper.-has-discount').length > 0;
        const priceLabel  = card.find('.price-label').first();

        if (hasDiscount) {
            promoPrice   = parseSrOnly(card.find('.price-tag.card__price .sr-only').first().text());
            regularPrice = parseSrOnly(card.find('.old-price-tag .sr-only, .card__old-price .sr-only').first().text());
        } else if (priceLabel.length) {
            promoPrice   = parseMajorCents($, priceLabel);
            regularPrice = parseSrOnly(card.find('.price-tag.card__price .sr-only').first().text());
        }

        if (!regularPrice || !promoPrice) return; // no concrete prices — skip
        if (promoPrice >= regularPrice) return;    // sanity: promo must be cheaper

        products.push({ name, imageUrl, regularPrice, promoPrice });
    });

    return products;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function runRimiPromoScraper(): Promise<void> {
    console.log('[Rimi] Starting promo scrape…');
    const promoEnd = getWeekEnd();
    let inserted = 0, skipped = 0, spCreated = 0, productCreated = 0, parseErrors = 0;

    try {
        const firstHtml = await fetchPage(1);
        const totalPages = getTotalPages(firstHtml);
        console.log(`[Rimi] ${totalPages} pages`);

        const htmlPages = [firstHtml];
        for (let p = 2; p <= totalPages; p++) {
            await delay(1000 + Math.random() * 1500);
            htmlPages.push(await fetchPage(p));
            if (p % 20 === 0) console.log(`[Rimi] fetched ${p}/${totalPages} pages`);
        }

        // Flatten all pages into one list so we can log progress by product count
        const allProducts = htmlPages.flatMap(parseProducts);
        console.log(`[Rimi] ${allProducts.length} promo products to process`);

        for (let i = 0; i < allProducts.length; i++) {
            const item = allProducts[i];
            try {
                const { storeProductName, amount, unit, isWeighable } = parseSize(item.name);
                const result = await upsertPromo({
                    chainId: RIMI_CHAIN_ID,
                    storeProductName,
                    amount,
                    unit,
                    isWeighable,
                    imageUrl: item.imageUrl,
                    regularPrice: item.regularPrice,
                    promoPrice: item.promoPrice,
                    promoEnd,
                });
                if (result === 'skipped')              skipped++;
                else if (result === 'sp_created')      spCreated++;
                else if (result === 'product_created') { spCreated++; productCreated++; }
                else inserted++;
            } catch (e: any) {
                parseErrors++;
                console.warn(`[Rimi] upsert failed for "${item.name}": ${e.message}`);
            }
            if ((i + 1) % 200 === 0) {
                console.log(`[Rimi] processed ${i + 1}/${allProducts.length} — inserted: ${inserted}, skipped: ${skipped}, errors: ${parseErrors}`);
            }
        }

        const summary = `[Rimi] Done — inserted: ${inserted}, skipped: ${skipped}, new SPs: ${spCreated}, new Products: ${productCreated}, errors: ${parseErrors}`;
        console.log(summary);

        const errorNote = parseErrors > 0 ? `\n⚠️ ${parseErrors} upsert errors — check logs` : '';
        await notifyTelegram(
            `✅ <b>Rimi</b> scrape done\n` +
            `📦 Inserted: ${inserted}\n` +
            `⏭ Skipped: ${skipped}\n` +
            `🆕 New SPs: ${spCreated} (${productCreated} new Products)\n` +
            `🗓 promoEnd: ${promoEnd.toISOString().slice(0, 10)}` +
            errorNote,
        );
    } catch (e: any) {
        const msg = `🚨 <b>Rimi</b> scraper failed\n${(e as Error).message}`;
        console.error(msg);
        await notifyTelegram(msg);
        throw e;
    }
}
