/**
 * OFF-DEVICE batch re-parse + quality metrics for every stored receipt.
 *
 * Runs the SAME parser stage as a real upload (the on-device OCR's `wordsDump` is the parser's
 * input, captured at upload time) over every receipt that has a stored wordsDump, NON-PERSISTENTLY
 * (read-only — no DB writes, no StoreProduct/Price rows created). Prints a per-receipt + aggregate
 * quality report so parser changes can be inspected for regressions / improvements, and saves a JSON
 * snapshot you can diff run-over-run.
 *
 * Usage:
 *   npm run receipts:reparse                       # parse all, print report, save snapshot
 *   npm run receipts:reparse -- --baseline <file>  # also diff vs a prior snapshot (regressions)
 *   npm run receipts:reparse -- --json             # print machine-readable JSON only
 *
 * The OCR itself is NOT re-run (MLKit is device-only); this exercises parse → product/footer
 * extraction, which is the stage that changes when we touch the chain parsers. Only IKI receipts
 * currently store a wordsDump; non-IKI rows are reported as skipped.
 */
import '../../config/env.js';
import pool from '../../config/db.js';
import {
    parseIkiReceipt,
    isIkiReceipt,
    type IkiLine,
} from '../../../../shared/parsers/ikiParser.js';
import * as fs from 'fs';
import * as path from 'path';

type AnyProduct = { name: string; price: number | null; promoPrice: number | null; quantity?: number | null; unit?: string | null };

interface CliArgs { baseline: string | null; jsonOnly: boolean }
const parseArgs = (argv: string[]): CliArgs => {
    let baseline: string | null = null, jsonOnly = false;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--baseline') baseline = argv[++i];
        else if (argv[i] === '--json') jsonOnly = true;
    }
    return { baseline, jsonOnly };
};

// wordsDump line → the parser's IkiLine shape.
const toIkiLines = (wordsDump: any[]): IkiLine[] =>
    wordsDump.map((d) => ({
        text: d.t,
        xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
        words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
    }));

// A product line is "garbage" when the parser couldn't read it into a real product: no usable name,
// a name with a price/discount AMOUNT baked in (the band-merge signature), or no price at all.
const NAME_HAS_AMOUNT = /-?\d{1,4}[.,]\s?\d{2}\b/;
const isGarbage = (p: AnyProduct): { bad: boolean; why: string } => {
    const nm = (p.name ?? '').trim();
    if (!nm || nm === '?') return { bad: true, why: 'no-name' };
    if (NAME_HAS_AMOUNT.test(nm)) return { bad: true, why: 'amount-in-name' };
    if (nm.split(/\s+/).length >= 8) return { bad: true, why: 'long-merge' };
    if (!(p.price != null && p.price > 0)) return { bad: true, why: 'no-price' };
    return { bad: false, why: '' };
};

const paidSum = (products: AnyProduct[]): number =>
    Math.round(products.reduce((s, p) => {
        const unit = p.promoPrice != null ? p.promoPrice : (p.price ?? 0);
        const q = p.quantity && p.quantity > 0 ? p.quantity : 1;
        return s + (unit > 0 ? unit * q : 0);
    }, 0) * 100) / 100;

// Compact signature of a product list so two runs can be compared cheaply.
const prodSig = (products: AnyProduct[]): string =>
    products.map((p) => `${(p.name ?? '').trim()}|${p.price}|${p.promoPrice}`).join(' ;; ');

// The upload flow rejects some scans BEFORE they reach the Items list (see receipt-process.tsx):
//   • doubled-scan — the camera caught the receipt twice in one frame; the full slashed receipt
//     number then appears in ≥2 OCR lines (receipt-165/167).
//   • no-products — a garbled photo that parsed zero items (receipt-165).
// Mirror that here so a rejected receipt isn't scored as "garbage" — it's correctly bounced to retake.
const gateOf = (wordsDump: any[], nProducts: number): string | null => {
    const toks = wordsDump.map((d) => (d.t as string).match(/\b\d{2,4}\/\d{2,4}\/\d{4,8}\b/)?.[0]).filter(Boolean) as string[];
    if (toks.some((t, i) => toks.indexOf(t) !== i)) return 'doubled-scan';
    if (nProducts === 0) return 'no-products';
    return null;
};

interface ReceiptResult {
    id: number;
    chain: string;
    gated: string | null;
    nProducts: number;
    total: number | null;
    paid: number;
    reconDelta: number | null;  // |paid - total|
    garbage: number;
    garbageWhy: string[];
    discounts: number;
    address: string;
    addressOk: boolean;
    date: string | null;
    receiptNo: string | null;
    products: AnyProduct[];
    sig: string;
    storedSig: string;          // the deployed parse's product signature
    changedVsStored: boolean;
}

