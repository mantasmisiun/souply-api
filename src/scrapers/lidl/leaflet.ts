/**
 * Lidl DIGITAL LEAFLET scraper — the food weekly offers (fresh produce, meat,
 * dairy…) exist ONLY in the leaflet PDF, not in the site's product grids.
 *
 * Source: endpoints.leaflets.schwarz/v4/flyer → offer window + VECTOR-text PDF.
 * Extraction: pdftohtml -xml (poppler) → text boxes with coords + font specs.
 *   Font families are semantic: LidlFontPrice = the big promo price,
 *   LidlFontCondPro (bold) = product name, LidlFontCondPro-Book = pack/€-per-kg
 *   lines, LidlFontPro-Book numerals = crossed-out old price.
 * Tiles: anchored on the 5-digit ITEM CODE; every element is assigned to the
 *   RIGHTMOST code left of it within a vertical band (validated by hand on the
 *   2026-KW30 flyer — survives price-between-tiles and price-below-code layouts).
 * Self-validation per tile: promo/old must agree with the printed -N% (±8pp),
 *   pack × €/kg must agree with the price (±6ct) — disagreeing tiles are DROPPED
 *   and reported, never inserted (a wrong price is worse than a missing one).
 *
 * NOTE: requires poppler-utils (pdftohtml) on the host — free, apt-installable.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pool from '../../config/db.js';
import { upsertPromo, upsertPriceForSpId } from '../shared/promoUpsert.js';
import { notifyTelegram } from '../shared/telegramAlert.js';

chromium.use(StealthPlugin());

const LIDL_CHAIN_ID = 5;
const execFileP = promisify(execFile);

const LEAFLET_HUB = 'https://www.lidl.lt/c/kainu-leidiniai/s10020254';
const FLYER_API = 'https://endpoints.leaflets.schwarz/v4/flyer';
/** FOOD weekly leaflet only — this is where the grid-invisible fresh/food offers
 *  live. The non-food leaflet is a fashion-catalog layout (vertical glyph-run
 *  text, no reliable tiles) and its products are covered by the grid scraper. */
const FLYER_FILTER = /^maisto-prekiu-pasiulymai/;

export interface LeafletProduct {
    name: string;
    itemCode: string | null;
    /** ALL chain-native codes on the tile (variant lists) — normalized, no leading zeros. */
    itemCodes: string[];
    regularPrice: number;
    promoPrice: number | null;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    lidlPlus: boolean;
    promoStart: Date | null;
    promoEnd: Date;
    page: number;
    flyer: string;
    /** Failed self-validation — report, never insert. */
    flagged: string | null;
}

interface Box { top: number; left: number; w: number; h: number; text: string; size: number; family: string; }

// ── Discovery ────────────────────────────────────────────────────────────────

