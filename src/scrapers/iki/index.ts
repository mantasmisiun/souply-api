import { parseSize } from '../shared/parseSize.js';
import { fetchWithRetry } from '../shared/net.js';
import { upsertPromo } from '../shared/promoUpsert.js';
import { notifyTelegram } from '../shared/telegramAlert.js';

const IKI_CHAIN_ID = 3;

// lastmile.lt public client config (from page HTML — public values)
const FIREBASE_API_KEY = 'AIzaSyAzChYNp4Vios_oAtQgbWz8uU3bnBABsPw';
const SEARCH_URL = 'https://searchservice-952707942140.europe-north1.run.app';
const IKI_CHAIN = 'CvKfTzV4TN5U8BTMF1Hl';  // lastmile chain ID for IKI

const PAGE_SIZE = 100;

async function getFirebaseToken(): Promise<{ idToken: string; uid: string }> {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnSecureToken: true }),
        },
    );
    if (!res.ok) throw new Error(`Firebase auth failed: HTTP ${res.status}`);
    const data = await res.json() as { idToken: string; localId: string };
    return { idToken: data.idToken, uid: data.localId };
}

interface SearchProduct {
    frontEndProduct: {
        name: { lt?: string; en?: string } | string;
        prc: { p: number; s: number | null };
        photoUrl?: string;
        thumbUrl?: string;
        loyaltyPrice?: number | null;
        salesPrice?: number | null;
        promoExpiryDate?: string | null;
        // Structured size data (probed 2026-07): isFixedWeight=false + KG uom =
        // by-weight produce (name usually has NO size); conversionMeasure/Value =
        // pack size in KG/L for fixed-weight items.
        isFixedWeight?: boolean;
        unitOfMeasure?: string;
        conversionMeasure?: string;
        conversionValue?: number;
    };
}

export interface ScrapedProduct {
    name: string;
    imageUrl: string | null;
    regularPrice: number;
    promoPrice: number;
    promoEnd: Date;
    /** Payload says this is sold by weight (isFixedWeight=false, KG). */
    weighableHint: boolean;
    /** Structured pack size when the payload provides one (g/ml/kg/l). */
    amountHint: number | null;
    unitHint: string | null;
}

async function fetchPage(
    fromIndex: number,
    idToken: string,
    uid: string,
): Promise<{ products: SearchProduct[]; count: number }> {
    const res = await fetchWithRetry(`${SEARCH_URL}/v1/frontend-products`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json',
            'user-id': uid,
            'Accept': 'application/json',
            'Origin': 'https://lastmile.lt',
        },
        body: JSON.stringify({
            params: {
                type: 'view_products',
                isActive: true,
                isApproved: true,
                chainIds: [IKI_CHAIN],
                hasLoyaltyCard: true,
            },
            limit: PAGE_SIZE,
            fromIndex,
        }),
    });
    if (!res.ok) throw new Error(`Search API HTTP ${res.status} at offset ${fromIndex}`);
    const data = await res.json() as { products: SearchProduct[]; count: number };
    return data;
}

