/**
 * Bootstrap truth files for the parser-test corpus from a successful
 * batch run's per-receipt parsedData.json logs.
 *
 * Workflow:
 *   1. Run the batch test on Android (the reliable baseline) with
 *      "Persist" off (we just want the diagnostic logs).
 *      Each receipt POSTs to /api/receipts/batch-log which writes
 *      souply-api/receipts/_logs/<chain>/<pdf>/parsedData.json.
 *   2. Run this script. For every <chain>/<pdf>/parsedData.json
 *      without a corresponding shared/receipts/<chain>/<base>.truth.json
 *      it writes a TruthFile derived from the parsed output with
 *      `provisional: true` at the top level.
 *   3. Hand-review provisional files via reviewProvisionalTruth.ts.
 *      Verified files have the flag dropped (or set to false) and
 *      become authoritative.
 *
 * Default behavior is conservative — never overwrites anything. To
 * refresh existing provisional truths after a parser improvement,
 * pass `--refresh-provisional`. Hand-verified truths
 * (`provisional !== true`) are never touched under any flag.
 *
 * Usage:
 *   npx tsx src/scripts/bootstrapTruthsFromLogs.ts
 *   npx tsx src/scripts/bootstrapTruthsFromLogs.ts --refresh-provisional
 *   npx tsx src/scripts/bootstrapTruthsFromLogs.ts --chain maxima
 */

import { promises as fs } from 'fs';
import { resolve, join, basename, extname } from 'path';

const LOGS_ROOT = resolve(process.cwd(), 'receipts/_logs');
const TRUTHS_ROOT = resolve(process.cwd(), '../shared/receipts');

interface ParsedFooter {
    total?: number | null;
    date?: string | null;
    time?: string | null;
    receiptNo?: string | null;
    totalSavings?: number | null;
}

interface ParsedHeader {
    chainName?: string;
    storeCode?: string;
    storeAddress?: string;
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
    header?: ParsedHeader;
    footer?: ParsedFooter;
    products?: ParsedProduct[];
}

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
    $schema: 'receipt-truth-v1';
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

const TODAY = new Date().toISOString().slice(0, 10);

const argv = process.argv.slice(2);
const refreshProvisional = argv.includes('--refresh-provisional');
const chainFilter = (() => {
    const i = argv.indexOf('--chain');
    return i >= 0 ? argv[i + 1] : null;
})();

/** parsedData → TruthFile. Mapping notes:
 *  - For weighable items (unit === 'kg'), parser folds weight into
 *    `quantity`. Truth schema splits them: amount=weight, quantity=1.
 *    For unit items: amount=1, quantity=count.
 *  - Receipt date is `YYYY-MM-DDTHH:MM:SS` when both date+time are
 *    present, else just date.
 *  - `store.name` mirrors `chainName` — receipts rarely surface a
 *    separate store display name through parsing. Hand-review fixes
 *    when it matters. */
function parsedToTruth(pdf: string, parsed: ParsedData): TruthFile {
    const h = parsed.header ?? {};
    const f = parsed.footer ?? {};
    const date = f.date && f.time ? `${f.date}T${f.time}` : (f.date ?? '');

    const products: TruthProduct[] = (parsed.products ?? []).map((p) => {
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
    });

    return {
        $schema: 'receipt-truth-v1',
        provisional: true,
        source: { pdf, annotatedAt: TODAY },
        store: {
            chainName: h.chainName ?? '',
            storeCode: h.storeCode ?? '',
            name: h.chainName ?? '',
            address: h.storeAddress ?? '',
        },
        receipt: {
            receiptNo: f.receiptNo ?? '',
            date,
            totalAmount: f.total ?? 0,
            totalSavings: f.totalSavings ?? 0,
        },
        products,
    };
}

async function loadExistingTruth(path: string): Promise<TruthFile | null> {
    try {
        const raw = await fs.readFile(path, 'utf8');
        return JSON.parse(raw) as TruthFile;
    } catch {
        return null;
    }
}

