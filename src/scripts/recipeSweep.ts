import '../config/env.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pool from '../config/db.js';
import { parseIngredientLine } from '../services/recipes/ingredientParser.js';
import { findIngredient, formatMeasure, toMetric } from '../services/recipes/measure.js';
import { matchIngredient } from '../services/recipes/recipeMatcher.js';
import { extractRecipe, fetchRecipeHtml } from '../services/recipes/recipeScraper.js';

/**
 * RECIPE IMPORT SWEEP — the harness that answers the only question that matters:
 * does the product we put in the basket match what the recipe asked for?
 *
 *   npm run recipes:sweep -- --dir <folder of saved .html>   # offline, repeatable
 *   npm run recipes:sweep -- --url https://…                 # one live page
 *   npm run recipes:sweep -- --dir <folder> --quiet          # totals only
 *   npm run recipes:sweep -- --dir <folder> --json out.jsonl # the diagnostic table
 *
 * Read the per-ingredient lines, not just the summary. A high match rate with
 * the wrong products is exactly the failure this exists to catch, and only a
 * human reading "aliejaus → Alyvuogių aliejus" can confirm it.
 *
 * Read-only: it never writes a template and never touches a user's data.
 */

const args = process.argv.slice(2);
const argOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const QUIET = args.includes('--quiet');
/** One JSONL row per ingredient, with every field a reviewer needs to judge the
 *  match — the input table for comparing runs and for spotting bad-match classes
 *  that a summary percentage hides. */
const JSON_OUT = argOf('--json');
const LIMIT = Number(argOf('--limit') ?? '0') || Infinity;

interface Row { site: string; title: string; ok: boolean; line: string }