async function main() {
    const args = parseArgs(process.argv);
    const [rows] = await pool.query<any[]>(
        "SELECT id, parsedData FROM Receipt WHERE JSON_LENGTH(JSON_EXTRACT(parsedData,'$.wordsDump')) > 0 ORDER BY id"
    );

    const results: ReceiptResult[] = [];
    const skipped: { id: number; reason: string }[] = [];

    for (const row of rows) {
        const id = row.id as number;
        let pd: any;
        try { pd = typeof row.parsedData === 'string' ? JSON.parse(row.parsedData) : row.parsedData; }
        catch { skipped.push({ id, reason: 'bad-json' }); continue; }
        const wordsDump: any[] = pd?.wordsDump ?? [];
        if (!wordsDump.length) { skipped.push({ id, reason: 'no-wordsDump' }); continue; }

        const lines = toIkiLines(wordsDump);
        const lineTexts = lines.map((l) => l.text);
        if (!isIkiReceipt(lineTexts)) { skipped.push({ id, reason: `not-IKI (${pd?.header?.chainName ?? '?'})` }); continue; }

        const res = parseIkiReceipt(lines);
        const products: AnyProduct[] = res.products ?? [];
        const total = res.footer?.total ?? null;
        const paid = paidSum(products);
        const garbageWhy = products.map(isGarbage).filter((g) => g.bad).map((g) => g.why);
        const addr = (res.header?.storeAddress ?? '').trim();
        const addressOk = /\d/.test(addr) && /,/.test(addr) && !/Lietuva|UA[B8]/i.test(addr) && addr.length > 0;

        const storedProducts: AnyProduct[] = (pd?.products ?? []).map((p: any) => ({ name: p.name, price: p.price, promoPrice: p.promoPrice }));
        const sig = prodSig(products);
        const storedSig = prodSig(storedProducts);
        const gated = gateOf(wordsDump, products.length);

        results.push({
            id, chain: 'IKI', gated, nProducts: products.length, total, paid,
            reconDelta: total != null ? Math.round(Math.abs(paid - total) * 100) / 100 : null,
            garbage: garbageWhy.length, garbageWhy,
            discounts: products.filter((p) => p.promoPrice != null).length,
            address: addr, addressOk,
            date: res.footer?.date ?? null, receiptNo: res.footer?.receiptNo ?? null,
            products, sig, storedSig, changedVsStored: sig !== storedSig,
        });
    }

    // ── aggregate (quality is scored over ACCEPTED receipts only — gated ones are correctly bounced) ──
    const n = results.length;
    const accepted = results.filter((r) => !r.gated);
    const a = accepted.length;
    const agg = {
        receipts: n,
        rejected: results.filter((r) => r.gated).length,
        accepted: a,
        products: accepted.reduce((s, r) => s + r.nProducts, 0),
        garbageProducts: accepted.reduce((s, r) => s + r.garbage, 0),
        receiptsWithGarbage: accepted.filter((r) => r.garbage > 0).length,
        cleanReceipts: accepted.filter((r) => r.garbage === 0).length,
        reconciledTight: accepted.filter((r) => r.reconDelta != null && r.reconDelta <= 0.05).length,
        reconciledLoose: accepted.filter((r) => r.reconDelta != null && r.reconDelta <= 0.30).length,
        discounts: accepted.reduce((s, r) => s + r.discounts, 0),
        addressOk: accepted.filter((r) => r.addressOk).length,
        footerComplete: accepted.filter((r) => r.total != null && r.date && r.receiptNo).length,
        changedVsStored: results.filter((r) => r.changedVsStored).length,
    };

    const snapshot = { generatedAt: new Date().toISOString(), agg, results, skipped };

    if (args.jsonOnly) { console.log(JSON.stringify(snapshot, null, 2)); }
    else {
        const pad = (s: any, w: number) => String(s).padEnd(w);
        const padL = (s: any, w: number) => String(s).padStart(w);
        console.log('\n=== IKI RECEIPT BATCH RE-PARSE (current parser, read-only) ===\n');
        console.log(pad('id', 5) + pad('#prod', 6) + pad('total', 8) + pad('paid', 8) + pad('Δrecon', 8) + pad('garb', 6) + pad('disc', 6) + pad('addr', 6) + 'status');
        console.log('-'.repeat(66));
        for (const r of results) {
            const status = r.gated ? 'REJECTED:' + r.gated : (r.changedVsStored ? 'CHANGED' : 'same');
            console.log(
                pad(r.id, 5) + pad(r.gated ? '—' : r.nProducts, 6) +
                pad(r.total != null ? r.total.toFixed(2) : '—', 8) +
                pad(r.gated ? '—' : r.paid.toFixed(2), 8) +
                pad(r.gated || r.reconDelta == null ? '—' : r.reconDelta.toFixed(2), 8) +
                pad(r.gated ? '—' : (r.garbage || '·'), 6) + pad(r.gated ? '—' : (r.discounts || '·'), 6) +
                pad(r.gated ? '—' : (r.addressOk ? 'ok' : 'BAD'), 6) +
                status
            );
        }
        console.log('\n=== AGGREGATE (quality scored over ACCEPTED receipts) ===');
        console.log(`  receipts        : ${agg.receipts}   accepted ${agg.accepted} · rejected ${agg.rejected} (doubled/no-products, correctly bounced to retake)`);
        console.log(`  CLEAN receipts  : ${agg.cleanReceipts}/${agg.accepted}  (0 garbage products)  ← higher is better`);
        console.log(`  products        : ${agg.products}  (${(agg.products / Math.max(a, 1)).toFixed(1)}/accepted receipt)`);
        console.log(`  GARBAGE products: ${agg.garbageProducts}  (in ${agg.receiptsWithGarbage} receipts)  ← lower is better`);
        console.log(`  reconciled      : ${agg.reconciledTight}/${a} tight (Δ≤0.05) · ${agg.reconciledLoose}/${a} loose (Δ≤0.30)`);
        console.log(`  discounts found : ${agg.discounts}`);
        console.log(`  address ok      : ${agg.addressOk}/${a}`);
        console.log(`  footer complete : ${agg.footerComplete}/${a} (total+date+receiptNo)`);
        console.log(`  changed vs deployed parse : ${agg.changedVsStored}/${n}`);

        // detail every ACCEPTED receipt with garbage / bad address / poor reconciliation — worth eyeballing
        const flagged = results.filter((r) => !r.gated && (r.garbage > 0 || !r.addressOk || (r.reconDelta != null && r.reconDelta > 0.30)));
        if (flagged.length) {
            console.log('\n=== FLAGGED (garbage / bad-address / unreconciled) ===');
            for (const r of flagged) {
                console.log(`\n  receipt ${r.id}  (Δrecon ${r.reconDelta != null ? r.reconDelta.toFixed(2) : '—'}, addr ${r.addressOk ? 'ok' : '"' + r.address + '"'})`);
                r.products.forEach((p, i) => {
                    const g = isGarbage(p);
                    console.log(`    [${i}] ${g.bad ? '⚠ ' + g.why + ' ' : '  '}${JSON.stringify((p.name ?? '').slice(0, 46))} price=${p.price} promo=${p.promoPrice}`);
                });
            }
        }
    }

    // ── snapshot + diff ──  Each run rotates latest→prev, so the next run auto-diffs against it
    // ("did my last parser change move anything?"). `--baseline <file>` overrides with a pinned snapshot.
    const outDir = path.join(process.cwd(), 'src/scripts/receiptBatch/snapshots');
    fs.mkdirSync(outDir, { recursive: true });
    const latest = path.join(outDir, 'reparse.latest.json');
    const prev = path.join(outDir, 'reparse.prev.json');
    if (fs.existsSync(latest)) fs.copyFileSync(latest, prev);   // rotate BEFORE overwriting
    fs.writeFileSync(latest, JSON.stringify(snapshot, null, 2));
    if (!args.jsonOnly) console.log(`\nsnapshot → ${path.relative(process.cwd(), latest)}`);

    const baselineFile = args.baseline ?? (fs.existsSync(prev) ? prev : null);
    if (baselineFile && !args.jsonOnly) {
        const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
        const baseById = new Map<number, ReceiptResult>((base.results ?? []).map((r: ReceiptResult) => [r.id, r]));
        const changes: string[] = [];
        for (const r of results) {
            const b = baseById.get(r.id);
            if (!b) { changes.push(`  + receipt ${r.id} NEW`); continue; }
            if (b.sig !== r.sig) {
                const dir = r.garbage < b.garbage ? 'IMPROVED' : r.garbage > b.garbage ? 'REGRESSED' : 'changed';
                changes.push(`  ~ receipt ${r.id} ${dir}  (garbage ${b.garbage}→${r.garbage}, #prod ${b.nProducts}→${r.nProducts}, Δrecon ${b.reconDelta}→${r.reconDelta})`);
            }
        }
        console.log(`\n=== DIFF vs ${args.baseline ? 'baseline' : 'previous run'} (${path.basename(baselineFile)}) ===`);
        console.log(changes.length ? changes.join('\n') : '  (no per-receipt product changes vs the previous run)');
    }

    await pool.end();
}

main().catch((e) => { console.error('reparseMetrics failed:', e); process.exit(1); });