function extractPromoProduct(item: SearchProduct): ScrapedProduct | null {
    const fp = item.frontEndProduct;
    const { promoExpiryDate, loyaltyPrice, salesPrice, prc, photoUrl, thumbUrl } = fp;

    // Only include products with a time-limited promo end date
    if (!promoExpiryDate) return null;

    // Loyalty price = the price every card-scanning shopper pays — the effective
    // shelf reality, NOT requiresCoupon. That flag is reserved for Lidl-style
    // coupons that need explicit in-app activation beyond a card scan.
    const promoPrice = loyaltyPrice ?? salesPrice ?? null;
    if (!promoPrice) return null;

    const regularPrice = prc.p;
    if (!regularPrice || promoPrice >= regularPrice) return null;

    const nameRaw = fp.name;
    const name = typeof nameRaw === 'string' ? nameRaw : (nameRaw?.lt ?? nameRaw?.en ?? '');
    if (!name) return null;

    const promoEnd = new Date(promoExpiryDate);
    if (!Number.isFinite(promoEnd.getTime())) return null;

    // Structured size: conversionValue is in KG/L — normalize to parseSize's
    // conventions (sub-1 → g/ml, otherwise kg/l).
    const weighableHint = fp.isFixedWeight === false && fp.unitOfMeasure === 'KG';
    let amountHint: number | null = null;
    let unitHint: string | null = null;
    const cv = fp.conversionValue;
    if (!weighableHint && cv && cv > 0 && (fp.conversionMeasure === 'KG' || fp.conversionMeasure === 'L')) {
        const solid = fp.conversionMeasure === 'KG';
        if (cv < 1) { amountHint = +(cv * 1000).toFixed(1); unitHint = solid ? 'g' : 'ml'; }
        else { amountHint = cv; unitHint = solid ? 'kg' : 'l'; }
    }

    return {
        name,
        imageUrl: photoUrl ?? thumbUrl ?? null,
        regularPrice,
        promoPrice,
        promoEnd,
        weighableHint,
        amountHint,
        unitHint,
    };
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Scrape-only pass (no DB writes) — shared by the real run and the dry harness. */
export async function collectIkiProducts(maxPages?: number): Promise<ScrapedProduct[]> {
    const { idToken, uid } = await getFirebaseToken();
    console.log('[IKI] Firebase auth OK');

    const { count: totalCount } = await fetchPage(0, idToken, uid);
    console.log(`[IKI] ${totalCount} total IKI products in catalog`);

    const promoProducts: ScrapedProduct[] = [];
    let fromIndex = 0;
    let pages = 0;

    while (fromIndex < totalCount && (maxPages == null || pages < maxPages)) {
        const { products } = await fetchPage(fromIndex, idToken, uid);
        for (const item of products) {
            const p = extractPromoProduct(item);
            if (p) promoProducts.push(p);
        }
        fromIndex += PAGE_SIZE;
        pages++;
        if (fromIndex % 1000 === 0) {
            console.log(`[IKI] scanned ${fromIndex}/${totalCount} products, ${promoProducts.length} promos so far`);
        }
        if (products.length < PAGE_SIZE) break;
        await delay(300 + Math.random() * 200);
    }
    return promoProducts;
}

export async function runIkiPromoScraper(): Promise<void> {
    console.log('[IKI] Starting promo scrape (lastmile.lt search API)…');
    let inserted = 0, skipped = 0, spCreated = 0, productCreated = 0, parseErrors = 0;

    try {
        const promoProducts = await collectIkiProducts();

        console.log(`[IKI] ${promoProducts.length} promo products found`);

        for (let i = 0; i < promoProducts.length; i++) {
            const item = promoProducts[i];
            try {
                const parsed = parseSize(item.name);
                let { amount, unit, isWeighable } = parsed;
                // Payload beats name-parsing where the name carries no size:
                // by-weight produce ("Bananai BON VIA") and structured pack sizes.
                if (item.weighableHint) {
                    isWeighable = true;
                    if (amount == null) { amount = 1; unit = 'kg'; }
                } else if (amount == null && item.amountHint != null) {
                    amount = item.amountHint; unit = item.unitHint;
                }
                const result = await upsertPromo({
                    chainId: IKI_CHAIN_ID,
                    storeProductName: parsed.storeProductName,
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
                console.warn(`[IKI] upsert failed for "${item.name}": ${e.message}`);
            }
            if ((i + 1) % 200 === 0) {
                console.log(`[IKI] processed ${i + 1}/${promoProducts.length} — inserted: ${inserted}, skipped: ${skipped}, errors: ${parseErrors}`);
            }
        }

        const summary = `[IKI] Done — inserted: ${inserted}, skipped: ${skipped}, new SPs: ${spCreated}, new Products: ${productCreated}, errors: ${parseErrors}`;
        console.log(summary);

        const errorNote = parseErrors > 0 ? `\n⚠️ ${parseErrors} upsert errors — check logs` : '';
        await notifyTelegram(
            `✅ <b>IKI</b> scrape done\n` +
            `📦 Inserted: ${inserted}\n` +
            `⏭ Skipped: ${skipped}\n` +
            `🆕 New SPs: ${spCreated} (${productCreated} new Products)\n` +
            errorNote,
        );
    } catch (e: any) {
        // Failure alerting is owned by runScraperWithRetry — surface + rethrow.
        console.error(`[IKI] scrape failed: ${(e as Error).message}`);
        throw e;
    }
}