const bar = (n: number, d: number) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`);

const run = async () => {
    const sources: { html: string; url: string; dish?: string | null }[] = [];

    const dir = argOf('--dir');
    if (dir) {
        const manifestPath = join(dir, 'manifest.json');
        let manifest: { file: string; url: string; dish?: string }[] = [];
        try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
            // No manifest: fall back to the file names, with a placeholder URL.
            manifest = readdirSync(dir).filter(f => f.endsWith('.html'))
                .map(f => ({ file: f, url: `file://${join(dir, f)}` }));
        }
        for (const m of manifest.slice(0, LIMIT)) {
            try {
                sources.push({
                    html: readFileSync(join(dir, m.file), 'utf8'), url: m.url,
                    dish: (m as any).dish ?? null,
                });
            } catch { /* skip */ }
        }
    }

    const url = argOf('--url');
    if (url) {
        const fetched = await fetchRecipeHtml(url);
        sources.push({ html: fetched.html, url: fetched.finalUrl });
    }

    if (sources.length === 0) {
        console.error('nothing to sweep — pass --dir <folder> and/or --url <link>');
        process.exit(1);
    }

    let recipes = 0, skippedPages = 0;
    let ingredients = 0, known = 0, measured = 0, pantry = 0;
    let matched = 0, confident = 0, unmatched = 0;
    const unmatchedNames = new Map<string, number>();
    const jsonRows: any[] = [];
    const lowConfidence: Row[] = [];
    const reasons = new Map<string, number>();

    for (const src of sources) {
        let recipe;
        try { recipe = extractRecipe(src.html, src.url); } catch { skippedPages++; continue; }
        recipes++;
        if (!QUIET) {
            console.log(`\n\x1b[1m${recipe.title}\x1b[0m  (${recipe.site}, ${recipe.lang}, ${recipe.extractor}`
                + `${recipe.servings ? `, ${recipe.servings} servings` : ''})`);
        }

        for (const line of recipe.ingredientLines) {
            for (const parsed of parseIngredientLine(line, recipe.lang)) {
                if (parsed.ignored) continue;
                ingredients++;

                const hit = findIngredient(parsed.nameFull || parsed.name) ?? findIngredient(parsed.name);
                if (hit) known++;
                if (hit?.info.pantry) pantry++;
                if (toMetric(parsed, hit?.info ?? null).qty != null) measured++;

                const m = await matchIngredient(parsed, recipe.lang);
                const amount = formatMeasure(m.measure, recipe.lang) ?? '—';

                if (m.product) {
                    matched++;
                    if (m.confident) confident++;
                    else {
                        reasons.set(m.reviewReason ?? 'unknown', (reasons.get(m.reviewReason ?? 'unknown') ?? 0) + 1);
                        lowConfidence.push({ site: recipe.site, title: recipe.title, ok: false, line: parsed.raw });
                    }
                } else {
                    unmatched++;
                    const k = parsed.name.toLowerCase();
                    unmatchedNames.set(k, (unmatchedNames.get(k) ?? 0) + 1);
                }

                if (JSON_OUT) {
                    const alt = m.alternatives[0];
                    jsonRows.push({
                        url: recipe.sourceUrl, site: recipe.site, lang: recipe.lang,
                        dish: (src as any).dish ?? null, recipeTitle: recipe.title,
                        extractor: recipe.extractor,
                        raw: parsed.raw,
                        name: parsed.name, nameFull: parsed.nameFull,
                        qty: parsed.quantity, qtyMax: parsed.quantityMax, unit: parsed.unit,
                        note: parsed.note, optional: parsed.optional, toTaste: parsed.toTaste,
                        measureQty: m.measure.qty, measureUnit: m.measure.unit, measureApprox: m.measure.approx,
                        amountText: amount === '—' ? null : amount,
                        lexiconKey: m.key, pantry: m.pantry, query: m.query,
                        productId: m.product?.productId ?? null,
                        productName: m.product?.name ?? null,
                        productWeighable: m.product?.isWeighable ?? null,
                        packAmount: m.product?.packAmount ?? null,
                        packUnit: m.product?.packUnit ?? null,
                        confidence: m.product?.confidence ?? null,
                        confident: m.confident,
                        reviewReason: m.reviewReason,
                        shopQuantity: m.shopQuantity, shopUnit: m.shopUnit,
                        altCount: m.alternatives.length,
                        altName: alt?.name ?? null, altConfidence: alt?.confidence ?? null,
                    });
                }

                if (QUIET) continue;
                const flag = !m.product ? '\x1b[31m ✗\x1b[0m'
                    : m.confident ? '\x1b[32m ✓\x1b[0m'
                    : '\x1b[33m ?\x1b[0m';
                const conf = m.product ? m.product.confidence.toFixed(2) : '----';
                const why = m.product && !m.confident ? ` \x1b[90m${m.reviewReason}\x1b[0m` : '';
                console.log(
                    `${flag} ${amount.padStart(10)}  ${trunc(parsed.name, 26)}`
                    + ` → ${trunc(m.product?.name ?? '(no product)', 30)}`
                    + ` ${conf}  buy ${m.shopQuantity} ${m.shopUnit}`
                    + `${m.pantry ? ' \x1b[90m[pantry]\x1b[0m' : ''}${why}`);
            }
        }
    }

    console.log('\n' + '─'.repeat(72));
    console.log(`pages          ${sources.length}  (${recipes} recipes, ${skippedPages} not a recipe)`);
    console.log(`ingredients    ${ingredients}`);
    console.log(`  recognised   ${known} ${bar(known, ingredients)}   (in the ingredient table)`);
    console.log(`  measured     ${measured} ${bar(measured, ingredients)}   (a real amount, converted)`);
    console.log(`  pantry       ${pantry} ${bar(pantry, ingredients)}   (offered for one-glance removal)`);
    console.log(`  matched      ${matched} ${bar(matched, ingredients)}   (a catalog product)`);
    console.log(`    confident  ${confident} ${bar(confident, matched)} of matched`);
    console.log(`    to review  ${matched - confident}`);
    console.log(`  unmatched    ${unmatched} ${bar(unmatched, ingredients)}`);
    if (reasons.size > 0) {
        console.log('\nwhy a match was sent to review:');
        [...reasons.entries()].sort((a, b) => b[1] - a[1])
            .forEach(([r, n]) => console.log(`  ${String(n).padStart(4)}  ${r}`));
    }

    if (unmatchedNames.size > 0) {
        console.log('\nmost common unmatched ingredients:');
        [...unmatchedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
            .forEach(([name, n]) => console.log(`  ${String(n).padStart(3)}  ${name}`));
    }
    if (JSON_OUT) {
        writeFileSync(JSON_OUT, jsonRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        console.log(`\n${jsonRows.length} row(s) → ${JSON_OUT}`);
    }
    await pool.end();
};

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

run().catch(async e => { console.error(e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
