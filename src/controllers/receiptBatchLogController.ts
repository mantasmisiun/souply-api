/**
 * Receipt batch-log endpoints — dev-only tooling used by the phone's
 * Menu → "Kvitų paketinis testas" flow to replay a folder of receipts
 * through the production OCR+parser pipeline and dump per-file
 * diagnostic logs for targeted parser/resolver bug-hunting.
 *
 * Two endpoints:
 *   POST /api/receipts/batch-log          → process one receipt
 *   POST /api/receipts/batch-log/finalize → assemble _report.md
 *
 * Logs land under souply-api/receipts/_logs/<chain>/<filename>/ so a
 * developer can grep them locally when a user reports "receipt X,
 * product Y is wrong".
 */

import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createReceipt } from '../models/receiptModel.js';
import { persistReceiptPrices } from '../services/receiptSaveService.js';

const LOGS_ROOT = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../receipts/_logs'
);

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

const writeLog = (dir: string, name: string, content: string | object): void => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(
        p,
        typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    );
};

interface BatchLogBody {
    chain: string;
    filename: string;
    rawLines?: Array<{ text: string; yTop: number; yBottom: number; xLeft: number; xRight: number }>;
    parsedData: any;
    dryRun: boolean;
    userId?: string;
}

/**
 * Accepts a single parsed receipt from the phone's batch screen, writes
 * its diagnostic artefacts to disk. In persist mode also flows through
 * the normal persistReceiptPrices path so real DB state gets exercised.
 */