interface Stats {
    created: number;
    refreshed: number;
    skippedVerified: number;
    skippedProvisional: number;
    failed: number;
}

async function processChain(chain: string, stats: Stats): Promise<void> {
    const chainLogDir = join(LOGS_ROOT, chain);
    let entries: string[];
    try {
        entries = await fs.readdir(chainLogDir);
    } catch {
        console.log(`[bootstrap] no logs for chain "${chain}", skipping`);
        return;
    }

    for (const entry of entries) {
        const pdfLogDir = join(chainLogDir, entry);
        const parsedPath = join(pdfLogDir, 'parsedData.json');
        let parsedRaw: string;
        try {
            parsedRaw = await fs.readFile(parsedPath, 'utf8');
        } catch {
            continue;
        }
        let parsed: ParsedData;
        try {
            parsed = JSON.parse(parsedRaw);
        } catch (e) {
            console.warn(`[bootstrap] ${chain}/${entry}: bad JSON, skipping`);
            stats.failed++;
            continue;
        }
        if (!parsed.products || parsed.products.length === 0) {
            // No products extracted — nothing to bootstrap. Skip silently.
            continue;
        }

        // entry is the original source filename (e.g. "kvitas_2025-11-08.pdf").
        // Truth file basename matches but with `.truth.json` extension.
        const base = entry.replace(/\.(pdf|png|jpg|jpeg)$/i, '');
        const truthPath = join(TRUTHS_ROOT, chain, `${base}.truth.json`);

        const existing = await loadExistingTruth(truthPath);
        if (existing) {
            if (existing.provisional === true) {
                if (!refreshProvisional) {
                    stats.skippedProvisional++;
                    continue;
                }
                // fall through to overwrite
            } else {
                // hand-verified — sacred, untouchable
                stats.skippedVerified++;
                continue;
            }
        }

        const truth = parsedToTruth(entry, parsed);
        await fs.mkdir(join(TRUTHS_ROOT, chain), { recursive: true });
        await fs.writeFile(truthPath, JSON.stringify(truth, null, 2) + '\n', 'utf8');
        if (existing) {
            stats.refreshed++;
            console.log(`[bootstrap] refreshed ${chain}/${base}.truth.json (${truth.products.length} products)`);
        } else {
            stats.created++;
            console.log(`[bootstrap] created  ${chain}/${base}.truth.json (${truth.products.length} products)`);
        }
    }
}

(async () => {
    console.log('[bootstrap] LOGS_ROOT  =', LOGS_ROOT);
    console.log('[bootstrap] TRUTHS_ROOT =', TRUTHS_ROOT);
    if (refreshProvisional) {
        console.log('[bootstrap] --refresh-provisional: existing provisional truths will be regenerated');
    }
    if (chainFilter) {
        console.log(`[bootstrap] --chain ${chainFilter}: limited to one chain`);
    }
    const stats: Stats = {
        created: 0,
        refreshed: 0,
        skippedVerified: 0,
        skippedProvisional: 0,
        failed: 0,
    };
    let chains: string[];
    try {
        chains = await fs.readdir(LOGS_ROOT);
    } catch {
        console.error(`[bootstrap] no logs at ${LOGS_ROOT} — run the batch test first`);
        process.exit(1);
    }
    chains = chains.filter((c) => !c.startsWith('_'));
    if (chainFilter) chains = chains.filter((c) => c === chainFilter);
    for (const chain of chains) {
        await processChain(chain, stats);
    }
    console.log('[bootstrap] done:');
    console.log(`  created             ${stats.created}`);
    console.log(`  refreshed           ${stats.refreshed}`);
    console.log(`  skipped (verified)  ${stats.skippedVerified}`);
    console.log(`  skipped (provis.)   ${stats.skippedProvisional}`);
    if (stats.failed > 0) console.log(`  failed              ${stats.failed}`);
})().catch((e) => {
    console.error('[bootstrap] fatal:', e);
    process.exit(1);
});
