/**
 * Batch-replay receipt PDFs through the chain parsers + resolver without
 * touching a phone. Purpose: diagnose parser / resolver issues against a
 * known corpus, iterate quickly, produce per-receipt logs for targeted
 * bug-hunting.
 *
 * Usage:
 *   # Dry-run everything for Maxima (default):
 *   node --loader ts-node/esm src/scripts/receiptBatch/importReceiptBatch.ts --chain maxima
 *
 *   # Single file:
 *   node --loader ts-node/esm src/scripts/receiptBatch/importReceiptBatch.ts \
 *        --chain maxima --file kvitas_2026-01-02.pdf
 *
 *   # Actually write to DB under a specific test user:
 *   node --loader ts-node/esm src/scripts/receiptBatch/importReceiptBatch.ts \
 *        --chain maxima --persist --user 5a857b48-a91d-4370-b58a-7f71003fe3a5
 *
 * Logs land at Project/basket-api/receipts/_logs/<chain>/<filename>/ and
 * a top-level _report.md summarising issue counts across the run.
 *
 * Only processes text-extractable PDFs. Image-only PDFs need the phone
 * MLKit pipeline — they'll appear in the report as "skipped (image-
 * only, needs phone batch)".
 */

import '../../config/env.js';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../../config/db.js';
import { createReceipt } from '../../models/receiptModel.js';
import { persistReceiptPrices } from '../../services/receiptSaveService.js';
import { getStoreProductsByChainWithProductData } from '../../models/storeProductModel.js';
import { findBestProductMatches } from '../../utils/productMatcher.js';
import { parseMaximaReceipt } from '../../../../shared/parsers/maximaParser.js';
import { parseRimiReceipt } from '../../../../shared/parsers/rimiParser.js';
import { extractLinesFromPdf, type ExtractedLine } from './pdfTextToLines.js';

type ChainName = 'maxima' | 'rimi' | 'iki';

interface CliArgs {
    chain: ChainName;
    file: string | null;
    persist: boolean;
    userId: string | null;
}

const CHAIN_META: Record<ChainName, { chainId: number; chainDisplay: string }> = {
    maxima: { chainId: 1, chainDisplay: 'Maxima' },
    rimi: { chainId: 2, chainDisplay: 'Rimi' },
    iki: { chainId: 3, chainDisplay: 'IKI' },
};

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const RECEIPTS_ROOT = path.join(REPO_ROOT, 'basket-api', 'receipts');
const LOGS_ROOT = path.join(RECEIPTS_ROOT, '_logs');

const parseArgs = (argv: string[]): CliArgs => {
    const args: CliArgs = { chain: 'maxima', file: null, persist: false, userId: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--chain') args.chain = argv[++i] as ChainName;
        else if (a === '--file') args.file = argv[++i];
        else if (a === '--persist') args.persist = true;
        else if (a === '--user') args.userId = argv[++i];
    }
    if (!['maxima', 'rimi', 'iki'].includes(args.chain)) {
        throw new Error(`--chain must be one of maxima|rimi|iki, got "${args.chain}"`);
    }
    if (args.persist && !args.userId) {
        // Safety interlock: --persist without --user would silently fall
        // back to some default; refuse it so we can't accidentally write
        // test receipts under a real account.
        throw new Error('--persist requires an explicit --user <uuid>');
    }
    return args;
};

interface PerReceiptResult {
    file: string;
    status: 'processed' | 'image-only' | 'parse-error';
    reason?: string;
    linesExtracted?: number;
    productCount?: number;
    matchedCount?: number;
    unmatchedCount?: number;
    resolverCreatedCount?: number;
    resolverReusedCount?: number;
    receiptNo?: string | null;
    storeId?: number | null;
    totalOcrEur?: number | null;
    totalLinesSumEur?: number | null;
    receiptId?: number;
}

const runParserFor = (chain: ChainName, lines: ExtractedLine[]): any => {
    // ikiParser is screenshot-shaped; PDFs for IKI won't come through
    // this script (IKI folder stays empty), but keep the branch for
    // future-proofing.
    if (chain === 'maxima') return parseMaximaReceipt(lines);
    if (chain === 'rimi') return parseRimiReceipt(lines);
    throw new Error(`No text-PDF parser configured for chain "${chain}"`);
};