export async function discoverFlyerIds(): Promise<string[]> {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(LEAFLET_HUB, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2000);
        const hrefs: string[] = await page.evaluate(() =>
            [...new Set(Array.from(document.querySelectorAll('a[href*="/l/"]'))
                .map(a => a.getAttribute('href') ?? ''))]);
        const ids = hrefs
            .map(h => h.match(/\/leidinys\/([^/]+)\//)?.[1])
            .filter((x): x is string => !!x && FLYER_FILTER.test(x));
        return [...new Set(ids)];
    } finally {
        await browser.close();
    }
}

async function fetchFlyerMeta(id: string): Promise<{ pdfUrl: string; offerStart: Date; offerEnd: Date } | null> {
    const res = await fetch(`${FLYER_API}?flyer_identifier=${id}&region_id=0&region_code=0`, {
        headers: { 'Accept': 'application/json', 'Origin': 'https://www.lidl.lt', 'User-Agent': 'Mozilla/5.0 Chrome/124' },
    });
    if (!res.ok) return null;
    const f = (await res.json() as any).flyer;
    if (!f?.pdfUrl || !f?.offerStartDate || !f?.offerEndDate) return null;
    const offerStart = new Date(`${f.offerStartDate}T00:00:00`);
    const offerEnd = new Date(`${f.offerEndDate}T23:59:59`);
    return { pdfUrl: f.pdfUrl, offerStart, offerEnd };
}

// ── PDF → boxes ──────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

export async function pdfToPages(pdfPath: string, workDir: string): Promise<Box[][]> {
    const xmlBase = join(workDir, 'flyer');
    await execFileP('pdftohtml', ['-xml', '-i', '-q', pdfPath, xmlBase]);
    const xml = await readFile(`${xmlBase}.xml`, 'utf8');
    const pages: Box[][] = [];
    // fontspec IDs are GLOBAL across the document (declared once on first use) —
    // maintain ONE cumulative map over all pages.
    const fonts = new Map<string, { size: number; family: string }>();
    const pageChunks = xml.split(/<page number="/).slice(1);
    for (const chunk of pageChunks) {
        for (const m of chunk.matchAll(/<fontspec id="(\d+)" size="(-?\d+)" family="([^"]*)"/g)) {
            fonts.set(m[1], { size: Number(m[2]), family: m[3] });
        }
        const boxes: Box[] = [];
        // markup runs come in ANY order/nesting (<b><i>, <i><b> — variant lines
        // like "Kokos & Mango" are italic-bold) — strip any run of b/i tags.
        for (const m of chunk.matchAll(/<text top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)" font="(\d+)">(?:<[bi]>)*([^<]*)/g)) {
            const f = fonts.get(m[5]);
            const text = decodeEntities(m[6]).trim();
            if (!text) continue;
            boxes.push({ top: +m[1], left: +m[2], w: +m[3], h: +m[4], text, size: f?.size ?? 0, family: f?.family ?? '' });
        }
        pages.push(boxes);
    }
    return pages;
}

// ── Tile clustering + parsing ────────────────────────────────────────────────

const num = (s: string) => parseFloat(s.replace(',', '.'));
const cy = (b: Box) => b.top + b.h / 2;

/** Parse "MM DD–MM DD" using the flyer year (windows never span years mid-flyer). */
function parseWindow(text: string, refYear: number): { start: Date; end: Date } | null {
    const m = text.match(/(\d{2})\s+(\d{2})\s*[–-]\s*(\d{2})\s+(\d{2})/);
    if (!m) return null;
    const start = new Date(refYear, +m[1] - 1, +m[2], 0, 0, 0);
    const end = new Date(refYear, +m[3] - 1, +m[4], 23, 59, 59);
    if (end < start) end.setFullYear(end.getFullYear() + 1);
    return { start, end };
}

export function parsePage(boxes: Box[], pageNo: number, flyerId: string, offerStart: Date, offerEnd: Date): LeafletProduct[] {
    const now = new Date();
    const refYear = offerStart.getFullYear();
    // Item codes: 5-digit (fresh produce), 6/7-digit (packaged), possibly a
    // slash-separated variant LIST ("207484 / 207486 /") wrapping onto a second
    // line. Merge adjacent code boxes (either axis) into one tile anchor, but
    // keep EVERY code in the group — receipts can hit any variant.
    // 4-digit codes exist too (NESCAFÉ 2411/2412; receipts print them
    // zero-padded: 0002411). Years (19xx/20xx) are excluded — footer noise.
    const CODE_RE = /^\d{4,7}(\s*\/\s*\d{4,7})*\s*\/?$/;
    const isYear = (t: string) => /^(19|20)\d{2}$/.test(t);
    const codeBoxes = boxes.filter(b => CODE_RE.test(b.text) && !isYear(b.text)
        && b.size <= 10 && /CondPro-Book/.test(b.family));
    const groupCodes = new Map<Box, string[]>();
    const codes = codeBoxes.filter(c => !codeBoxes.some(o =>
        o !== c && Math.abs(o.top - c.top) <= 16 && Math.abs(o.left - c.left) <= 90
        && (o.top < c.top || (o.top === c.top && o.left < c.left))));
    for (const anchor of codes) {
        const group = codeBoxes.filter(o => o === anchor
            || (Math.abs(o.top - anchor.top) <= 16 && Math.abs(o.left - anchor.left) <= 90));
        const all = [...new Set(group.flatMap(g => [...g.text.matchAll(/\d{4,7}/g)].map(m => m[0].replace(/^0+/, ''))))];
        groupCodes.set(anchor, all);
    }
    if (!codes.length) return [];

    // page-level window override (e.g. "Nuo pirmadienio, 07 20, iki 07 22")
    const headerBox = boxes.find(b => b.size >= 25 && /nuo .*iki/i.test(b.text));
    const headerWin = headerBox ? parseWindow(headerBox.text.replace(/[^\d]+/g, ' ').replace(/^\s+|\s+$/g, '')
        .replace(/(\d{2}) (\d{2}) (\d{2}) (\d{2})/, '$1 $2–$3 $4'), refYear) : null;

    // Assign each box to its tile code. Eligible: code not right of the box
    // (beyond tolerance) and within a vertical band. Among eligible, minimize
    // |Δy| + a small horizontal-distance penalty — pure "rightmost" mispairs
    // vertically stacked tiles with slight x offsets (Abrikosai/Persikai).
    const tiles = new Map<Box, Box[]>();
    codes.forEach(c => tiles.set(c, []));
    for (const b of boxes) {
        if (codes.includes(b)) continue;
        const eligible = codes.filter(c => c.left - 60 <= b.left && Math.abs(cy(b) - cy(c)) <= 260);
        if (!eligible.length) continue;
        // Assignment hierarchy (codes are the BOTTOM anchor of their tile):
        //  1. same column & code BELOW the box → nearest below wins (names,
        //     details, prose all sit above their code; this beats any
        //     vertically-closer neighbor code above — the BIOVELA/CIDO steals).
        //  2. same column, no code below → nearest in-column (price-under-code
        //     layouts like Persikai).
        //  3. different column → legacy left-of scoring (prices sit right of
        //     the text column).
        const inCol = eligible.filter(c => Math.abs(b.left - c.left) <= 45);
        // TEXT boxes (CondPro names/details/prose) sit ABOVE their code — the
        // code below them in-column wins (BIOVELA/CIDO steals). PRICE-block
        // fonts (Price-Pt, Pro badges, Pro-Book old prices) can sit BELOW the
        // code (produce tiles) — nearest in-column wins for them.
        const textish = /CondPro/.test(b.family);
        const below = textish ? inCol.filter(c => cy(c) >= cy(b) - 5) : [];
        let best: Box;
        if (below.length) {
            best = below.sort((a, z) => (cy(a) - cy(b)) - (cy(z) - cy(b)))[0];
        } else if (textish && inCol.length) {
            best = inCol.sort((a, z) => Math.abs(cy(b) - cy(a)) - Math.abs(cy(b) - cy(z)))[0];
        } else {
            // Price-block fonts (and off-column text): prices sit RIGHT of
            // their tile's text column — the legacy left-of + vertical score
            // is the correct discriminator (in-column proximity is a trap:
            // the adjacent tile's code often aligns by coincidence).
            // Horizontal travel cap: a tile is ~230px wide — price-block
            // boxes further than ~280px right of a code can't be its own
            // (they leak from CODE-LESS inset promos; better dropped than
            // attached to the wrong tile).
            const capped = eligible.filter(c => b.left - c.left <= 280);
            if (!capped.length) continue;
            best = capped
                .map(c => ({ c, score: Math.abs(cy(b) - cy(c)) + 0.3 * Math.max(0, b.left - c.left) }))
                .sort((a, z) => a.score - z.score)[0].c;
        }
        tiles.get(best)!.push(b);
    }

    const out: LeafletProduct[] = [];
    for (const [code, els] of tiles) {
        // Name lines sit in the SAME COLUMN as the code (validated across tiles)
        // — the column constraint stops glued names from neighboring tiles.
        let nameParts = els
            .filter(b => /CondPro$/.test(b.family) && b.size >= 13 && b.size <= 20 && !/^\d/.test(b.text)
                && Math.abs(b.left - code.left) <= 45)
            .sort((a, z) => a.top - z.top);
        // Contiguity: a name is ONE ~17px-pitch line stack. On dense same-brand
        // walls two stacked tiles fall in one column — keep only the stack
        // CLOSEST ABOVE the code, cutting at the first vertical gap > 26px.
        if (nameParts.length > 1) {
            const below = nameParts.filter(b => b.top <= code.top + 50);
            const stack = below.length ? below : nameParts;
            const kept: Box[] = [stack[stack.length - 1]];
            for (let i = stack.length - 2; i >= 0; i--) {
                if (kept[0].top - stack[i].top <= 26 + stack[i].h) kept.unshift(stack[i]);
                else break;
            }
            nameParts = kept;
        }
        const name = nameParts.map(b => b.text).join(' ').replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
        if (!name) continue;

        const promoBoxes = els.filter(b => /FontPrice/.test(b.family) && /^\d+,\d{2}$/.test(b.text));
        const oldBoxes = els.filter(b => /Pro-Book/.test(b.family) && !/CondPro/.test(b.family)
            && b.size >= 13 && b.size <= 30 && /^\d+,\d{2}$/.test(b.text));
        if (!promoBoxes.length) continue; // decorative tile / no price
        // Multiple big-price boxes in one tile = a neighbor's stray — the box
        // closest to the code is the tile's own price.
        const bigPrice = num(promoBoxes.sort((a, z) => Math.abs(cy(a) - cy(code)) - Math.abs(cy(z) - cy(code)))[0].text);
        const oldPrice = oldBoxes.length ? num(oldBoxes.sort((a, z) => z.size - a.size)[0].text) : null;

        const pctBox = els.find(b => /^-\d+\s*[﹪%]$/.test(b.text));
        const pct = pctBox ? Number(pctBox.text.match(/\d+/)![0]) : null;
        const lidlPlus = els.some(b => /Su Lidl Plus/i.test(b.text));

        // pack / weighable — detail LINES are semantically distinct: a €/kg line
        // ("1 kg = 8,25 €"), a multipack ("6 x 35 g"), a plain size ("40 g", "1 l"),
        // a "Parduodamos 400 g pakuotėmis" sentence, or a count ("10 vnt.").
        // Details (pack/€-per-kg lines) sit in the CODE's own column, same as
        // names — the column constraint stops neighbor-box steals (a stray
        // "250 ml" was crossing tiles).
        const detailBoxes = els.filter(b => /CondPro-Book/.test(b.family)
            && !CODE_RE.test(b.text) && Math.abs(b.left - code.left) <= 45);
        const detail = detailBoxes.map(b => b.text).join(' ');
        let amount: number | null = null, unit: string | null = null, isWeighable = false;
        for (const b of detailBoxes) {
            let t = b.text.trim();
            // combined "220 g / 1 kg = 36,32 €" → evaluate the SIZE part only
            const combo = t.match(/^(.+?)\s*\/\s*1\s*(?:kg|l)\s*=/i);
            if (combo) t = combo[1].trim();
            if (/=\s*\d/.test(t)) continue; // €/kg comparison line
            let m: RegExpMatchArray | null;
            if ((m = t.match(/Parduodam\w*\s+(\d+(?:,\d+)?)\s*(g|kg|ml|l)\b/i))) { amount = num(m[1]); unit = m[2].toLowerCase(); break; }
            if ((m = t.match(/^(\d+)\s*[x×]\s*(\d+(?:,\d+)?)\s*(g|kg|ml|l)\.?$/i))) { amount = +(Number(m[1]) * num(m[2])).toFixed(3); unit = m[3].toLowerCase(); break; }
            if ((m = t.match(/^(\d+(?:,\d+)?)\s*(g|kg|ml|l)\.?$/i))) { amount = num(m[1]); unit = m[2].toLowerCase(); break; }
            if ((m = t.match(/^(\d+)\s*vnt\.?$/i))) { amount = Number(m[1]); unit = 'vnt'; break; }
        }
        // "1 kg" is WEIGHABLE only on fresh-produce tiles (5-digit codes);
        // a packaged 1 kg item (sugar, flour — 6/7-digit codes) is a fixed pack.
        const codeId = code.text.match(/\d{4,7}/)![0];
        if (amount === 1 && unit === 'kg' && codeId.length === 5) isWeighable = true;

        // per-tile window > page header > flyer window
        const winBox = els.find(b => /^\d{2} \d{2}[–-]\d{2} \d{2}$/.test(b.text));
        const win = (winBox ? parseWindow(winBox.text, refYear) : null) ?? headerWin ?? { start: offerStart, end: offerEnd };

        // ── self-validation ─────────────────────────────────────────────────
        let flagged: string | null = null;
        // A name starting lowercase lost its head line to a neighboring tile
        // (contiguity cut) — never insert a truncated name.
        if (/^[a-ząčęėįšųūž]/.test(name)) flagged = 'truncated name (lowercase start)';
        const regularPrice = oldPrice ?? bigPrice;
        const promoPrice = oldPrice != null ? bigPrice : null;
        if (promoPrice != null && promoPrice >= regularPrice) flagged = 'promo>=regular';
        if (!flagged && pct != null && oldPrice != null) {
            const impliedPct = (1 - bigPrice / oldPrice) * 100;
            if (Math.abs(impliedPct - pct) > 8) flagged = `pct mismatch: printed -${pct}% vs implied -${impliedPct.toFixed(0)}%`;
        }
        const perKg = detail.match(/1 kg =\s*(\d+(?:,\d+)?)\s*€/i);
        if (!flagged && perKg && amount != null && (unit === 'g' || unit === 'kg')) {
            const kg = unit === 'g' ? amount / 1000 : amount;
            const implied = num(perKg[1]) * kg;
            if (Math.abs(implied - bigPrice) > 0.06) flagged = `€/kg mismatch: ${perKg[1]}€/kg × ${kg}kg = ${implied.toFixed(2)} vs ${bigPrice}`;
        }

        const base: LeafletProduct = {
            name, itemCode: codeId, itemCodes: groupCodes.get(code) ?? [codeId],
            regularPrice, promoPrice,
            amount, unit, isWeighable, lidlPlus,
            promoStart: win.start > now ? win.start : null,
            promoEnd: win.end,
            page: pageNo, flyer: flyerId, flagged,
        };

        // ── "arba" VARIANT EXPANSION ─────────────────────────────────────────
        // A tile like "CIDO Gaivusis gėrimas / Levandų ir persikų arba kinrožių
        // ir greipfrutų skonio / codes 7613622 7613623" is N distinct products
        // sharing one price. When the flavor prose splits on "arba" into
        // EXACTLY as many parts as there are codes, emit one product per
        // variant (codes pair with variants in print order — Lidl's
        // convention; a receipt-name mismatch would surface via the code
        // evidence flywheel). Any count mismatch → keep the umbrella.
        const codesAll = base.itemCodes;
        const prose = detailBoxes
            .filter(b => {
                const t = b.text.trim();
                return !/=\s*\d/.test(t) && !CODE_RE.test(t)
                    && !/^\d+(?:,\d+)?\s*(g|kg|ml|l|vnt)\b/i.test(t)
                    && !/^Parduodam/i.test(t) && !/^Įvairių/i.test(t)
                    && !/^\+/.test(t) && !/^\d{2} \d{2}/.test(t)
                    && !/€/.test(t) && !/^[\/\d.,\s]+$/.test(t);
            })
            .sort((a, z) => a.top - z.top)
            .map(b => b.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
        if (!flagged && codesAll.length >= 2 && /\barba\b/i.test(prose)) {
            const parts = prose.split(/\s+arba\s+/i).map(p => p.trim()).filter(Boolean);
            if (parts.length === codesAll.length) {
                // Shared grammatical tail ("… skonio") belongs to every variant.
                const tail = parts[parts.length - 1].match(/\b(skonio|sk\.)$/i)?.[1];
                const variants = parts.map(p =>
                    tail && !new RegExp(`\\b${tail.replace('.', '\\.')}$`, 'i').test(p) ? `${p} ${tail}` : p);
                // Per-variant sizes when a slash-list matches the count ("462 g / 476 g").
                const sizeList = detailBoxes
                    .map(b => b.text.trim())
                    .map(t => t.match(/^(\d+(?:,\d+)?\s*(?:g|kg|ml|l))(\s*\/\s*\d+(?:,\d+)?\s*(?:g|kg|ml|l))+$/i) ? t.split('/') : null)
                    .find(x => x && x.length === codesAll.length);
                variants.forEach((v, i) => {
                    let vAmount = base.amount, vUnit = base.unit;
                    const sm = sizeList?.[i]?.trim().match(/^(\d+(?:,\d+)?)\s*(g|kg|ml|l)$/i);
                    if (sm) { vAmount = num(sm[1]); vUnit = sm[2].toLowerCase(); }
                    out.push({
                        ...base,
                        name: `${name} ${v.charAt(0).toUpperCase()}${v.slice(1)}`,
                        itemCode: codesAll[i], itemCodes: [codesAll[i]],
                        amount: vAmount, unit: vUnit,
                    });
                });
                continue;
            }
        }

        out.push(base);
    }
    return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runLidlLeafletScraper(): Promise<void> {
    console.log('[LidlLeaflet] Starting leaflet scrape…');
    let inserted = 0, skipped = 0, spCreated = 0, productCreated = 0, flaggedCount = 0, errors = 0;
    try {
        const items = await collectLeafletProducts();
        for (const it of items) {
            if (it.flagged) { flaggedCount++; console.warn(`[LidlLeaflet] DROP flagged "${it.name}": ${it.flagged}`); continue; }
            try {
                // CODE-AWARE fan-out: codes already resolved to a DEDICATED SP
                // (single-code mapping — a graduated umbrella variant) get the
                // tile price on THEIR OWN history; only the leftover codes ride
                // the umbrella below.
                let leftoverCodes = it.itemCodes;
                if (it.itemCodes.length > 1) {
                    const [maps]: any = await pool.query(
                        `SELECT spc.code, spc.storeProductId,
                                (SELECT COUNT(*) FROM StoreProductCode x WHERE x.storeProductId = spc.storeProductId) AS codeCount
                           FROM StoreProductCode spc WHERE spc.chainId = ? AND spc.code IN (?)`,
                        [LIDL_CHAIN_ID, it.itemCodes.map(c => c.replace(/^0+/, ''))],
                    );
                    const dedicated = (maps as any[]).filter(m => Number(m.codeCount) === 1);
                    for (const d of dedicated) {
                        const r2 = await upsertPriceForSpId(
                            Number(d.storeProductId), LIDL_CHAIN_ID, null,
                            it.regularPrice, it.promoPrice, it.promoEnd, false, it.promoStart,
                        );
                        if (r2 === 'inserted') inserted++; else skipped++;
                    }
                    const dedicatedCodes = new Set(dedicated.map(d => String(d.code)));
                    leftoverCodes = it.itemCodes.filter(c => !dedicatedCodes.has(c.replace(/^0+/, '')));
                    if (!leftoverCodes.length) continue; // fully resolved — umbrella retired
                }
                const r = await upsertPromo({
                    chainId: LIDL_CHAIN_ID,
                    storeProductName: it.name,
                    amount: it.amount,
                    unit: it.unit,
                    isWeighable: it.isWeighable,
                    imageUrl: null,
                    itemCodes: it.itemCodes,
                    regularPrice: it.regularPrice,
                    promoPrice: it.promoPrice,
                    promoStart: it.promoStart,
                    promoEnd: it.promoEnd,
                });
                if (r === 'skipped')              skipped++;
                else if (r === 'sp_created')      spCreated++;
                else if (r === 'product_created') { spCreated++; productCreated++; }
                else inserted++;
            } catch (e: any) {
                errors++;
                console.warn(`[LidlLeaflet] upsert failed for "${it.name}": ${e.message}`);
            }
        }
        const summary = `[LidlLeaflet] Done — inserted: ${inserted}, skipped: ${skipped}, new SPs: ${spCreated}, new Products: ${productCreated}, dropped-flagged: ${flaggedCount}, errors: ${errors}`;
        console.log(summary);
        await notifyTelegram(
            `✅ <b>Lidl leaflet</b> scrape done\n📦 Inserted: ${inserted}\n⏭ Skipped: ${skipped}\n` +
            `🆕 New SPs: ${spCreated} (${productCreated} new Products)\n` +
            (flaggedCount ? `🚩 Dropped flagged: ${flaggedCount}\n` : '') +
            (errors ? `⚠️ Errors: ${errors}\n` : ''),
        );
    } catch (e: any) {
        console.error(`[LidlLeaflet] scrape failed: ${e.message}`);
        throw e;
    }
}

export async function collectLeafletProducts(opts?: { flyerIds?: string[]; maxFlyers?: number }): Promise<LeafletProduct[]> {
    const ids = opts?.flyerIds ?? await discoverFlyerIds();
    console.log(`[LidlLeaflet] flyers: ${ids.join(', ') || '(none found)'}`);
    const out: LeafletProduct[] = [];
    const workDir = await mkdtemp(join(tmpdir(), 'lidl-leaflet-'));
    try {
        for (const id of ids.slice(0, opts?.maxFlyers ?? 4)) {
            const meta = await fetchFlyerMeta(id);
            if (!meta) { console.warn(`[LidlLeaflet] no meta for ${id}`); continue; }
            if (meta.offerEnd < new Date()) { console.log(`[LidlLeaflet] ${id} window ended — skip`); continue; }
            const pdfRes = await fetch(meta.pdfUrl);
            if (!pdfRes.ok) { console.warn(`[LidlLeaflet] pdf HTTP ${pdfRes.status} for ${id}`); continue; }
            const pdfPath = join(workDir, `${id.replace(/[^a-z0-9-]/gi, '')}.pdf`);
            await writeFile(pdfPath, Buffer.from(await pdfRes.arrayBuffer()));
            const pages = await pdfToPages(pdfPath, workDir);
            let count = 0;
            pages.forEach((boxes, i) => {
                if (i === 0) return; // cover page = collage of inside-page tiles (dups, glued)
                const items = parsePage(boxes, i + 1, id, meta.offerStart, meta.offerEnd);
                count += items.length;
                out.push(...items);
            });
            console.log(`[LidlLeaflet] ${id}: ${pages.length} pages → ${count} products (window ${meta.offerStart.toISOString().slice(0, 10)}→${meta.offerEnd.toISOString().slice(0, 10)})`);
        }
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
    return out;
}
