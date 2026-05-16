/**
 * Interactive CLI for promoting provisional truth files (auto-
 * bootstrapped from a parser run) to hand-verified ground truth.
 *
 * Flow per file:
 *   1. Load the truth file (only acts on `provisional: true`).
 *   2. Load the matching parsedData.json from the latest batch run.
 *   3. Diff every field — store header, receipt header, each product.
 *      Products pair by exact name; the leftovers from each side
 *      become MISSED (in truth, not in parser) and EXTRA (in parser,
 *      not in truth).
 *   4. For each diff, prompt the user to keep / update / drop / add.
 *   5. After all diffs resolved, prompt to mark the file as verified
 *      (drops the `provisional` flag).
 *   6. Quit any time — partial progress is saved on each Y/N/k/u
 *      action that mutates the in-memory truth.
 *
 * Usage:
 *   npx tsx src/scripts/reviewProvisionalTruth.ts
 *   npx tsx src/scripts/reviewProvisionalTruth.ts maxima
 *   npx tsx src/scripts/reviewProvisionalTruth.ts maxima kvitas_2025-11-08.pdf
 */

import { promises as fs } from 'fs';
import { resolve, join } from 'path';
import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';

const LOGS_ROOT = resolve(process.cwd(), 'receipts/_logs');
const TRUTHS_ROOT = resolve(process.cwd(), '../shared/receipts');

interface TruthProduct {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    amount: number;
    unit: string;
    isWeighable: boolean;
    pricePerUnit: number | null;
}

interface TruthFile {
    $schema: string;
    provisional?: boolean;
    source: { pdf: string; annotatedAt: string };
    store: { chainName: string; storeCode: string; name: string; address: string };
    receipt: {
        receiptNo: string;
        date: string;
        totalAmount: number;
        totalSavings: number;
    };
    products: TruthProduct[];
}

interface ParsedProduct {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    pricePerUnit: number | null;
}

interface ParsedData {
    header?: { chainName?: string; storeCode?: string; storeAddress?: string };
    footer?: {
        total?: number | null;
        date?: string | null;
        time?: string | null;
        receiptNo?: string | null;
        totalSavings?: number | null;
    };
    products?: ParsedProduct[];
}

const rl = readline.createInterface({ input: stdin, output: stdout });

async function prompt(q: string): Promise<string> {
    const a = await rl.question(q);
    return a.trim();
}

const argv = process.argv.slice(2);
const chainArg = argv[0] ?? null;
const pdfArg = argv[1] ?? null;

function fmt(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return `"${v}"`;
    return String(v);
}

/** Returns null if no diff, else a human-readable label of the diff. */
function diffField(label: string, truthVal: unknown, parserVal: unknown): string | null {
    // Treat 0 vs null as different. Treat number tolerance as exact —
    // truth was built from parser output, so any drift means a real
    // semantic change worth surfacing.
    if (typeof truthVal === 'number' && typeof parserVal === 'number') {
        if (Math.abs(truthVal - parserVal) < 1e-6) return null;
    } else if (truthVal === parserVal) {
        return null;
    } else if (
        truthVal === null && parserVal === null
    ) {
        return null;
    }
    return `${label}: truth=${fmt(truthVal)}  parser=${fmt(parserVal)}`;
}

function parserToTruthProduct(p: ParsedProduct): TruthProduct {
    const isWeighable = (p.unit ?? '').toLowerCase() === 'kg';
    return {
        name: p.name,
        price: p.price,
        promoPrice: p.promoPrice ?? null,
        quantity: isWeighable ? 1 : p.quantity,
        amount: isWeighable ? p.quantity : 1,
        unit: p.unit,
        isWeighable,
        pricePerUnit: p.pricePerUnit ?? null,
    };
}

interface PairResult {
    pairs: { truthIdx: number; parserIdx: number }[];
    missed: number[]; // truth indices with no parser pair
    extra: number[]; // parser indices with no truth pair
}

/** Pair products greedily by exact name match (case-insensitive,
 *  whitespace-normalized). What's left over is MISSED / EXTRA. */
function pairProducts(
    truth: TruthProduct[],
    parser: TruthProduct[],
): PairResult {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const parserUsed = new Set<number>();
    const pairs: { truthIdx: number; parserIdx: number }[] = [];
    const missed: number[] = [];
    for (let i = 0; i < truth.length; i++) {
        const tn = norm(truth[i].name);
        const j = parser.findIndex((p, idx) => !parserUsed.has(idx) && norm(p.name) === tn);
        if (j >= 0) {
            parserUsed.add(j);
            pairs.push({ truthIdx: i, parserIdx: j });
        } else {
            missed.push(i);
        }
    }
    const extra: number[] = [];
    for (let j = 0; j < parser.length; j++) {
        if (!parserUsed.has(j)) extra.push(j);
    }
    return { pairs, missed, extra };
}