export const logBatchReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body as BatchLogBody;
        const { chain, filename, rawLines, parsedData, dryRun, userId } = body ?? {};
        if (!chain || !filename || !parsedData) {
            res.status(400).json({ error: 'chain, filename, parsedData are required' });
            return;
        }
        if (!dryRun && !userId) {
            res.status(400).json({ error: 'userId required when dryRun=false' });
            return;
        }

        const logDir = path.join(LOGS_ROOT, sanitize(chain), sanitize(filename));

        if (Array.isArray(rawLines)) {
            writeLog(
                logDir,
                'raw.txt',
                rawLines
                    .map(
                        (l) =>
                            `y=${(l.yTop ?? 0).toFixed?.(0) ?? l.yTop}\t${l.text}`
                    )
                    .join('\n')
            );
            // Full-geometry copy (x + y + text) — raw.txt drops the x-coords,
            // which makes an OFF-DEVICE 1:1 reproduction of a device parse
            // impossible (the banders read column positions). With this file a
            // failing batch receipt can be replayed/fixture-ised without
            // pasting Metro logs around.
            writeLog(logDir, 'rawLines.json', rawLines);
        }
        writeLog(logDir, 'parsedData.json', parsedData);

        const chainId: number | null =
            typeof parsedData?.header?.chainId === 'number'
                ? parsedData.header.chainId
                : null;
        const storeId = parsedData?.header?.storeId ?? null;
        const receiptNo = parsedData?.footer?.receiptNo ?? null;
        const productCount = Array.isArray(parsedData?.products)
            ? parsedData.products.length
            : 0;
        const matchedCount = Array.isArray(parsedData?.products)
            ? parsedData.products.filter((p: any) => (p.altMatches?.length ?? 0) > 0).length
            : 0;
        const totalOcr = parsedData?.footer?.total ?? null;
        const sumLines = Array.isArray(parsedData?.products)
            ? parsedData.products.reduce(
                  (acc: number, p: any) =>
                      acc + (Number(p.promoPrice ?? p.price) || 0),
                  0
              )
            : 0;

        let persistResult: any = null;
        let receiptId: number | null = null;

        if (!dryRun) {
            if (chainId === null) {
                res.status(400).json({ error: 'parsedData.header.chainId is required when dryRun=false' });
                return;
            }
            const chainIdNum: number = chainId;
            const newReceiptId: number = await createReceipt(
                userId!,
                storeId,
                `batch:${chain}/${filename}`,
                'image/png'
            );
            receiptId = newReceiptId;
            persistResult = await persistReceiptPrices(newReceiptId, userId!, parsedData, {
                chainId: chainIdNum,
                storeId,
                receiptNo,
                date: parsedData?.footer?.date ?? null,
                products: (parsedData?.products ?? []).map((p: any) => ({
                    storeProductId: p.storeProductId ?? null,
                    matchConfirmed: !!p.matchConfirmed,
                    // Force false for batch to suppress fallback propagation
                    // fan-out. The user hasn't eyeballed these matches, so
                    // we shouldn't stamp prices into every store in the
                    // chain on speculation — same guard as the dev script.
                    priceVerified: false,
                    price: p.price,
                    promoPrice: p.promoPrice ?? null,
                    quantity: p.quantity,
                    unit: p.unit,
                })),
            });
            writeLog(logDir, 'persistResult.json', { receiptId, ...persistResult });
        }

        const summaryLines: string[] = [];
        summaryLines.push(`# ${filename}`);
        summaryLines.push('');
        summaryLines.push(`- Chain: ${parsedData?.header?.chainName ?? chain} (id=${chainId ?? '-'})`);
        summaryLines.push(
            `- Store: ${parsedData?.header?.storeAddress ?? '-'} (id=${storeId ?? 'unmatched'})`
        );
        summaryLines.push(`- Receipt #: ${receiptNo ?? '-'}`);
        summaryLines.push(`- Date: ${parsedData?.footer?.date ?? '-'}`);
        summaryLines.push(`- Products parsed: ${productCount}`);
        summaryLines.push(`- Products with >=1 candidate: ${matchedCount}`);
        summaryLines.push(`- Products with 0 candidates: ${productCount - matchedCount}`);
        summaryLines.push(`- Total (OCR footer): ${totalOcr ?? '-'}`);
        summaryLines.push(`- Sum of line prices: ${sumLines.toFixed(2)}`);
        if (receiptId) summaryLines.push(`- Persisted receiptId: ${receiptId}`);
        if (persistResult) {
            summaryLines.push(
                `- Persist result: saved=${persistResult.saved}, skippedNoMatch=${persistResult.skippedNoMatch}, skippedClearance=${persistResult.skippedClearance}, skippedDuplicate=${persistResult.skippedDuplicate}`
            );
        }
        summaryLines.push('');
        summaryLines.push('## Products');
        for (const [i, p] of (parsedData?.products ?? []).entries()) {
            const top = p.altMatches?.[0];
            // Show unit price when the parser carries it (Rimi/Maxima
            // weighables, Norfa merged rows). Falls back to `price`
            // for simple qty-1 entries where price already IS the
            // unit price. Reads as "€2.37 × 3 vnt" rather than the
            // ambiguous "€7.11 × 3 vnt" (total × qty).
            const displayPrice = Number(p.pricePerUnit ?? p.price);
            summaryLines.push(
                `${i + 1}. **${p.name}** — €${displayPrice.toFixed(2)} × ${p.quantity} ${p.unit ?? ''}` +
                    (top
                        ? ` → top candidate: *${top.storeProductName ?? top.storeProductId}* (conf=${Number(
                              top.confidence
                          ).toFixed(2)})`
                        : ` → **no candidates**`)
            );
        }
        writeLog(logDir, 'summary.md', summaryLines.join('\n'));

        res.json({
            ok: true,
            receiptId,
            productCount,
            matchedCount,
            unmatchedCount: productCount - matchedCount,
            totalOcr,
            sumLines,
            persistResult,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Aggregate health metrics across all receipts under a chain's log
 * directory. Used at the top of _report.md so the user can see at a
 * glance whether a parser change helped or hurt — and diff each number
 * against the previous run's baseline (see BASELINE_FILE).
 */
interface ChainMetrics {
    generatedAt: string;
    receiptCount: number;
    zeroProductReceipts: number;
    totalProducts: number;
    productsWithCandidate: number;
    productsConf70: number;
    productsConf90: number;
    avgTopConfidence: number;
    reconcileCount: number;
    reconcileEligible: number;
    reviewableCount: number;
}

const BASELINE_FILE = '_baseline.json';

const RECONCILE_TOLERANCE_EUR = 0.10;

const fmtPct = (num: number, den: number): string =>
    den === 0 ? '—' : `${num} (${Math.round((num / den) * 100)}%)`;

const fmtDelta = (prev: number | undefined, now: number, digits = 0): string => {
    if (prev === undefined) return '—';
    const d = now - prev;
    if (Math.abs(d) < Math.pow(10, -digits) / 2) return '±0';
    return (d > 0 ? '+' : '') + d.toFixed(digits);
};

/**
 * Walks receipts/_logs/<chain>/ and assembles a top-level _report.md
 * from each receipt's summary.md + flags receipts worth reviewing
 * (total mismatch or unmatched products). Idempotent — always reflects
 * the current state of the logs folder, so re-running after a fresh
 * batch or after a manual log edit both work.
 *
 * On each run:
 *   1. Computes aggregate health metrics (ChainMetrics).
 *   2. Reads _baseline.json (metrics from the previous run) if it
 *      exists; renders a diff block.
 *   3. Writes the new metrics into _baseline.json so the NEXT run's
 *      diff is against this one. Chain parser changes that ship
 *      between runs become directly observable in the report.
 */
export const finalizeBatchReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chain = String(req.body?.chain ?? '').trim();
        if (!chain) {
            res.status(400).json({ error: 'chain is required' });
            return;
        }
        const chainDir = path.join(LOGS_ROOT, sanitize(chain));
        if (!fs.existsSync(chainDir)) {
            res.status(404).json({ error: `No logs for chain "${chain}"` });
            return;
        }

        const receiptDirs = fs
            .readdirSync(chainDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();

        const metrics: ChainMetrics = {
            generatedAt: new Date().toISOString(),
            receiptCount: receiptDirs.length,
            zeroProductReceipts: 0,
            totalProducts: 0,
            productsWithCandidate: 0,
            productsConf70: 0,
            productsConf90: 0,
            avgTopConfidence: 0,
            reconcileCount: 0,
            reconcileEligible: 0,
            reviewableCount: 0,
        };
        let confidenceSum = 0;
        let confidenceN = 0;

        const tableRows: string[] = [];
        const reviewable: string[] = [];

        for (const name of receiptDirs) {
            const pdPath = path.join(chainDir, name, 'parsedData.json');
            if (!fs.existsSync(pdPath)) continue;
            try {
                const pd = JSON.parse(fs.readFileSync(pdPath, 'utf8'));
                const products: any[] = Array.isArray(pd?.products) ? pd.products : [];
                const productCount = products.length;
                const matched = products.filter((p) => (p.altMatches?.length ?? 0) > 0).length;
                const totalOcr = pd?.footer?.total ?? null;
                // Footer total is NET (after every per-item discount).
                // p.price is GROSS (before discount); p.promoPrice is
                // the after-discount price when the parser caught the
                // savings row. Sum the effective paid price so the
                // reconcile check tracks the actual receipt total.
                const sumLines = products.reduce(
                    (acc: number, p: any) =>
                        acc + (Number(p.promoPrice ?? p.price) || 0),
                    0
                );

                // Metrics rollup.
                metrics.totalProducts += productCount;
                metrics.productsWithCandidate += matched;
                if (productCount === 0) metrics.zeroProductReceipts++;
                for (const p of products) {
                    const top = p.altMatches?.[0];
                    const conf = top ? Number(top.confidence) : 0;
                    if (top) {
                        confidenceSum += conf;
                        confidenceN++;
                    }
                    if (conf >= 0.7) metrics.productsConf70++;
                    if (conf >= 0.9) metrics.productsConf90++;
                }
                if (typeof totalOcr === 'number') {
                    metrics.reconcileEligible++;
                    if (Math.abs(totalOcr - sumLines) <= RECONCILE_TOLERANCE_EUR) {
                        metrics.reconcileCount++;
                    }
                }

                tableRows.push(
                    `| ${name} | ${productCount} | ${matched} | ${productCount - matched} | ${totalOcr ?? '-'} | ${sumLines.toFixed(2)} |`
                );
                const flags: string[] = [];
                if (
                    typeof totalOcr === 'number' &&
                    Math.abs(totalOcr - sumLines) > RECONCILE_TOLERANCE_EUR
                ) {
                    flags.push(`total mismatch (OCR=${totalOcr}, sum=${sumLines.toFixed(2)})`);
                }
                if (productCount - matched > 0) {
                    flags.push(`${productCount - matched} unmatched line(s)`);
                }
                if (flags.length > 0) {
                    reviewable.push(`- **${name}** — ${flags.join('; ')}`);
                }
            } catch {
                tableRows.push(`| ${name} | parse error | - | - | - | - |`);
            }
        }

        metrics.avgTopConfidence = confidenceN > 0 ? confidenceSum / confidenceN : 0;
        metrics.reviewableCount = reviewable.length;

        // Diff block only renders when a previous snapshot exists.
        const baselinePath = path.join(chainDir, BASELINE_FILE);
        let prev: ChainMetrics | null = null;
        if (fs.existsSync(baselinePath)) {
            try {
                prev = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
            } catch {
                // Malformed baseline — treat as absent, don't block the report.
            }
        }

        const rows: string[] = [];
        rows.push(`# Receipt batch report — ${chain}`);
        rows.push(`Generated ${metrics.generatedAt} — receipts=${metrics.receiptCount}`);
        rows.push('');
        rows.push('## Parser health');
        rows.push('| Metric | Value |');
        rows.push('|---|---:|');
        rows.push(`| Receipts processed              | ${metrics.receiptCount} |`);
        rows.push(`| Receipts with 0 products        | ${fmtPct(metrics.zeroProductReceipts, metrics.receiptCount)} |`);
        rows.push(`| Total products parsed           | ${metrics.totalProducts} |`);
        rows.push(`| Products with ≥1 candidate      | ${fmtPct(metrics.productsWithCandidate, metrics.totalProducts)} |`);
        rows.push(`| Products with confidence ≥0.70  | ${fmtPct(metrics.productsConf70, metrics.totalProducts)} |`);
        rows.push(`| Products with confidence ≥0.90  | ${fmtPct(metrics.productsConf90, metrics.totalProducts)} |`);
        rows.push(`| Avg top-match confidence        | ${metrics.avgTopConfidence.toFixed(3)} |`);
        rows.push(`| Receipts reconciling (±€${RECONCILE_TOLERANCE_EUR.toFixed(2)}) | ${fmtPct(metrics.reconcileCount, metrics.reconcileEligible)} |`);
        rows.push(`| Receipts flagged for review     | ${fmtPct(metrics.reviewableCount, metrics.receiptCount)} |`);

        if (prev) {
            rows.push('');
            rows.push('## Change from previous run');
            rows.push(`_Baseline generated ${prev.generatedAt}_`);
            rows.push('');
            rows.push('| Metric | Prev | Now | Δ |');
            rows.push('|---|---:|---:|---:|');
            rows.push(`| Zero-product receipts     | ${prev.zeroProductReceipts} | ${metrics.zeroProductReceipts} | ${fmtDelta(prev.zeroProductReceipts, metrics.zeroProductReceipts)} |`);
            rows.push(`| Total products parsed     | ${prev.totalProducts} | ${metrics.totalProducts} | ${fmtDelta(prev.totalProducts, metrics.totalProducts)} |`);
            rows.push(`| Products with ≥1 candidate| ${prev.productsWithCandidate} | ${metrics.productsWithCandidate} | ${fmtDelta(prev.productsWithCandidate, metrics.productsWithCandidate)} |`);
            rows.push(`| Products conf ≥0.70       | ${prev.productsConf70} | ${metrics.productsConf70} | ${fmtDelta(prev.productsConf70, metrics.productsConf70)} |`);
            rows.push(`| Products conf ≥0.90       | ${prev.productsConf90} | ${metrics.productsConf90} | ${fmtDelta(prev.productsConf90, metrics.productsConf90)} |`);
            rows.push(`| Avg top confidence        | ${prev.avgTopConfidence.toFixed(3)} | ${metrics.avgTopConfidence.toFixed(3)} | ${fmtDelta(prev.avgTopConfidence, metrics.avgTopConfidence, 3)} |`);
            rows.push(`| Receipts reconciling      | ${prev.reconcileCount} | ${metrics.reconcileCount} | ${fmtDelta(prev.reconcileCount, metrics.reconcileCount)} |`);
            rows.push(`| Receipts flagged          | ${prev.reviewableCount} | ${metrics.reviewableCount} | ${fmtDelta(prev.reviewableCount, metrics.reviewableCount)} |`);
        }

        rows.push('');
        rows.push('## Per-file');
        rows.push('| File | Products | w/ candidates | Unmatched | Total OCR | Sum lines |');
        rows.push('|---|---:|---:|---:|---:|---:|');
        rows.push(...tableRows);

        if (reviewable.length > 0) {
            rows.push('');
            rows.push('## Receipts worth reviewing');
            rows.push(...reviewable);
        }

        const reportPath = path.join(chainDir, '_report.md');
        fs.writeFileSync(reportPath, rows.join('\n'));
        // Snapshot for next run's diff. Always overwrites — each batch
        // sets the baseline for the next one.
        fs.writeFileSync(baselinePath, JSON.stringify(metrics, null, 2));

        res.json({
            ok: true,
            reportPath,
            count: receiptDirs.length,
            flagged: reviewable.length,
            metrics,
        });
    } catch (error) {
        next(error);
    }
};
