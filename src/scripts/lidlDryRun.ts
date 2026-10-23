/**
 * Lidl scraper DRY RUN — scrapes lidl.lt and writes a CSV of what it finds.
 * NEVER touches the DB (no upsert). For reviewing scrape coverage/quality.
 *
 *   npx tsx src/scripts/lidlDryRun.ts            # quick: 2 promo/food hubs
 *   LIDL_DRY_FULL=1 npx tsx src/scripts/lidlDryRun.ts   # full discovery + scrape
 *   LIDL_DRY_LIMIT=5 npx tsx src/scripts/lidlDryRun.ts  # discover, scrape first 5
 */
import '../config/env.js';
import fs from 'fs';
import { fetchAllProducts, type FetchOpts } from '../scrapers/lidl/index.js';
import { extractLidlSizes } from '../scrapers/lidl/parseLidlProduct.js';

const OUT = '/home/mantas/Documents/Projects/lidl_dryrun.csv';

function cell(v: unknown): string {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
    const opts: FetchOpts = process.env.LIDL_DRY_FULL
        ? {}
        : process.env.LIDL_DRY_URLS
            ? { overridePaths: process.env.LIDL_DRY_URLS.split(',') }
            : process.env.LIDL_DRY_LIMIT
                ? { limitCategories: Number(process.env.LIDL_DRY_LIMIT) }
                : { overridePaths: ['/c/kainu-leidiniai/s10020254', '/c/maistas-gerimai-ir-buities-prekes/s10068374'] };

    console.log('[dry] fetching…', JSON.stringify(opts));
    const products = await fetchAllProducts(opts);
    console.log(`[dry] ${products.length} unique products scraped`);

    const header = ['name', 'amount', 'unit', 'isWeighable', 'regularPrice', 'promoPrice', 'discountPct', 'requiresCoupon', 'promoEnd', 'basePriceText', 'productId', 'imageUrl'];
    const rows: string[] = [header.join(',')];
    let sizeRows = 0;
    for (const p of products) {
        const sizes = extractLidlSizes(p.basePriceText, { promoPrice: p.promoPrice, regularPrice: p.regularPrice });
        const list = sizes.length ? sizes : [{ amount: null, unit: null, isWeighable: false }];
        for (const s of list) {
            const pct = p.promoPrice != null && p.regularPrice > 0
                ? Math.round((1 - p.promoPrice / p.regularPrice) * 100) : '';
            rows.push([
                p.name, s.amount, s.unit, s.isWeighable, p.regularPrice, p.promoPrice ?? '', pct,
                p.requiresCoupon, p.promoEnd.toISOString().slice(0, 10), p.basePriceText, p.productId, p.imageUrl,
            ].map(cell).join(','));
            sizeRows++;
        }
    }
    fs.writeFileSync(OUT, rows.join('\n'), 'utf8');
    console.log(`[dry] wrote ${OUT} — ${products.length} products, ${sizeRows} size-rows`);
    process.exit(0);
}

main().catch(e => { console.error('[dry] failed:', e); process.exit(1); });