async function reviewFile(chain: string, pdf: string): Promise<void> {
    const base = pdf.replace(/\.(pdf|png|jpg|jpeg)$/i, '');
    const truthPath = join(TRUTHS_ROOT, chain, `${base}.truth.json`);
    const parsedPath = join(LOGS_ROOT, chain, pdf, 'parsedData.json');

    let truth: TruthFile;
    try {
        truth = JSON.parse(await fs.readFile(truthPath, 'utf8'));
    } catch {
        console.log(`[review] ${chain}/${base}: no truth file, skipping`);
        return;
    }
    if (truth.provisional !== true) {
        // Already verified or never provisional — nothing to do.
        return;
    }
    let parsed: ParsedData;
    try {
        parsed = JSON.parse(await fs.readFile(parsedPath, 'utf8'));
    } catch {
        console.log(`[review] ${chain}/${pdf}: no parsedData.json — run the batch test first, skipping`);
        return;
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ${chain}/${pdf}`);
    console.log(`  truth=${truth.products.length} products  parser=${(parsed.products ?? []).length} products`);
    console.log('═══════════════════════════════════════════════════════════');

    let mutated = false;
    const save = async () => {
        await fs.writeFile(truthPath, JSON.stringify(truth, null, 2) + '\n', 'utf8');
        mutated = false;
    };

    // ─── Store header diffs ───
    {
        const ph = parsed.header ?? {};
        const diffs = [
            diffField('store.chainName', truth.store.chainName, ph.chainName ?? ''),
            diffField('store.storeCode', truth.store.storeCode, ph.storeCode ?? ''),
            diffField('store.address',   truth.store.address,   ph.storeAddress ?? ''),
        ].filter((x): x is string => x !== null);
        for (const d of diffs) {
            console.log('');
            console.log(`  ${d}`);
            const a = (await prompt('  [k]eep truth / [u]pdate to parser / [s]kip > ')).toLowerCase();
            if (a === 'q') { if (mutated) await save(); return; }
            if (a === 'u') {
                if (d.startsWith('store.chainName')) truth.store.chainName = ph.chainName ?? '';
                if (d.startsWith('store.storeCode')) truth.store.storeCode = ph.storeCode ?? '';
                if (d.startsWith('store.address'))   truth.store.address   = ph.storeAddress ?? '';
                mutated = true;
                console.log('  → updated');
            }
        }
    }

    // ─── Receipt header diffs ───
    {
        const pf = parsed.footer ?? {};
        const pDate = pf.date && pf.time ? `${pf.date}T${pf.time}` : (pf.date ?? '');
        const diffs = [
            diffField('receipt.receiptNo',    truth.receipt.receiptNo,    pf.receiptNo ?? ''),
            diffField('receipt.date',         truth.receipt.date,         pDate),
            diffField('receipt.totalAmount',  truth.receipt.totalAmount,  pf.total ?? 0),
            diffField('receipt.totalSavings', truth.receipt.totalSavings, pf.totalSavings ?? 0),
        ].filter((x): x is string => x !== null);
        for (const d of diffs) {
            console.log('');
            console.log(`  ${d}`);
            const a = (await prompt('  [k]eep truth / [u]pdate to parser / [s]kip > ')).toLowerCase();
            if (a === 'q') { if (mutated) await save(); return; }
            if (a === 'u') {
                if (d.startsWith('receipt.receiptNo'))    truth.receipt.receiptNo    = pf.receiptNo ?? '';
                if (d.startsWith('receipt.date'))         truth.receipt.date         = pDate;
                if (d.startsWith('receipt.totalAmount'))  truth.receipt.totalAmount  = pf.total ?? 0;
                if (d.startsWith('receipt.totalSavings')) truth.receipt.totalSavings = pf.totalSavings ?? 0;
                mutated = true;
                console.log('  → updated');
            }
        }
    }

    // ─── Product diffs (paired) ───
    const parserAsTruth = (parsed.products ?? []).map(parserToTruthProduct);
    const pairing = pairProducts(truth.products, parserAsTruth);

    let pIdx = 0;
    for (const { truthIdx, parserIdx } of pairing.pairs) {
        pIdx++;
        const t = truth.products[truthIdx];
        const p = parserAsTruth[parserIdx];
        const fields: { key: keyof TruthProduct; label: string }[] = [
            { key: 'price',         label: 'price' },
            { key: 'promoPrice',    label: 'promoPrice' },
            { key: 'quantity',      label: 'quantity' },
            { key: 'amount',        label: 'amount' },
            { key: 'unit',          label: 'unit' },
            { key: 'isWeighable',   label: 'isWeighable' },
            { key: 'pricePerUnit',  label: 'pricePerUnit' },
        ];
        const diffs = fields
            .map((f) => ({ f, label: diffField(f.label, t[f.key], p[f.key]) }))
            .filter((x): x is { f: typeof fields[number]; label: string } => x.label !== null);
        if (diffs.length === 0) continue;
        console.log('');
        console.log(`  [${pIdx}/${pairing.pairs.length}] "${t.name}"`);
        for (const { f, label } of diffs) {
            console.log(`    ${label}`);
            const a = (await prompt('    [k]eep truth / [u]pdate to parser / [s]kip / [q]uit > ')).toLowerCase();
            if (a === 'q') { if (mutated) await save(); return; }
            if (a === 'u') {
                (t as any)[f.key] = (p as any)[f.key];
                mutated = true;
                console.log('    → updated');
            }
        }
    }

    // ─── MISSED (truth has product, parser does not) ───
    for (const ti of pairing.missed) {
        const t = truth.products[ti];
        console.log('');
        console.log(`  MISSED  "${t.name}"  price=${t.price}  qty=${t.quantity}  amount=${t.amount}  unit=${t.unit}`);
        console.log('    Parser didn\'t emit this product. Reasons:');
        console.log('      - parser regressed (keep truth, do not promote yet)');
        console.log('      - truth never had a real product here (drop it)');
        const a = (await prompt('    [k]eep / [d]rop from truth / [s]kip / [q]uit > ')).toLowerCase();
        if (a === 'q') { if (mutated) await save(); return; }
        if (a === 'd') {
            truth.products[ti] = null as any; // mark for removal, compact below
            mutated = true;
            console.log('    → marked for removal');
        }
    }
    if (truth.products.some((p) => p === null)) {
        truth.products = truth.products.filter((p) => p !== null);
    }

    // ─── EXTRA (parser has product, truth does not) ───
    for (const pi of pairing.extra) {
        const p = parserAsTruth[pi];
        console.log('');
        console.log(`  EXTRA   "${p.name}"  price=${p.price}  qty=${p.quantity}  amount=${p.amount}  unit=${p.unit}`);
        console.log('    Parser emitted this but truth doesn\'t have it. Reasons:');
        console.log('      - parser hallucinated (ignore)');
        console.log('      - real product the truth missed (add)');
        const a = (await prompt('    [a]dd to truth / [i]gnore / [s]kip / [q]uit > ')).toLowerCase();
        if (a === 'q') { if (mutated) await save(); return; }
        if (a === 'a') {
            truth.products.push(p);
            mutated = true;
            console.log('    → added');
        }
    }

    // ─── Promote? ───
    console.log('');
    const promoteA = (await prompt('  Mark file as verified (drop provisional flag)? [y/N] > ')).toLowerCase();
    if (promoteA === 'y') {
        delete truth.provisional;
        mutated = true;
        console.log('  → promoted to verified');
    } else {
        console.log('  → stays provisional');
    }

    if (mutated) await save();
}

async function listTargets(): Promise<{ chain: string; pdf: string }[]> {
    const targets: { chain: string; pdf: string }[] = [];
    const chains = chainArg ? [chainArg] : await fs.readdir(TRUTHS_ROOT);
    for (const chain of chains) {
        const chainDir = join(TRUTHS_ROOT, chain);
        let entries: string[];
        try {
            entries = await fs.readdir(chainDir);
        } catch {
            continue;
        }
        for (const f of entries) {
            if (!f.endsWith('.truth.json')) continue;
            const base = f.replace(/\.truth\.json$/, '');
            if (pdfArg) {
                const pdfBase = pdfArg.replace(/\.(pdf|png|jpg|jpeg)$/i, '');
                if (base !== pdfBase) continue;
            }
            try {
                const t = JSON.parse(await fs.readFile(join(chainDir, f), 'utf8')) as TruthFile;
                if (t.provisional !== true) continue;
            } catch {
                continue;
            }
            // Find the matching parsedData dir name (the source filename
            // with its original extension). The truth file doesn't know
            // the extension, so probe each plausible one.
            const candidates = ['.pdf', '.png', '.jpg', '.jpeg'];
            let pdfFile: string | null = null;
            for (const ext of candidates) {
                try {
                    await fs.access(join(LOGS_ROOT, chain, base + ext));
                    pdfFile = base + ext;
                    break;
                } catch {}
            }
            if (!pdfFile) {
                console.log(`[review] ${chain}/${base}: provisional but no log dir found — skipping`);
                continue;
            }
            targets.push({ chain, pdf: pdfFile });
        }
    }
    return targets;
}

(async () => {
    const targets = await listTargets();
    if (targets.length === 0) {
        console.log('[review] no provisional truths to review' +
            (chainArg ? ` (chain=${chainArg})` : '') +
            (pdfArg ? ` (pdf=${pdfArg})` : ''));
        rl.close();
        return;
    }
    console.log(`[review] ${targets.length} provisional truth file(s) to review`);
    for (const t of targets) {
        await reviewFile(t.chain, t.pdf);
    }
    rl.close();
})().catch((e) => {
    console.error('[review] fatal:', e);
    rl.close();
    process.exit(1);
});
