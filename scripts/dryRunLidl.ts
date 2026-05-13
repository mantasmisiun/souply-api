/**
 * Dry-run: fetch Lidl products via full category discovery, run the size
 * parser, print results grouped by basePriceText pattern.
 * No DB writes.
 *
 * Run with:
 *   npx tsx scripts/dryRunLidl.ts
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Page } from 'playwright';
import { extractLidlSizes } from '../src/scrapers/lidl/parseLidlProduct.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://www.lidl.lt';

const CATEGORY_HUBS = [
    '/c/kainu-leidiniai/s10020254',
    '/c/maistas-gerimai-ir-buities-prekes/s10068374',
    '/c/virtuve-ir-buitis/s10068166',
    '/c/sportas-ir-laisvalaikis/s10068226',
    '/c/namai-ir-interjeras/s10068371',
    '/c/apranga-ir-aksesuarai/s10068373',
];

function isLidlPlusCoupon(lp: any): boolean {
    const texts = [lp?.highlightText, lp?.lidlPlusText, lp?.coupon?.discountText, lp?.price?.discount?.discountText]
        .filter(Boolean).join(' ');
    return /kupon/i.test(texts);
}

interface ParsedItem {
    name: string;
    basePriceText: string;
    regularPrice: number;
    promoPrice: number | null;
    extracted: { amount: number | null; unit: string | null; isWeighable: boolean }[];
}

function collectLinks(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const found = new Set<string>();
        document.querySelectorAll<HTMLAnchorElement>('a[href^="/c/"], a[href^="/a"]').forEach(a => {
            const href = a.getAttribute('href')!;
            if (!href.includes('?') && !href.includes('#') && /\/[as]\d+$/.test(href)) {
                found.add(href);
            }
        });
        return Array.from(found);
    });
}

async function collectItems(page: Page): Promise<any[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-grid-data]')).map(d => {
            try { return JSON.parse(d.getAttribute('data-grid-data')!); } catch { return null; }
        }).filter(Boolean)
    );
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Step 1: discover category URLs
    const seen = new Set<string>();
    console.log('Discovering category URLs…');

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    for (const p of await collectLinks(page)) seen.add(p);

    for (const hub of CATEGORY_HUBS) {
        try {
            await page.goto(BASE_URL + hub, { waitUntil: 'networkidle', timeout: 45000 });
            for (const p of await collectLinks(page)) seen.add(p);
        } catch {}
    }
    console.log(`Discovered ${seen.size} category URLs`);

    // Step 2: scrape all discovered pages
    const allItems: ParsedItem[] = [];
    const seenIds = new Set<number>();
    let pageCount = 0;

    for (const path of seen) {
        pageCount++;
        try {
            await page.goto(BASE_URL + path, { waitUntil: 'networkidle', timeout: 45000 });
            const btn = await page.$('button:has-text("Rodyti daugiau")');
            if (btn) { await btn.click(); await page.waitForTimeout(2000); }

            const rawItems = await collectItems(page);
            let added = 0;
            for (const raw of rawItems) {
                if (!raw?.havingPrice || !raw.productId || seenIds.has(raw.productId)) continue;
                seenIds.add(raw.productId);

                const name = (raw.fullTitle as string | undefined)?.trim();
                if (!name) continue;

                const p = raw.price;
                const lp = (raw.lidlPlus as any[] | undefined)?.[0];

                let regularPrice: number;
                let promoPrice: number | null;
                let basePriceText: string;

                if (p?.price > 0 && p?.discount?.deletedPrice > 0 && p?.discount?.showDiscount) {
                    regularPrice = p.discount.deletedPrice;
                    promoPrice = p.price;
                    basePriceText = p.basePrice?.text ?? '';
                } else if (lp?.price?.price > 0 && lp?.price?.discount?.deletedPrice > 0) {
                    regularPrice = lp.price.discount.deletedPrice;
                    promoPrice = lp.price.price;
                    basePriceText = lp.price.basePrice?.text ?? p?.basePrice?.text ?? '';
                } else if (p?.price > 0) {
                    regularPrice = p.price;
                    promoPrice = null;
                    basePriceText = p.basePrice?.text ?? '';
                } else {
                    continue;
                }

                const extracted = extractLidlSizes(basePriceText, { promoPrice, regularPrice });
                allItems.push({ name, basePriceText, regularPrice, promoPrice, extracted });
                added++;
            }
            if (added > 0) process.stdout.write(`\r  ${pageCount}/${seen.size} pages | ${allItems.length} products`);
        } catch {}
    }

    await browser.close();
    console.log(`\n\nDone scraping. ${allItems.length} unique products from ${pageCount} pages.`);

    // ── Analysis ────────────────────────────────────────────────────────────

    console.log(`\n${'='.repeat(70)}`);

    // Group by basePriceText to find unique patterns
    const byPattern = new Map<string, ParsedItem[]>();
    for (const item of allItems) {
        const key = item.basePriceText || '(empty)';
        if (!byPattern.has(key)) byPattern.set(key, []);
        byPattern.get(key)!.push(item);
    }

    const sorted = [...byPattern.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`UNIQUE basePriceText PATTERNS: ${sorted.length}\n`);

    for (const [pattern, items] of sorted) {
        const sample = items[0];
        const ex = sample.extracted;
        const exStr = ex.map(s =>
            `amount=${s.amount ?? 'null'} unit=${s.unit ?? 'null'} weighable=${s.isWeighable}`
        ).join(' | ');
        const flags = [
            ex.some(s => s.isWeighable) ? '⚖ WEIGHABLE' : '',
            ex.some(s => s.amount === null) ? '❓ NO AMOUNT' : '',
            ex.length > 1 ? `📦 ${ex.length}-VARIANT` : '',
        ].filter(Boolean).join(' ');
        console.log(`[${items.length}x] "${pattern}"  ${flags}`);
        console.log(`       → ${exStr}`);
        console.log(`       e.g. "${sample.name}" reg=${sample.regularPrice} promo=${sample.promoPrice ?? 'null'}`);
        console.log();
    }

    // ── Issues ───────────────────────────────────────────────────────────────
    console.log('='.repeat(70));
    console.log('POTENTIAL ISSUES\n');

    const weighableWithEq = allItems.filter(i =>
        i.extracted.some(s => s.isWeighable) && i.basePriceText.includes('=')
    );
    if (weighableWithEq.length) {
        console.log(`⚠  isWeighable=true but "=" annotation present — should be fixed package (${weighableWithEq.length}):`);
        for (const i of weighableWithEq) console.log(`   "${i.name}" | "${i.basePriceText}"`);
        console.log();
    } else {
        console.log('✓  No isWeighable=true with "=" annotation (kg-vs-package fix working)\n');
    }

    const vntNoAmount = allItems.filter(i =>
        i.extracted.some(s => s.unit === 'vnt' && s.amount === null) &&
        i.basePriceText.includes('=')
    );
    if (vntNoAmount.length) {
        console.log(`⚠  unit=vnt, amount=null but "=" annotation — pack count not inferred (${vntNoAmount.length}):`);
        for (const i of vntNoAmount) {
            const upMatch = i.basePriceText.match(/=\s*([\d,]+)/);
            const unitPrice = upMatch ? parseFloat(upMatch[1].replace(',', '.')) : null;
            const ratio = unitPrice && i.promoPrice ? (i.promoPrice / unitPrice).toFixed(2) : '?';
            console.log(`   "${i.name}" | "${i.basePriceText}" | reg=${i.regularPrice} promo=${i.promoPrice} ratio=${ratio}`);
        }
        console.log();
    } else {
        console.log('✓  All vnt products with "=" annotation have inferred pack count\n');
    }

    const nullAmount = allItems.filter(i =>
        i.extracted.some(s => s.amount === null && s.unit === null)
    );
    if (nullAmount.length) {
        console.log(`❓ Unrecognised size pattern — amount=null unit=null (${nullAmount.length}):`);
        for (const i of nullAmount) console.log(`   "${i.name}" | "${i.basePriceText}"`);
        console.log();
    } else {
        console.log('✓  No unrecognised size patterns\n');
    }

    const multiVariant = allItems.filter(i => i.extracted.length > 1);
    if (multiVariant.length) {
        console.log(`📦 Multi-variant products (${multiVariant.length}):`);
        for (const i of multiVariant) {
            const sizes = i.extracted.map(s => `${s.amount}${s.unit}`).join(' / ');
            console.log(`   "${i.name}" | "${i.basePriceText}" → [${sizes}]`);
        }
        console.log();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
