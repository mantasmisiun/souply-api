import { readFileSync } from 'node:fs';

/**
 * RECIPE SWEEP DIFF — what a change did to matching quality, row by row.
 *
 *   npm run recipes:diff -- before.jsonl after.jsonl [--all]
 *
 * A summary percentage cannot tell an improvement from a trade: a fix that
 * gains twenty rows and quietly loses five reads as "+15" and ships the five.
 * This lists every row whose PRODUCT or CONFIDENCE changed, split into gains
 * and losses, so the losses have to be looked at and defended one at a time.
 *
 * Rows are keyed by (url + raw ingredient line), which is stable across runs
 * because the corpus is frozen.
 */

const args = process.argv.slice(2);
const [beforePath, afterPath] = args.filter(a => !a.startsWith('--'));
const SHOW_ALL = args.includes('--all');

interface Row {
    url: string; raw: string; site: string; lang: string;
    name: string | null; productId: number | null; productName: string | null;
    confidence: number | null; confident: boolean; reviewReason: string | null;
    measureQty: number | null; measureUnit: string | null;
    shopQuantity: number; shopUnit: string;
}

const load = (p: string): Map<string, Row> => {
    const m = new Map<string, Row>();
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as Row;
        m.set(`${r.url}||${r.raw}`, r);
    }
    return m;
};

const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`);
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const main = () => {
    if (!beforePath || !afterPath) {
        console.error('usage: recipes:diff -- <before.jsonl> <after.jsonl> [--all]');
        process.exit(1);
    }
    const before = load(beforePath);
    const after = load(afterPath);

    const stat = (m: Map<string, Row>) => {
        const rows = [...m.values()];
        const matched = rows.filter(r => r.productId != null);
        return {
            n: rows.length,
            matched: matched.length,
            confident: matched.filter(r => r.confident).length,
            named: rows.filter(r => (r.name ?? '').match(/[0-9:/]/)).length,
        };
    };
    const b = stat(before), a = stat(after);
    console.log('                     before        after');
    console.log(`rows               ${String(b.n).padStart(6)}       ${String(a.n).padStart(6)}`);
    console.log(`matched            ${String(b.matched).padStart(6)} ${pct(b.matched, b.n)}  ${String(a.matched).padStart(6)} ${pct(a.matched, a.n)}`);
    console.log(`confident          ${String(b.confident).padStart(6)} ${pct(b.confident, b.matched)}  ${String(a.confident).padStart(6)} ${pct(a.confident, a.matched)}`);
    console.log(`names w/ digit,:,/ ${String(b.named).padStart(6)} ${pct(b.named, b.n)}  ${String(a.named).padStart(6)} ${pct(a.named, a.n)}`);

    const changed: { key: string; b: Row; a: Row }[] = [];
    for (const [k, bb] of before) {
        const aa = after.get(k);
        if (!aa) continue;
        if (bb.productId !== aa.productId || bb.confident !== aa.confident
            || bb.name !== aa.name || bb.measureQty !== aa.measureQty
            || bb.shopQuantity !== aa.shopQuantity) changed.push({ key: k, b: bb, a: aa });
    }

    /**
     * A row got BETTER if it stopped being a silent match, or found a product it
     * did not have. It got WORSE if it lost a product it had, or started being
     * silent about a product it was previously unsure of. Everything else is a
     * swap that a human has to judge — which is the point of printing them.
     */
    const gained = changed.filter(c => c.b.productId == null && c.a.productId != null);
    const lost = changed.filter(c => c.b.productId != null && c.a.productId == null);
    const swapped = changed.filter(c => c.b.productId != null && c.a.productId != null
        && c.b.productId !== c.a.productId);
    const nowQuiet = changed.filter(c => !c.b.confident && c.a.confident && c.b.productId === c.a.productId);
    const nowAsks = changed.filter(c => c.b.confident && !c.a.confident && c.b.productId === c.a.productId);
    const requantified = changed.filter(c => c.b.productId === c.a.productId
        && (c.b.measureQty !== c.a.measureQty || c.b.shopQuantity !== c.a.shopQuantity));

    const show = (title: string, list: typeof changed, fmt: (c: typeof changed[number]) => string) => {
        if (list.length === 0) return;
        console.log(`\n${title} — ${list.length}`);
        for (const c of (SHOW_ALL ? list : list.slice(0, 25))) console.log(`  ${fmt(c)}`);
        if (!SHOW_ALL && list.length > 25) console.log(`  … ${list.length - 25} more (pass --all)`);
    };

    show('FOUND a product', gained, c => `${trunc(c.a.name ?? '', 30).padEnd(30)} → ${trunc(c.a.productName ?? '', 40)}`);
    show('LOST its product (defend every one)', lost, c => `${trunc(c.b.name ?? '', 30).padEnd(30)} ✗ was ${trunc(c.b.productName ?? '', 36)}`);
    show('SWAPPED product', swapped, c =>
        `${trunc(c.a.name ?? '', 26).padEnd(26)} ${trunc(c.b.productName ?? '', 30).padEnd(30)} → ${trunc(c.a.productName ?? '', 30)}`);
    show('now ASKS instead of assuming', nowAsks, c => `${trunc(c.a.name ?? '', 30).padEnd(30)} ${trunc(c.a.productName ?? '', 36)}`);
    show('now SILENT where it used to ask (defend every one)', nowQuiet, c =>
        `${trunc(c.a.name ?? '', 30).padEnd(30)} ${trunc(c.a.productName ?? '', 36)}`);
    show('amount changed', requantified, c =>
        `${trunc(c.a.name ?? '', 26).padEnd(26)} ${c.b.measureQty ?? '—'} ${c.b.measureUnit ?? ''} → ${c.a.measureQty ?? '—'} ${c.a.measureUnit ?? ''}`
        + `   buy ${c.b.shopQuantity} ${c.b.shopUnit} → ${c.a.shopQuantity} ${c.a.shopUnit}`);

    console.log(`\n${changed.length} row(s) changed of ${before.size}`);
};

main();