/**
 * Look up a storeId by chainId + approximate address match. Thin wrapper
 * around the existing /stores/match logic — we call the SQL directly to
 * avoid standing up an HTTP stack for the batch script.
 */
const matchStoreIdByAddress = async (
    chainId: number,
    address: string | null
): Promise<number | null> => {
    if (!address) return null;
    const [rows]: any = await pool.query(
        `SELECT id FROM Store WHERE chainId = ? AND address LIKE ? LIMIT 1`,
        [chainId, `%${address.split(',')[0].trim()}%`]
    );
    return rows[0]?.id ?? null;
};

/**
 * Build the `parsedData` blob the receipt controller would normally
 * receive from the phone — header, products (with altMatches
 * candidates), footer. Structure has to stay compatible with
 * persistReceiptPrices + replaceSwipeCandidates.
 */
const buildParsedData = async (
    chain: ChainName,
    parseResult: any,
    chainId: number,
    storeId: number | null
): Promise<any> => {
    const candidates = await getStoreProductsByChainWithProductData(chainId);

    const products = (parseResult.products as any[]).map((p) => {
        const matches = findBestProductMatches(
            p.name ?? '',
            typeof p.quantity === 'number' ? p.quantity : null,
            p.unit ?? null,
            candidates,
            0.4,
            3
        );
        const altMatches = matches.map((m: any) => ({
            storeProductId: m.storeProductId,
            productId: m.productId ?? null,
            storeProductName: m.storeProductName ?? null,
            confidence: m.confidence,
        }));
        return {
            name: p.name,
            brandName: p.brandName ?? null,
            price: p.price,
            promoPrice: p.promoPrice ?? null,
            quantity: p.quantity,
            unit: p.unit,
            pricePerUnit: p.pricePerUnit ?? null,
            amount: typeof p.quantity === 'number' ? p.quantity : null,
            isWeighable: !!p.isWeighable,
            imageUrl: null,
            storeProductId: null,
            matchConfirmed: false,
            // Verification stays false for batch imports — that suppresses
            // the fallback-propagation fan-out inside persistReceiptPrices
            // (see the gate in receiptSaveService.ts around "only queue
            // fallback propagation for prices the user has already
            // confirmed"). Without this flag, a 50-receipt run would
            // insert ~25k Price rows across the chain.
            priceVerified: false,
            altMatches,
        };
    });

    return {
        header: {
            chainId,
            chainName: CHAIN_META[chain].chainDisplay,
            storeId,
            storeCode: parseResult.header?.storeCode ?? null,
            storeAddress: parseResult.header?.storeAddress ?? null,
            rawText: parseResult.header?.rawText ?? null,
            region: parseResult.header?.region ?? null,
        },
        products,
        footer: {
            total: parseResult.footer?.total ?? null,
            date: parseResult.footer?.date ?? null,
            time: parseResult.footer?.time ?? null,
            receiptNo: parseResult.footer?.receiptNo ?? null,
            totalSavings: parseResult.footer?.totalSavings ?? null,
            rawText: parseResult.footer?.rawText ?? null,
            region: parseResult.footer?.region ?? null,
        },
    };
};

const writeLog = (dir: string, name: string, content: string | object): void => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};

