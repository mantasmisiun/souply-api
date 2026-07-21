/**
 * Scraper dry-run harness — scrape LIVE, write what WOULD be upserted to a CSV,
 * print a random sample for human/agent verification. ZERO DB writes.
 *
 *   npx tsx src/scripts/scraperDryRun.ts <rimi|barbora|norfa|iki> [maxPages]
 *
 * Each row replicates the exact transformation the persist loop applies
 * (brand join, parseSize, payload hints/derivations), so verifying rows here
 * verifies what would land in the DB.
 */
import 'dotenv/config';
import fs from 'fs';
import { parseSize } from '../scrapers/shared/parseSize.js';
import { joinBrand } from '../scrapers/shared/net.js';

const chain = process.argv[2];
const maxPages = process.argv[3] ? Number(process.argv[3]) : undefined;
const OUT = `/home/mantas/Documents/Projects/scraper_dry_${chain}.csv`;
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : '');

interface Row {
    rawName: string; finalName: string; amount: number | null; unit: string | null;
    isWeighable: boolean; regular: number; promo: number | null;
    start: Date | null; end: Date | null; siteCategory: string | null; sizeSource: string;
}

async function collect(): Promise<Row[]> {
    if (chain === 'rimi') {
        const { collectRimiProducts } = await import('../scrapers/rimi/index.js');
        return (await collectRimiProducts(maxPages)).map(it => {
            const p = parseSize(it.name);
            return { rawName: it.name, finalName: p.storeProductName, amount: p.amount, unit: p.unit,
                isWeighable: p.isWeighable, regular: it.regularPrice, promo: it.promoPrice,
                start: null, end: null, siteCategory: it.siteCategory, sizeSource: p.amount != null ? 'name' : '' };
        });
    }
    if (chain === 'barbora') {
        const { fetchAllProducts, resolvePrice } = await import('../scrapers/barbora/index.js');
        const all = (await fetchAllProducts()).map(resolvePrice).filter((x): x is NonNullable<typeof x> => x !== null);
        return all.map(it => {
            const p = parseSize(joinBrand(it.raw.brand_name, it.raw.title));
            let amount = p.amount, unit = p.unit, src = p.amount != null ? 'name' : '';
            if (amount == null && it.derivedAmount != null) { amount = it.derivedAmount; unit = it.derivedUnit; src = 'comparative'; }
            return { rawName: it.raw.title, finalName: p.storeProductName, amount, unit,
                isWeighable: p.isWeighable, regular: it.regularPrice, promo: it.promoPrice,
                start: null, end: it.promoEnd, siteCategory: it.siteCategory, sizeSource: src };
        });
    }
    if (chain === 'norfa') {
        const { collectNorfaProducts } = await import('../scrapers/norfa/index.js');
        return (await collectNorfaProducts()).map(it => {
            const p = parseSize(it.name);
            return { rawName: it.name, finalName: p.storeProductName, amount: p.amount, unit: p.unit,
                isWeighable: p.isWeighable, regular: it.regularPrice, promo: it.promoPrice,
                start: it.promoStart, end: it.promoEnd, siteCategory: null, sizeSource: p.amount != null ? 'name' : '' };
        });
    }
    if (chain === 'iki') {
        const { collectIkiProducts } = await import('../scrapers/iki/index.js');
        return (await collectIkiProducts(maxPages)).map(it => {
            const p = parseSize(it.name);
            let amount = p.amount, unit = p.unit, isWeighable = p.isWeighable, src = p.amount != null ? 'name' : '';
            if (it.weighableHint) { isWeighable = true; if (amount == null) { amount = 1; unit = 'kg'; src = 'payload-weighable'; } }
            else if (amount == null && it.amountHint != null) { amount = it.amountHint; unit = it.unitHint; src = 'payload-conversion'; }
            return { rawName: it.name, finalName: p.storeProductName, amount, unit, isWeighable,
                regular: it.regularPrice, promo: it.promoPrice, start: null, end: it.promoEnd,
                siteCategory: null, sizeSource: src };
        });
    }
    if (chain === 'lidl-leaflet') {
        const { collectLeafletProducts } = await import('../scrapers/lidl/leaflet.js');
        return (await collectLeafletProducts({ maxFlyers: maxPages })).map(it => ({
            rawName: `${it.name}${it.itemCodes.length ? ` [#${it.itemCodes.join('/')}]` : ''}${it.flagged ? ` !!${it.flagged}` : ''}${it.lidlPlus ? ' (LidlPlus)' : ''}`,
            finalName: it.name, amount: it.amount, unit: it.unit, isWeighable: it.isWeighable,
            regular: it.regularPrice, promo: it.promoPrice,
            start: it.promoStart, end: it.promoEnd, siteCategory: `${it.flyer} p${it.page}`, sizeSource: 'leaflet',
        }));
    }
    throw new Error(`unknown chain "${chain}" — use rimi|barbora|norfa|iki|lidl-leaflet`);
}

async function main() {
    const rows = await collect();
    const header = ['rawName', 'finalName', 'amount', 'unit', 'weighable', 'regular', 'promo', 'start', 'end', 'sizeSource', 'siteCategory'];
    const csv = [header.join(',')].concat(rows.map(r =>
        [r.rawName, r.finalName, r.amount, r.unit, r.isWeighable ? 1 : 0, r.regular, r.promo ?? '', d(r.start), d(r.end), r.sizeSource, r.siteCategory].map(cell).join(',')));
    fs.writeFileSync(OUT, csv.join('\n'), 'utf8');

    // Random verification sample, sized to the run (≥15, ≤40, ~5%).
    const n = rows.length;
    const sampleSize = Math.min(40, Math.max(15, Math.ceil(n * 0.05)));
    const idx = new Set<number>();
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    while (idx.size < Math.min(sampleSize, n)) idx.add(Math.floor(rand() * n));
    console.log(`\n[dry:${chain}] ${n} rows → ${OUT}`);
    console.log(`[dry:${chain}] sample (${idx.size}):`);
    for (const i of idx) {
        const r = rows[i];
        console.log(`  "${r.rawName}" → "${r.finalName}" | ${r.amount ?? '∅'}${r.unit ?? ''} w=${r.isWeighable ? 1 : 0} [${r.sizeSource || 'none'}] | ${r.regular}→${r.promo ?? 'REG'} | ${d(r.start) || '·'}..${d(r.end) || '·'}${r.siteCategory ? ` | ${r.siteCategory}` : ''}`);
    }
    // Automated sanity flags — anything here is a candidate bug.
    const flags: string[] = [];
    for (const r of rows) {
        if (r.promo != null && r.promo >= r.regular) flags.push(`promo>=regular: ${r.rawName}`);
        if (r.regular > 500) flags.push(`suspicious price ${r.regular}: ${r.rawName}`);
        if (r.amount != null && r.unit && ['g', 'ml'].includes(r.unit) && (r.amount < 1 || r.amount > 20000)) flags.push(`odd size ${r.amount}${r.unit}: ${r.rawName}`);
        if (r.amount != null && r.unit && ['kg', 'l'].includes(r.unit) && r.amount > 30) flags.push(`odd size ${r.amount}${r.unit}: ${r.rawName}`);
        if (!r.finalName.trim()) flags.push(`empty finalName: ${r.rawName}`);
        if (r.start && r.end && r.start > r.end) flags.push(`start>end: ${r.rawName}`);
    }
    console.log(`\n[dry:${chain}] automated flags: ${flags.length}`);
    flags.slice(0, 20).forEach(f => console.log('  ⚠ ' + f));
}
main().catch(e => { console.error(e); process.exit(1); });
