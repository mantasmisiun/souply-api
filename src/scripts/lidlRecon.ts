/**
 * Lidl recon — dump the RAW product payload the site serves, so we can see what
 * is actually available before deciding what the new discount model must hold.
 *
 *   npx tsx src/scripts/lidlRecon.ts [maxCategories]
 *
 * ZERO DB writes. Two outputs:
 *   docs/recon/lidl-raw-tiles.json   every [data-grid-data] tile, unmodified
 *   docs/recon/lidl-field-census.txt field frequency + every distinct offer text
 *
 * The census is the point: the current scraper reads discountText / highlightText /
 * lidlPlusText only to set a boolean, then throws the strings away. If multi-buy
 * ("2 už 3€"), Nth-item ("antras -50%") or threshold offers exist on lidl.lt, that
 * is where they are, and this shows us verbatim.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const BASE_URL = 'https://www.lidl.lt';
const OUT_DIR = '/home/mantas/Documents/Projects/docs/recon';
const MAX_CATEGORIES = process.argv[2] ? Number(process.argv[2]) : 6;

/** Offer-condition fields — the ones the current scraper reduces to a boolean. */
const TEXT_FIELDS = [
    'highlightText',
    'lidlPlusText',
    'coupon.discountText',
    'price.discount.discountText',
    'lidlPlus.price.discount.discountText',
    'price.discount.discountPrefix',
    'price.discount.discountSuffix',
    'stockAvailability.badgeInfoV2.0.text',
];

const get = (o: any, dotted: string): unknown =>
    dotted.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), o);

/** Recursive key census so we notice fields nobody has looked at yet. */
function walkKeys(o: unknown, prefix: string, out: Map<string, number>, depth = 0): void {
    if (depth > 4 || o == null || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        const key = prefix ? `${prefix}.${k}` : k;
        out.set(key, (out.get(key) ?? 0) + 1);
        if (Array.isArray(v)) { if (v.length) walkKeys(v[0], `${key}.0`, out, depth + 1); }
        else walkKeys(v, key, out, depth + 1);
    }
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const tiles: any[] = [];

    try {
        const page = await browser.newPage();
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });

        // Campaign/category links. hrefs may be absolute after render, so
        // normalise to a path before matching.
        const collectLinks = () => page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]'))
                .map(a => {
                    const raw = (a as HTMLAnchorElement).getAttribute('href') ?? '';
                    try { return raw.startsWith('http') ? new URL(raw).pathname : raw; }
                    catch { return raw; }
                }));

        // Products live on /a<digits> campaign pages. /c/…/s<digits> are hubs
        // that only list further links, so walk one level down from them.
        const isProductPage = (h: string) => /(^|\/)[a-z0-9-]*a\d{6,}$/i.test(h);
        const isHub = (h: string) => /\/s\d{6,}$/.test(h);

        const home = await collectLinks();
        let campaigns = [...new Set(home.filter(isProductPage))];
        const hubs = [...new Set(home.filter(isHub))].slice(0, 4);
        console.log(`[recon] homepage: ${campaigns.length} campaign pages, ${hubs.length} hubs`);

        for (const hub of hubs) {
            if (campaigns.length >= MAX_CATEGORIES) break;
            try {
                await page.goto(BASE_URL + hub, { waitUntil: 'networkidle', timeout: 45000 });
                const more = (await collectLinks()).filter(isProductPage);
                const before = campaigns.length;
                campaigns = [...new Set([...campaigns, ...more])];
                console.log(`  hub ${hub} → +${campaigns.length - before} campaign pages`);
            } catch { /* a dead hub shouldn't stop the run */ }
        }

        const urls = campaigns.slice(0, MAX_CATEGORIES);
        console.log(`[recon] scraping ${urls.length} campaign pages`);

        for (const p of urls) {
            try {
                await page.goto(BASE_URL + p, { waitUntil: 'networkidle', timeout: 45000 });
                const got: any[] = await page.evaluate(() =>
                    Array.from(document.querySelectorAll('[data-grid-data]')).map(d => {
                        try { return JSON.parse(d.getAttribute('data-grid-data')!); } catch { return null; }
                    }).filter(Boolean));
                got.forEach(t => tiles.push({ ...t, __category: p }));
                console.log(`  ${p} → ${got.length} tiles (${tiles.length} total)`);
            } catch (e: any) {
                console.warn(`  ${p} FAILED: ${e.message}`);
            }
        }
    } finally {
        await browser.close();
    }

    fs.writeFileSync(path.join(OUT_DIR, 'lidl-raw-tiles.json'), JSON.stringify(tiles, null, 2), 'utf8');

    // ---- census -----------------------------------------------------------
    const keys = new Map<string, number>();
    tiles.forEach(t => walkKeys(t, '', keys));

    const lines: string[] = [];
    lines.push(`Lidl recon — ${tiles.length} tiles, ${new Date().toISOString().slice(0, 10)}`);
    lines.push('='.repeat(72), '', '## Field frequency (present on N tiles)', '');
    [...keys.entries()].sort((a, b) => b[1] - a[1])
        .filter(([k]) => k.split('.').length <= 3)
        .forEach(([k, n]) => lines.push(`  ${String(n).padStart(5)}  ${k}`));

    lines.push('', '## Offer-condition text — DISTINCT values', '');
    for (const f of TEXT_FIELDS) {
        const vals = new Map<string, number>();
        tiles.forEach(t => {
            const v = get(t, f);
            if (typeof v === 'string' && v.trim()) vals.set(v.trim(), (vals.get(v.trim()) ?? 0) + 1);
        });
        lines.push(`### ${f}  — ${vals.size} distinct on ${[...vals.values()].reduce((a, b) => a + b, 0)} tiles`);
        [...vals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
            .forEach(([v, n]) => lines.push(`    ${String(n).padStart(4)}×  ${v}`));
        lines.push('');
    }

    // Anything that smells like a quantity condition, wherever it appears.
    lines.push('## Multi-buy / conditional language anywhere in the payload', '');
    const RE = /(\d+\s*(vnt|už|x)\b)|antras|antrasis|nemokam|perkant|rinkin|komplekt|-\s*\d+\s*%/i;
    const hits = new Map<string, number>();
    tiles.forEach(t => {
        JSON.stringify(t).split(/","|":"/).forEach(s => {
            const v = s.replace(/^"|"$/g, '').trim();
            if (v.length > 2 && v.length < 90 && RE.test(v)) hits.set(v, (hits.get(v) ?? 0) + 1);
        });
    });
    [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)
        .forEach(([v, n]) => lines.push(`    ${String(n).padStart(4)}×  ${v}`));
    if (!hits.size) lines.push('    (none found — Lidl LT may not run multi-buy offers on the site)');

    fs.writeFileSync(path.join(OUT_DIR, 'lidl-field-census.txt'), lines.join('\n'), 'utf8');
    console.log(`\n[recon] ${tiles.length} tiles → ${OUT_DIR}/`);
    console.log(`[recon] ${keys.size} distinct field paths; census written`);
}

main().catch(e => { console.error(e); process.exit(1); });