const summarize = (r: PerReceiptResult, pd: any, parsed: any): string => {
    const lines: string[] = [];
    lines.push(`# ${r.file}`);
    lines.push('');
    lines.push(`- Status: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    lines.push(`- Chain: ${pd?.header?.chainName ?? '-'}`);
    lines.push(`- Store: ${pd?.header?.storeAddress ?? '-'} (id=${r.storeId ?? 'unmatched'})`);
    lines.push(`- Receipt #: ${r.receiptNo ?? '-'}`);
    lines.push(`- Date: ${pd?.footer?.date ?? '-'}`);
    lines.push(`- Total (OCR footer): ${r.totalOcrEur ?? '-'}`);
    lines.push(`- Sum of line prices: ${r.totalLinesSumEur?.toFixed(2) ?? '-'}`);
    lines.push(`- Products parsed: ${r.productCount ?? 0}`);
    lines.push(`- Products with >=1 candidate: ${r.matchedCount ?? 0}`);
    lines.push(`- Products with 0 candidates: ${r.unmatchedCount ?? 0}`);
    if (r.receiptId) lines.push(`- Persisted receiptId: ${r.receiptId}`);
    if (r.resolverCreatedCount !== undefined) {
        lines.push(`- Resolver created: ${r.resolverCreatedCount}, reused: ${r.resolverReusedCount ?? 0}`);
    }
    lines.push('');
    lines.push('## Products');
    for (const [i, p] of (pd?.products ?? []).entries()) {
        const top = p.altMatches?.[0];
        lines.push(
            `${i + 1}. **${p.name}** — €${p.price?.toFixed?.(2) ?? p.price} × ${p.quantity} ${p.unit}` +
                (top
                    ? ` → top candidate: *${top.storeProductName}* (conf=${top.confidence.toFixed(2)})`
                    : ` → **no candidates**`)
        );
    }
    if (parsed?.header?.rawText) {
        lines.push('');
        lines.push('## Header raw');
        lines.push('```');
        lines.push(parsed.header.rawText);
        lines.push('```');
    }
    if (parsed?.footer?.rawText) {
        lines.push('');
        lines.push('## Footer raw');
        lines.push('```');
        lines.push(parsed.footer.rawText);
        lines.push('```');
    }
    return lines.join('\n');
};

const run = async () => {
    const args = parseArgs(process.argv);
    const { chainId, chainDisplay } = CHAIN_META[args.chain];

    const srcDir = path.join(RECEIPTS_ROOT, args.chain);
    if (!fs.existsSync(srcDir)) {
        throw new Error(`Chain dir not found: ${srcDir}`);
    }
    const logsDir = path.join(LOGS_ROOT, args.chain);
    fs.mkdirSync(logsDir, { recursive: true });

    const allFiles = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
    const files = args.file
        ? allFiles.filter((f) => f === args.file)
        : allFiles.sort();
    if (files.length === 0) {
        console.log(`No PDFs to process in ${srcDir}`);
        return;
    }

    console.log(
        `Batch: chain=${chainDisplay} (id=${chainId}), files=${files.length}, mode=${
            args.persist ? `PERSIST user=${args.userId}` : 'DRY-RUN'
        }`
    );

    const results: PerReceiptResult[] = [];

    for (const file of files) {
        const pdfPath = path.join(srcDir, file);
        const receiptLogDir = path.join(logsDir, path.basename(file, '.pdf'));
        fs.mkdirSync(receiptLogDir, { recursive: true });

        const r: PerReceiptResult = { file, status: 'processed' };
        try {
            const extraction = await extractLinesFromPdf(pdfPath);
            r.linesExtracted = extraction.lines.length;

            if (extraction.lines.length === 0) {
                r.status = 'image-only';
                r.reason = 'pdftotext returned no <line> elements; use phone OCR pipeline';
                writeLog(receiptLogDir, 'summary.md', summarize(r, null, null));
                results.push(r);
                console.log(`  · ${file}: image-only (skip)`);
                continue;
            }

            writeLog(
                receiptLogDir,
                'raw.txt',
                extraction.lines
                    .map((l) => `y=${l.yTop.toFixed(0)}\t${l.text}`)
                    .join('\n')
            );

            const parsed = runParserFor(args.chain, extraction.lines);
            writeLog(receiptLogDir, 'parsed.json', parsed);

            const storeId = await matchStoreIdByAddress(
                chainId,
                parsed.header?.storeAddress ?? null
            );
            r.storeId = storeId;
            r.receiptNo = parsed.footer?.receiptNo ?? null;

            const parsedData = await buildParsedData(args.chain, parsed, chainId, storeId);
            r.productCount = parsedData.products.length;
            r.matchedCount = parsedData.products.filter(
                (p: any) => (p.altMatches?.length ?? 0) > 0
            ).length;
            r.unmatchedCount = (r.productCount ?? 0) - (r.matchedCount ?? 0);
            r.totalOcrEur = parsed.footer?.total ?? null;
            r.totalLinesSumEur = parsedData.products.reduce(
                (acc: number, p: any) => acc + (Number(p.price) || 0),
                0
            );

            writeLog(receiptLogDir, 'parsedData.json', parsedData);

            if (args.persist) {
                const receiptId = await createReceipt(
                    args.userId!,
                    storeId,
                    `batch:${args.chain}/${file}`,
                    'application/pdf'
                );
                r.receiptId = receiptId;
                const saveResult = await persistReceiptPrices(receiptId, args.userId!, parsedData, {
                    chainId,
                    storeId,
                    receiptNo: r.receiptNo ?? null,
                    date: parsed.footer?.date ?? null,
                    products: parsedData.products.map((p: any) => ({
                        storeProductId: p.storeProductId ?? null,
                        matchConfirmed: !!p.matchConfirmed,
                        priceVerified: !!p.priceVerified,
                        price: p.price,
                        promoPrice: p.promoPrice,
                        quantity: p.quantity,
                        unit: p.unit,
                    })),
                });
                writeLog(receiptLogDir, 'persistResult.json', saveResult as any);
                console.log(
                    `  ✓ ${file}: persisted receiptId=${receiptId}, saved=${saveResult.saved}, skippedNoMatch=${saveResult.skippedNoMatch}`
                );
            } else {
                console.log(
                    `  · ${file}: dry-run — products=${r.productCount}, matched=${r.matchedCount}, unmatched=${r.unmatchedCount}`
                );
            }

            writeLog(receiptLogDir, 'summary.md', summarize(r, parsedData, parsed));
        } catch (err: any) {
            r.status = 'parse-error';
            r.reason = err?.message ?? String(err);
            writeLog(receiptLogDir, 'error.txt', err?.stack ?? String(err));
            writeLog(receiptLogDir, 'summary.md', summarize(r, null, null));
            console.warn(`  ✗ ${file}: ${r.reason}`);
        }
        results.push(r);
    }

    const report: string[] = [];
    report.push(`# Receipt batch report — ${chainDisplay}`);
    report.push(
        `Generated ${new Date().toISOString()} — mode=${args.persist ? 'persist' : 'dry-run'}, files=${results.length}`
    );
    report.push('');
    report.push('| File | Status | Products | w/ candidates | Unmatched | Total OCR | Sum lines |');
    report.push('|---|---|---:|---:|---:|---:|---:|');
    for (const r of results) {
        report.push(
            `| ${r.file} | ${r.status} | ${r.productCount ?? '-'} | ${r.matchedCount ?? '-'} | ${r.unmatchedCount ?? '-'} | ${r.totalOcrEur ?? '-'} | ${r.totalLinesSumEur?.toFixed?.(2) ?? '-'} |`
        );
    }

    const suspicious = results.filter(
        (r) =>
            r.status === 'processed' &&
            ((r.totalOcrEur && r.totalLinesSumEur &&
                Math.abs(r.totalOcrEur - r.totalLinesSumEur) > 0.05) ||
                (r.unmatchedCount ?? 0) > 0)
    );
    if (suspicious.length > 0) {
        report.push('');
        report.push('## Receipts worth reviewing');
        for (const r of suspicious) {
            const reasons = [];
            if (r.totalOcrEur && r.totalLinesSumEur && Math.abs(r.totalOcrEur - r.totalLinesSumEur) > 0.05) {
                reasons.push(
                    `total mismatch (OCR=${r.totalOcrEur}, sum=${r.totalLinesSumEur.toFixed(2)})`
                );
            }
            if ((r.unmatchedCount ?? 0) > 0) {
                reasons.push(`${r.unmatchedCount} unmatched line(s)`);
            }
            report.push(`- **${r.file}** — ${reasons.join('; ')}`);
        }
    }

    writeLog(logsDir, '_report.md', report.join('\n'));
    console.log(`\nReport written to ${path.join(logsDir, '_report.md')}`);

    await pool.end();
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
