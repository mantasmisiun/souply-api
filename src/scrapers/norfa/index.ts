import * as cheerio from 'cheerio';
import { parseSize } from '../shared/parseSize.js';
import { upsertPromo, upsertPriceForSpId } from '../shared/promoUpsert.js';
import { fuzzyMatchSpMulti } from '../shared/productMatcher.js';
import { notifyTelegram } from '../shared/telegramAlert.js';
import { parseRusiai, expandVariants, expandMultiBrand } from './parseAggregated.js';

const NORFA_CHAIN_ID = 4;

const OFFERS_URL = 'https://www.norfa.lt/akciju-puslapiai/praktiski-pasiulymai/';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'lt-LT,lt;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
};

// "MM DD-MM DD" or "MM DD- MM DD" → end date at 23:59:59
function parsePromoEnd(moreInfoText: string): Date | null {
    const m = moreInfoText.match(/(\d{2})\s+(\d{2})\s*-\s*(\d{2})\s+(\d{2})/);
    if (!m) return null;
    const month = parseInt(m[3], 10) - 1;
    const day = parseInt(m[4], 10);
    const now = new Date();
    const d = new Date(now.getFullYear(), month, day, 23, 59, 59, 0);
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return d;
}

function parseEuroPrice(text: string): number | null {
    const m = text.match(/([\d]+[.,][\d]+|[\d]+)\s*€/);
    if (!m) return null;
    const val = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(val) && val > 0 ? val : null;
}

interface ScrapedProduct {
    name: string;
    imageUrl: string | null;
    regularPrice: number;
    promoPrice: number;
    promoEnd: Date;
}

function parseProducts(html: string): ScrapedProduct[] {
    const $ = cheerio.load(html);
    const products: ScrapedProduct[] = [];

    $('div.c-product.c-product--compact').each((_, el) => {
        const card = $(el);

        const name = card.find('.c-product__name').first().text().trim();
        if (!name) return;

        const oldPriceText = card.find('.c-product__old-price').first().text().trim();
        const regularPrice = parseEuroPrice(oldPriceText);
        if (!regularPrice) return;

        const promoPriceText = card.find('.c-product__price').first().text().trim();
        const promoPrice = parseEuroPrice(promoPriceText);
        if (!promoPrice || promoPrice >= regularPrice) return;

        const moreInfo = card.find('.c-more-info__content').first().text();
        const promoEnd = parsePromoEnd(moreInfo);
        if (!promoEnd) return;

        const imgEl = card.find('.c-product__media img').first();
        const imageUrl = imgEl.attr('src') ?? null;

        products.push({ name, imageUrl, regularPrice, promoPrice, promoEnd });
    });

    return products;
}

interface Counters {
    inserted: number;
    skipped: number;
    spCreated: number;
    productCreated: number;
    parseErrors: number;
}

async function processRusiai(item: ScrapedProduct, c: Counters): Promise<void> {
    const parsed = parseRusiai(item.name);
    if (!parsed) {
        // Fallback: treat as clean product
        await processClean(item, c);
        return;
    }

    const { baseName, sizes, maxK } = parsed;

    const searchSizes = sizes.length > 0 ? sizes : [null];

    for (const sizeStr of searchSizes) {
        const fullName = sizeStr ? `${baseName}, ${sizeStr}` : baseName;
        const { storeProductName, amount, unit, isWeighable } = parseSize(fullName);

        const matches = await fuzzyMatchSpMulti(NORFA_CHAIN_ID, storeProductName, amount, unit, maxK);

        if (matches.length) {
            for (const sp of matches) {
                const r = await upsertPriceForSpId(
                    sp.id, NORFA_CHAIN_ID, item.imageUrl,
                    item.regularPrice, item.promoPrice, item.promoEnd,
                );
                if (r === 'inserted') c.inserted++;
                else c.skipped++;
            }
        } else {
            // No existing SPs — create one with the clean name
            const r = await upsertPromo({
                chainId: NORFA_CHAIN_ID,
                storeProductName,
                amount,
                unit,
                isWeighable,
                imageUrl: item.imageUrl,
                regularPrice: item.regularPrice,
                promoPrice: item.promoPrice,
                promoEnd: item.promoEnd,
            });
            if (r === 'skipped')              c.skipped++;
            else if (r === 'sp_created')      c.spCreated++;
            else if (r === 'product_created') { c.spCreated++; c.productCreated++; }
            else c.inserted++;
        }
    }
}

