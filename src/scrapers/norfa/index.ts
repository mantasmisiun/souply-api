import * as cheerio from 'cheerio';
import { fetchWithRetry } from '../shared/net.js';
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

// "MM DD-MM DD" or "MM DD- MM DD" → full promo window. The START (groups 1-2)
// was always in the flyer text — now captured so future-dated promos insert
// with validFrom instead of showing the promo price early.
function parsePromoWindow(moreInfoText: string): { promoStart: Date | null; promoEnd: Date } | null {
    const m = moreInfoText.match(/(\d{2})\s+(\d{2})\s*-\s*(\d{2})\s+(\d{2})/);
    if (!m) return null;
    const now = new Date();
    const end = new Date(now.getFullYear(), parseInt(m[3], 10) - 1, parseInt(m[4], 10), 23, 59, 59, 0);
    if (end < now) end.setFullYear(end.getFullYear() + 1);
    let start: Date | null = new Date(end.getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10), 0, 0, 0, 0);
    if (start > end) start.setFullYear(start.getFullYear() - 1); // Dec→Jan span
    if (start <= now) start = null; // only future starts matter (validFrom semantics)
    return { promoStart: start, promoEnd: end };
}

function parseEuroPrice(text: string): number | null {
    const m = text.match(/([\d]+[.,][\d]+|[\d]+)\s*€/);
    if (!m) return null;
    const val = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(val) && val > 0 ? val : null;
}

export interface ScrapedProduct {
    name: string;
    imageUrl: string | null;
    regularPrice: number;
    /** null = no-discount price stamp (regular-price observation, Lidl parity). */
    promoPrice: number | null;
    promoStart: Date | null;
    promoEnd: Date;
}

function parseProducts(html: string): ScrapedProduct[] {
    const $ = cheerio.load(html);
    const products: ScrapedProduct[] = [];

    $('div.c-product.c-product--compact').each((_, el) => {
        const card = $(el);

        const name = card.find('.c-product__name').first().text().trim();
        if (!name) return;

        const priceText = card.find('.c-product__price').first().text().trim();
        const price = parseEuroPrice(priceText);
        if (!price) return;

        // Discount card: old price present → promo. No old price → the flyer
        // is a plain price stamp (arbūzas 0.55 €) — keep it as a REGULAR-price
        // observation (essential grocery data, same treatment as Lidl).
        const oldPriceText = card.find('.c-product__old-price').first().text().trim();
        const oldPrice = parseEuroPrice(oldPriceText);
        const regularPrice = oldPrice ?? price;
        const promoPrice = oldPrice != null && price < oldPrice ? price : null;
        if (oldPrice != null && promoPrice == null) return; // old ≥ new — malformed card

        const moreInfo = card.find('.c-more-info__content').first().text();
        const window = parsePromoWindow(moreInfo);
        if (!window) return;

        const imgEl = card.find('.c-product__media img').first();
        const imageUrl = imgEl.attr('src') ?? null;

        products.push({ name, imageUrl, regularPrice, promoPrice, promoStart: window.promoStart, promoEnd: window.promoEnd });
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
    const promoPrice = item.promoPrice;
    if (promoPrice == null) { await processClean(item, c); return; } // narrowing; routed earlier
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
                    item.regularPrice, promoPrice, item.promoEnd,
                    false, item.promoStart,
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
                promoStart: item.promoStart,
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
            promoStart: item.promoStart,
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
        promoStart: item.promoStart,
        promoEnd: item.promoEnd,
    });
    if (r === 'skipped')              c.skipped++;
    else if (r === 'sp_created')      c.spCreated++;
    else if (r === 'product_created') { c.spCreated++; c.productCreated++; }
    else c.inserted++;
}

/** Scrape-only pass (no DB writes) — shared by the real run and the dry harness. */
export async function collectNorfaProducts(): Promise<ScrapedProduct[]> {
    const res = await fetchWithRetry(OFFERS_URL, { headers: HEADERS });
    return parseProducts(await res.text());
}

export async function runNorfaPromoScraper(): Promise<void> {
    console.log('[Norfa] Starting promo scrape…');
    const c: Counters = { inserted: 0, skipped: 0, spCreated: 0, productCreated: 0, parseErrors: 0 };

    try {
        const allProducts = await collectNorfaProducts();
        console.log(`[Norfa] ${allProducts.length} discounted products parsed`);

        for (let i = 0; i < allProducts.length; i++) {
            const item = allProducts[i];
            try {
                // No-discount price stamps go straight to the clean path — the
                // aggregate handlers' slot-fill needs a numeric promo price.
                if (item.promoPrice == null) {
                    await processClean(item, c);
                    continue;
                }
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
                            promoStart: item.promoStart,
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
        // Failure alerting is owned by runScraperWithRetry — surface + rethrow.
        console.error(`[Norfa] scrape failed: ${(e as Error).message}`);
        throw e;
    }
}
