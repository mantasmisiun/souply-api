import '../config/env.js';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchRecipeHtml } from '../services/recipes/recipeScraper.js';

/**
 * RECIPE HARVESTER — turn a list of URLs into a frozen offline corpus.
 *
 *   npm run recipes:harvest -- --urls a.jsonl,b.jsonl --out <dir> [--concurrency 6] [--refetch]
 *
 * INCREMENTAL: a page already stored in <dir> is reused, not re-fetched, so a
 * corpus can be grown a list at a time without hammering the sites again (and
 * without the second run silently dropping the first run's pages from the
 * manifest). `--refetch` forces a fresh copy of everything.
 *
 * Why freeze the pages: matching quality has to be measured the same way twice —
 * before a fix and after it. Sweeping live re-fetches 160 pages every run (slow,
 * rate-limited, and the sites change under you), so a regression sweep would
 * never be comparable. Fetch once, then every later sweep reads the same bytes.
 *
 * Input lines are JSONL: {"url": "...", "site": "...", "lang": "lt", "dish": "soup"}
 * Output is <dir>/*.html plus <dir>/manifest.json, which is exactly what
 * `npm run recipes:sweep -- --dir <dir>` consumes.
 */

const args = process.argv.slice(2);
const argOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

interface UrlRow { url: string; site?: string; lang?: string; dish?: string; title?: string }

const slugOf = (url: string): string => {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '_');
        const path = u.pathname.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        return `${host}__${path}`.slice(0, 110);
    } catch {
        return `bad__${Math.abs(hash(url))}`;
    }
};

const hash = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
};

const run = async () => {
    const urlFiles = (argOf('--urls') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const out = argOf('--out');
    const concurrency = Math.max(1, Math.min(10, Number(argOf('--concurrency') ?? '6')));
    const refetch = args.includes('--refetch');
    if (urlFiles.length === 0 || !out) {
        console.error('usage: recipes:harvest -- --urls <a.jsonl[,b.jsonl]> --out <dir> [--concurrency 6]');
        process.exit(1);
    }
    mkdirSync(out, { recursive: true });

    const rows: UrlRow[] = [];
    const seen = new Set<string>();
    for (const f of urlFiles) {
        for (const line of readFileSync(f, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try {
                const row = JSON.parse(t) as UrlRow;
                if (!row.url || seen.has(row.url)) continue;
                seen.add(row.url);
                rows.push(row);
            } catch { /* a malformed line is not worth failing the run over */ }
        }
    }
    console.log(`${rows.length} unique URL(s) from ${urlFiles.length} file(s)`);

    const manifest: (UrlRow & { file: string })[] = [];
    const failures: { url: string; reason: string }[] = [];
    let done = 0, next = 0, reused = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= rows.length) return;
            const row = rows[i];
            const cached = join(out, `${slugOf(row.url)}.html`);
            if (!refetch && existsSync(cached) && statSync(cached).size > 0) {
                manifest.push({ ...row, file: `${slugOf(row.url)}.html` });
                reused++;
                done++;
                continue;
            }
            try {
                const { html, finalUrl } = await fetchRecipeHtml(row.url);
                // A page with no ingredient markup at all is not worth storing:
                // the sweep would just count it as "not a recipe" every run.
                if (!/recipeIngredient|wprm-recipe-ingredient|itemprop="ingredients"/.test(html)) {
                    failures.push({ url: row.url, reason: 'no ingredient markup' });
                } else {
                    const file = `${slugOf(row.url)}.html`;
                    writeFileSync(join(out, file), html, 'utf8');
                    manifest.push({ ...row, url: finalUrl, file });
                }
            } catch (e: any) {
                failures.push({ url: row.url, reason: String(e?.code ?? e?.message ?? e).slice(0, 40) });
            }
            done++;
            if (done % 20 === 0) console.log(`  … ${done}/${rows.length}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
    console.log(`\nstored ${manifest.length} page(s) in ${out} (${reused} reused, ${manifest.length - reused} fetched)`);
    if (failures.length > 0) {
        console.log(`${failures.length} failed:`);
        for (const f of failures.slice(0, 30)) console.log(`  ${f.reason.padEnd(22)} ${f.url}`);
    }
    const bySite = new Map<string, number>();
    for (const m of manifest) bySite.set(m.site ?? '?', (bySite.get(m.site ?? '?') ?? 0) + 1);
    console.log('\nper site:');
    [...bySite.entries()].sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`  ${String(n).padStart(3)}  ${s}`));
    process.exit(0);
};

run().catch(e => { console.error(e); process.exit(1); });