async function processVariants(item: ScrapedProduct, c: Counters): Promise<void> {
    const variants = expandVariants(item.name);
    for (const variantName of variants) {
        const { storeProductName, amount, unit, isWeighable } = parseSize(variantName);
        const r = await upsertPromo({
            chainId: NORFA_CHAIN_ID,
            storeProductName,
            amount,
            unit,
            isWeighable,
            imageUrl: item.imageUrl,
            regularPrice: item.regularPrice,
            promoPrice: item.promoPrice,
            promoEnd: item.promoEnd,
        });
        if (r === 'skipped')              c.skipped++;
        else if (r === 'sp_created')      c.spCreated++;
        else if (r === 'product_created') { c.spCreated++; c.productCreated++; }
        else c.inserted++;
    }
}

async function processClean(item: ScrapedProduct, c: Counters): Promise<void> {
    const { storeProductName, amount, unit, isWeighable } = parseSize(item.name);
    const r = await upsertPromo({
        chainId: NORFA_CHAIN_ID,
        storeProductName,
        amount,
        unit,
        isWeighable,
        imageUrl: item.imageUrl,
        regularPrice: item.regularPrice,
        promoPrice: item.promoPrice,
        promoEnd: item.promoEnd,
    });
    if (r === 'skipped')              c.skipped++;
    else if (r === 'sp_created')      c.spCreated++;
    else if (r === 'product_created') { c.spCreated++; c.productCreated++; }
    else c.inserted++;
}

export async function runNorfaPromoScraper(): Promise<void> {
    console.log('[Norfa] Starting promo scrape…');
    const c: Counters = { inserted: 0, skipped: 0, spCreated: 0, productCreated: 0, parseErrors: 0 };

    try {
        const res = await fetch(OFFERS_URL, { headers: HEADERS });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching Norfa offers`);
        const html = await res.text();

        const allProducts = parseProducts(html);
        console.log(`[Norfa] ${allProducts.length} discounted products parsed`);

        for (let i = 0; i < allProducts.length; i++) {
            const item = allProducts[i];
            try {
                const isRusiai  = /rūšių/i.test(item.name);
                const isArbaIr  = !isRusiai && (/\barba\b/.test(item.name) || /[A-ZÄÖÜÕŽŠĖ]\s+ir\s+[A-ZÄÖÜÕŽŠĖ]/.test(item.name));
                const multiBrand = (!isRusiai && !isArbaIr) ? expandMultiBrand(item.name) : null;

                if (isRusiai) {
                    await processRusiai(item, c);
                } else if (isArbaIr) {
                    await processVariants(item, c);
                } else if (multiBrand && multiBrand.length >= 2) {
                    for (const variantName of multiBrand) {
                        const { storeProductName, amount, unit, isWeighable } = parseSize(variantName);
                        const r = await upsertPromo({
                            chainId: NORFA_CHAIN_ID,
                                        storeProductName,
                            amount,
                            unit,
                            isWeighable,
                            imageUrl: item.imageUrl,
                            regularPrice: item.regularPrice,
                            promoPrice: item.promoPrice,
                            promoEnd: item.promoEnd,
                        });
                        if (r === 'skipped')              c.skipped++;
                        else if (r === 'sp_created')      c.spCreated++;
                        else if (r === 'product_created') { c.spCreated++; c.productCreated++; }
                        else c.inserted++;
                    }
                } else {
                    await processClean(item, c);
                }
            } catch (e: any) {
                c.parseErrors++;
                console.warn(`[Norfa] upsert failed for "${item.name}": ${e.message}`);
            }
            if ((i + 1) % 50 === 0) {
                console.log(`[Norfa] processed ${i + 1}/${allProducts.length} — inserted: ${c.inserted}, skipped: ${c.skipped}, errors: ${c.parseErrors}`);
            }
        }

        const summary = `[Norfa] Done — inserted: ${c.inserted}, skipped: ${c.skipped}, new SPs: ${c.spCreated}, new Products: ${c.productCreated}, errors: ${c.parseErrors}`;
        console.log(summary);

        const errorNote = c.parseErrors > 0 ? `\n⚠️ ${c.parseErrors} upsert errors — check logs` : '';
        await notifyTelegram(
            `✅ <b>Norfa</b> scrape done\n` +
            `📦 Inserted: ${c.inserted}\n` +
            `⏭ Skipped: ${c.skipped}\n` +
            `🆕 New SPs: ${c.spCreated} (${c.productCreated} new Products)\n` +
            errorNote,
        );
    } catch (e: any) {
        const msg = `🚨 <b>Norfa</b> scraper failed\n${(e as Error).message}`;
        console.error(msg);
        await notifyTelegram(msg);
        throw e;
    }
}
