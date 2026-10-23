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
const OUT = `/home/mantas/Documents/Projects/docs/recon/dry_${chain}.csv`;
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : '');

interface Row {
    rawName: string; finalName: string; amount: number | null; unit: string | null;
    isWeighable: boolean; regular: number; promo: number | null;
    start: Date | null; end: Date | null; siteCategory: string | null; sizeSource: string;
    /** Verbatim offer badge — the CONDITION. Empty for chains that publish none. */
    offerText?: string | null;
    /** Chain's own percentage figure, not derived. */
    offerPct?: number | null;
    /** Loyalty card required for this price. */
    card?: boolean;
}

/** Classify by SHOPPER ACTION, not by badge text.
 *  A kind exists only if it changes what you must DO to get the price.
 *  Percentages are derivable from regular vs promo; "Super kaina" / "SUMAŽINTA"
 *  are marketing. Both stay in offerText and neither is a kind. */
function classify(r: Row): { kind: string; minQty: number | null } {
    const t = (r.offerText ?? '').trim();
    const mq = t.match(/^(\d+)\s*u\u017e/i);              // "3 už", "5 už" — must buy N
    if (mq) return { kind: 'multibuy', minQty: Number(mq[1]) };
    if (/kupon/i.test(t)) return { kind: 'coupon', minQty: null };   // must activate
    if (r.card) return { kind: 'card', minQty: null };                // must carry the card
    if (r.promo != null) return { kind: 'simple', minQty: null };
    return { kind: 'none', minQty: null };                            // price observation only
}

/** Chain's own percentage vs the one implied by the prices. A mismatch is a
 *  data-quality signal, not a discount type — surfaced so it can be eyeballed. */
function pctCheck(r: Row): string {
    if (r.offerPct == null || r.promo == null || !r.regular) return '';
    const computed = Math.round((1 - r.promo / r.regular) * 100);
    return Math.abs(computed - r.offerPct) > 1 ? `stated ${r.offerPct} vs computed ${computed}` : '';
}

/** €/kg or €/l for the effective price — the number that makes rows comparable. */
function perUnit(r: Row): string {
    const price = r.promo ?? r.regular;
    if (!r.amount || !r.unit || !price) return '';
    const kg = r.unit === 'g' ? r.amount / 1000 : r.unit === 'kg' ? r.amount
        : r.unit === 'ml' ? r.amount / 1000 : r.unit === 'l' ? r.amount : null;
    return kg ? (price / kg).toFixed(2) : '';
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
    if (chain === 'lidl') {
        const { fetchAllProducts } = await import('../scrapers/lidl/index.js');
        const { extractLidlSizes } = await import('../scrapers/lidl/parseLidlProduct.js');
        const all = await fetchAllProducts(maxPages ? { limitCategories: maxPages } : {});
        // Replicate the persist loop exactly: directSize wins, else derive from
        // basePriceText, and emit ONE ROW PER SIZE (the loop upserts per size).
        const out: Row[] = [];
        for (const it of all) {
            const sizes = it.directSize
                ? [it.directSize]
                : extractLidlSizes(it.basePriceText, {
                    promoPrice: it.promoPrice, regularPrice: it.regularPrice,
                });
            const p = parseSize(it.name);
            const list = sizes.length ? sizes : [{ amount: p.amount, unit: p.unit, isWeighable: p.isWeighable }];
            for (const sz of list) {
                out.push({
                    rawName: `${it.name}${it.itemCode ? ` [#${it.itemCode}]` : ''}`,
                    finalName: p.storeProductName,
                    amount: sz.amount, unit: sz.unit, isWeighable: sz.isWeighable,
                    regular: it.regularPrice, promo: it.promoPrice,
                    start: it.promoStart, end: it.promoEnd,
                    siteCategory: it.basePriceText || null,
                    sizeSource: it.directSize ? 'directSize' : sizes.length ? 'basePrice' : 'name',
                    offerText: it.offerText ?? null, offerPct: it.offerPct ?? null,
                    card: !!it.isLidlPlus,
                });
            }
        }
        return out;
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
    throw new Error(`unknown chain "${chain}" — use rimi|barbora|norfa|iki|lidl|lidl-leaflet`);
}

async function main() {
    fs.mkdirSync('/home/mantas/Documents/Projects/docs/recon', { recursive: true });
    const rows = await collect();
    const header = ['rawName', 'finalName', 'amount', 'unit', 'weighable', 'regular', 'promo',
        'perUnit', 'kind', 'minQty', 'offerText', 'pctCheck', 'card',
        'start', 'end', 'sizeSource', 'siteCategory'];
    const csv = [header.join(',')].concat(rows.map(r => {
        const { kind, minQty } = classify(r);
        return [r.rawName, r.finalName, r.amount, r.unit, r.isWeighable ? 1 : 0, r.regular, r.promo ?? '',
            perUnit(r), kind, minQty ?? '', r.offerText ?? '', pctCheck(r), r.card ? 1 : '',
            d(r.start), d(r.end), r.sizeSource, r.siteCategory].map(cell).join(',');
    }));
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
