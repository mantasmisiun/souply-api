/**
 * OFF-DEVICE match-quality audit for every stored receipt.
 *
 * Drives the REAL same-chain product matcher (findBestProductMatches) over every
 * products[] line of every stored receipt, against that chain's live catalog, and
 * reports unsupervised match-quality metrics so matcher changes can be measured for
 * improvement / regression. Read-only (no INSERT/UPDATE — same safety profile as
 * receipts:reparse): getStoreProductsByChainWithProductData and findBestProductMatches
 * never write.
 *
 * It mirrors the live match controller (storeProductController.ts):
 *   - same-chain  findBestProductMatches(name, amount, unit, candidates, _, topN, weighable)
 *   - on zero same-chain hits, the cross-chain fallback at minConfidenceCrossChain
 *
 * Metrics (no manual ground truth — unsupervised proxies):
 *   - autoApplied%  : same-chain top conf >= autoApplyThreshold (0.85)
 *   - uncertain%    : top conf in [minConfidenceCrossChain, autoApply)
 *   - orphaned%     : no same-chain match >= minConfidence (would mint / go cross-chain)
 *   - topIsCatalog% / topIsOrphan% : the receipt-203 failure class (a minted orphan wins)
 *   - priceConfirmed% : the chosen top is a catalog SP whose catalog price ~ the line price
 *   - priceConflict   : a DIFFERENT catalog SP at ~ the line price (sharing an anchor word)
 *                       exists but the matcher chose an orphan / different SP — the
 *                       receipt-203 signature (orphan @2.29 chosen, catalog #60946 @2.29 missed)
 *   - bandHistogram, orphanMintCount per chain
 *
 * Usage:
 *   npm run receipts:matchaudit                      # audit all, print report, save snapshot
 *   npm run receipts:matchaudit -- --chain 3         # IKI only
 *   npm run receipts:matchaudit -- --json            # machine-readable JSON only
 *   npm run receipts:matchaudit -- --csv out.csv     # per-line CSV dump
 *   npm run receipts:matchaudit -- --baseline <file> # diff vs a prior snapshot
 *   npm run receipts:matchaudit -- --assert          # exit 1 if the receipt-203 canary fails
 */
import '../../config/env.js';
import pool from '../../config/db.js';
import { itemToLine } from '../../models/receiptItemModel.js';
import {
    getStoreProductsByChainWithProductData,
    getStoreProductsCrossChainWithProductData,
} from '../../models/storeProductModel.js';
import { findBestProductMatches, normalizeProductName, type MatchCandidate } from '../../utils/productMatcher.js';
import { sharedSignificantToken } from '../../utils/nameMatchGate.js';
import { RECOGNITION, confidenceBand } from '../../../../shared/recognitionConfig.js';
import * as fs from 'fs';
import * as path from 'path';

// ── The receipt-203 regression canary, as a DETERMINISTIC matcher assertion. ──
// "IKI SMULKINTA KIAUL IENA R" must resolve to the 20% variant (#60946), NOT the "maišyta"
// (#60808) or "35%" (#60816) same-named siblings. Uses a FIXED candidate fixture: the old form
// re-parsed live receipt 203 against the live catalog, so it broke the instant that receipt was
// deleted (dev churn) or a swipe added a vocab alias — noise that has nothing to do with the
// matcher logic this canary guards.
const mkCanaryCand = (id: number, storeProductName: string): MatchCandidate => ({
    id, productId: id, categoryId: 1, categoryName: null, categoryL2Name: null,
    storeProductName, brandName: null, amount: null, unit: null, isWeighable: false, imageUrl: null,
});
const CANARY = {
    ocrName: 'IKI SMULKINTA KIAUL IENA R',
    expectSpId: 60946,
    candidates: [
        mkCanaryCand(60808, 'Smulkinta maišyta kiauliena ir/jautiena dujose, IKI'),
        mkCanaryCand(60946, 'Smulkinta kiauliena riebumas ne did./kaip 20% dujose, IKI'),
        mkCanaryCand(60816, 'Smulkinta kiauliena riebumas ne didesnis kaip 35%'),
    ],
};

const PRICE_TOL = 0.1; // ±10% catalog-vs-receipt price match (the priceConfirm/priceConflict proxy)

interface CliArgs { baseline: string | null; jsonOnly: boolean; csv: string | null; chain: number | null; assert: boolean }
const parseArgs = (argv: string[]): CliArgs => {
    let baseline: string | null = null, jsonOnly = false, csv: string | null = null, chain: number | null = null, doAssert = false;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--baseline') baseline = argv[++i];
        else if (argv[i] === '--json') jsonOnly = true;
        else if (argv[i] === '--csv') csv = argv[++i];
        else if (argv[i] === '--chain') chain = Number(argv[++i]);
        else if (argv[i] === '--assert') doAssert = true;
    }
    return { baseline, jsonOnly, csv, chain, assert: doAssert };
};

interface PerLine {
    receiptId: number;
    chainId: number;
    lineIdx: number;
    ocrName: string;
    linePrice: number | null;
    topSpId: number | null;
    topName: string | null;
    topConf: number;
    topIsCatalog: boolean;
    band: string;        // S1 / S2 / S3
    crossChain: boolean; // same-chain produced nothing, cross-chain fallback used
    priceConfirmed: boolean;
    priceConflict: boolean;
    missedSpId: number | null;   // a price-matching catalog SP the matcher passed over
    storedSpId: number | null;   // what production actually linked (parsedData)
    changedVsStored: boolean;
}

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

async function main() {
    const args = parseArgs(process.argv);

    // Catalog price map: latest scraped (receiptId IS NULL) price per SP. One query.
    const [priceRows]: any = await pool.query(
        'SELECT storeProductId, price FROM Price WHERE receiptId IS NULL ORDER BY id',
    );
    const catalogPrice = new Map<number, number>();
    for (const r of priceRows) {
        const p = r.price !== null ? parseFloat(r.price) : NaN;
        if (Number.isFinite(p)) catalogPrice.set(Number(r.storeProductId), p); // later id wins = latest
    }

    // Receipt-minted orphan count per chain (StoreProduct with no scraped price).
    const [orphanRows]: any = await pool.query(
        `SELECT sp.chainId AS chainId, COUNT(*) AS n FROM StoreProduct sp
         WHERE NOT EXISTS (SELECT 1 FROM Price p WHERE p.storeProductId = sp.id AND p.receiptId IS NULL)
         GROUP BY sp.chainId`,
    );
    const orphanMintCount: Record<number, number> = {};
    for (const r of orphanRows) orphanMintCount[Number(r.chainId)] = Number(r.n);

    // All receipts with product lines. Post-ReceiptItem-cutover the blob stores
    // products: [], so the corpus MUST come from ReceiptItem rows — keying on the blob
    // silently narrowed the audit to legacy receipts only ("no regressions" over an
    // ever-shrinking set). Blob products remain the fallback for pre-migration rows.
    const [receipts]: any = await pool.query(
        'SELECT id, parsedData FROM Receipt WHERE parsedData IS NOT NULL ORDER BY id',
    );
    const receiptIds = (receipts as any[]).map((r: any) => Number(r.id));
    const itemsByReceipt = new Map<number, any[]>();
    if (receiptIds.length > 0) {
        const [itemRows]: any = await pool.query(
            'SELECT * FROM ReceiptItem WHERE receiptId IN (?) ORDER BY receiptId, lineIdx',
            [receiptIds],
        );
        for (const r of itemRows as any[]) {
            const list = itemsByReceipt.get(Number(r.receiptId)) ?? [];
            list.push(itemToLine(r));
            itemsByReceipt.set(Number(r.receiptId), list);
        }
    }

    const catalogCache = new Map<number, MatchCandidate[]>();
    const getCatalog = async (chainId: number): Promise<MatchCandidate[]> => {
        if (!catalogCache.has(chainId)) catalogCache.set(chainId, await getStoreProductsByChainWithProductData(chainId));
        return catalogCache.get(chainId)!;
    };
    const crossCache = new Map<number, MatchCandidate[]>();
    const getCross = async (chainId: number): Promise<MatchCandidate[]> => {
        if (!crossCache.has(chainId)) crossCache.set(chainId, await getStoreProductsCrossChainWithProductData(chainId));
        return crossCache.get(chainId)!;
    };

    const perLine: PerLine[] = [];

    for (const row of receipts) {
        let parsed: any;
        try { parsed = typeof row.parsedData === 'string' ? JSON.parse(row.parsedData) : row.parsedData; } catch { continue; }
        const chainId = Number(parsed?.header?.chainId);
        if (!Number.isFinite(chainId) || chainId <= 0) continue;
        if (args.chain != null && chainId !== args.chain) continue;
        const rowLines = itemsByReceipt.get(Number(row.id)) ?? [];
        const products: any[] = rowLines.length > 0
            ? rowLines
            : (Array.isArray(parsed?.products) ? parsed.products : []);
        if (products.length === 0) continue;

        const candidates = await getCatalog(chainId);

        for (let i = 0; i < products.length; i++) {
            const line = products[i];
            const name = typeof line?.name === 'string' ? line.name : '';
            if (!name.trim()) continue;
            const amount = Number.isFinite(line?.amount) ? Number(line.amount) : null;
            const unit = typeof line?.unit === 'string' ? line.unit : null;
            // Mirror the app's live match call: it sends weighable=1 only for kg lines.
            const weighable = unit === 'kg' ? true : null;
            const linePrice = Number.isFinite(line?.price) ? Number(line.price) : null;

            let matches = findBestProductMatches(name, amount, unit, candidates, undefined, RECOGNITION.match.topN, weighable);
            let crossChain = false;
            if (matches.length === 0) {
                const cross = await getCross(chainId);
                matches = findBestProductMatches(name, amount, unit, cross, RECOGNITION.match.minConfidenceCrossChain, RECOGNITION.match.topN, weighable);
                crossChain = matches.length > 0;
            }
            // Round-2-faithful price disambiguation: among the top name matches within
            // the catalog tiebreak margin of the leader, prefer the catalog SP whose
            // catalog price matches the receipt line price (variant/pack disambiguation,
            // mirrors priceRound2Matcher). matches[] is sorted desc by confidence.
            let top = matches[0] ?? null;
            if (top && linePrice != null && linePrice > 0) {
                const lead = matches[0].confidence;
                let bestErr = Infinity;
                for (const m of matches) {
                    if (lead - m.confidence > RECOGNITION.match.catalogPreferenceMargin) break;
                    if (!m.isCatalog) continue;
                    const cp = catalogPrice.get(m.storeProductId);
                    if (cp == null) continue;
                    const err = Math.abs(cp - linePrice) / Math.max(cp, linePrice, 0.01);
                    if (err <= PRICE_TOL && err < bestErr) { bestErr = err; top = m; }
                }
            }
            const topConf = top ? top.confidence : 0;
            const topIsCatalog = !!top?.isCatalog;

            // Price-confirm proxy: chosen top is a catalog SP at ~ the line price.
            let priceConfirmed = false;
            if (top && topIsCatalog && linePrice != null && catalogPrice.has(top.storeProductId)) {
                const cp = catalogPrice.get(top.storeProductId)!;
                priceConfirmed = Math.abs(cp - linePrice) / Math.max(cp, linePrice, 0.01) <= PRICE_TOL;
            }
            // Price-conflict: a DIFFERENT catalog SP at ~ the line price, sharing an anchor
            // word with the OCR name, exists but wasn't chosen (the receipt-203 signature).
            let priceConflict = false;
            let missedSpId: number | null = null;
            if (!priceConfirmed && linePrice != null && linePrice > 0) {
                const nq = normalizeProductName(name);
                for (const c of candidates) {
                    if (!c.isCatalog) continue;
                    if (top && c.id === top.storeProductId) continue;
                    const cp = catalogPrice.get(c.id);
                    if (cp == null) continue;
                    if (Math.abs(cp - linePrice) / Math.max(cp, linePrice, 0.01) > PRICE_TOL) continue;
                    if (!sharedSignificantToken(nq, normalizeProductName(c.storeProductName))) continue;
                    priceConflict = true;
                    missedSpId = c.id;
                    break;
                }
            }

            const storedSpId = Number.isFinite(line?.storeProductId) ? Number(line.storeProductId) : null;
            perLine.push({
                receiptId: Number(row.id), chainId, lineIdx: i, ocrName: name, linePrice,
                topSpId: top?.storeProductId ?? null, topName: top?.name ?? null,
                topConf, topIsCatalog, band: confidenceBand(topConf), crossChain,
                priceConfirmed, priceConflict, missedSpId, storedSpId,
                changedVsStored: (top?.storeProductId ?? null) !== storedSpId,
            });
        }
    }

    // ── Aggregate (overall + per chain). ──
    const A = RECOGNITION.match.autoApplyThreshold;
    const X = RECOGNITION.match.minConfidenceCrossChain;
    const agg = (rows: PerLine[]) => {
        const n = rows.length;
        return {
            lines: n,
            autoAppliedPct: pct(rows.filter(r => !r.crossChain && r.topConf >= A).length, n),
            uncertainPct: pct(rows.filter(r => !r.crossChain && r.topConf >= X && r.topConf < A).length, n),
            orphanedPct: pct(rows.filter(r => r.topSpId == null).length, n),
            crossChainPct: pct(rows.filter(r => r.crossChain).length, n),
            topIsCatalogPct: pct(rows.filter(r => r.topIsCatalog).length, n),
            topIsOrphanPct: pct(rows.filter(r => r.topSpId != null && !r.topIsCatalog).length, n),
            priceConfirmedPct: pct(rows.filter(r => r.priceConfirmed).length, n),
            priceConflictCount: rows.filter(r => r.priceConflict).length,
            band: {
                S1: rows.filter(r => r.band === 'S1').length,
                S2: rows.filter(r => r.band === 'S2').length,
                S3: rows.filter(r => r.band === 'S3').length,
            },
        };
    };
    const chains = [...new Set(perLine.map(r => r.chainId))].sort((a, b) => a - b);
    const byChain: Record<number, any> = {};
    for (const ch of chains) byChain[ch] = { ...agg(perLine.filter(r => r.chainId === ch)), orphanMintCount: orphanMintCount[ch] ?? 0 };

    const snapshot = {
        generatedAt: new Date().toISOString(),
        receipts: receipts.length,
        overall: agg(perLine),
        byChain,
        perLine,
    };

    // ── Report. ──
    if (!args.jsonOnly) {
        const o = snapshot.overall;
        console.log('\n=== MATCH AUDIT ===');
        console.log(`receipts=${snapshot.receipts}  lines=${o.lines}  (thresholds: minConf ${RECOGNITION.match.minConfidence} / cross ${X} / autoApply ${A})`);
        console.log(`  autoApplied ${o.autoAppliedPct}%  uncertain ${o.uncertainPct}%  orphaned ${o.orphanedPct}%  crossChain ${o.crossChainPct}%`);
        console.log(`  topIsCatalog ${o.topIsCatalogPct}%  topIsOrphan ${o.topIsOrphanPct}%  priceConfirmed ${o.priceConfirmedPct}%  priceConflict ${o.priceConflictCount}`);
        console.log(`  band S1/S2/S3 = ${o.band.S1}/${o.band.S2}/${o.band.S3}`);
        console.log('  per chain:');
        for (const ch of chains) {
            const c = byChain[ch];
            console.log(`    chain ${ch}: lines ${c.lines}  catalog ${c.topIsCatalogPct}%  orphanTop ${c.topIsOrphanPct}%  priceConfirmed ${c.priceConfirmedPct}%  conflict ${c.priceConflictCount}  mintedOrphans ${c.orphanMintCount}`);
        }
        // The kiauliena canary line, always shown — a deterministic matcher check.
        {
            const cm = findBestProductMatches(CANARY.ocrName, null, null, CANARY.candidates, undefined, RECOGNITION.match.topN, null);
            const top = cm[0];
            const ok = (top?.storeProductId ?? null) === CANARY.expectSpId;
            console.log(`\n  CANARY "${CANARY.ocrName}" → top=#${top?.storeProductId ?? '-'} (${top?.name ?? '-'}) conf=${top?.confidence?.toFixed(2) ?? '-'} ${ok ? '✓ #60946' : `✗ expected #${CANARY.expectSpId}`}`);
        }
        // The worst offenders: catalog SP at the line price exists but the matcher missed it.
        const conflicts = perLine.filter(r => r.priceConflict).slice(0, 20);
        if (conflicts.length) {
            console.log(`\n  PRICE-CONFLICTS (catalog SP at line price missed) — first ${conflicts.length}:`);
            for (const r of conflicts) console.log(`    r${r.receiptId}#${r.lineIdx} "${r.ocrName}" @${r.linePrice} → chose ${r.topSpId}(cat=${r.topIsCatalog}) but #${r.missedSpId} matches price`);
        }
    }

    // ── Persist snapshot + rotate (mirror reparseMetrics). ──
    const snapDir = path.join(import.meta.dirname, 'snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    const latest = path.join(snapDir, 'matchaudit.latest.json');
    const prev = path.join(snapDir, 'matchaudit.prev.json');
    if (fs.existsSync(latest)) fs.copyFileSync(latest, prev);
    fs.writeFileSync(latest, JSON.stringify(snapshot, null, 2));

    if (args.jsonOnly) console.log(JSON.stringify(snapshot.overall));
    if (args.csv) {
        const header = 'receiptId,chainId,lineIdx,ocrName,linePrice,topSpId,topName,topConf,topIsCatalog,band,crossChain,priceConfirmed,priceConflict,missedSpId,storedSpId,changedVsStored';
        const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`;
        const lines = perLine.map(r => [r.receiptId, r.chainId, r.lineIdx, esc(r.ocrName), r.linePrice, r.topSpId, esc(r.topName), r.topConf, r.topIsCatalog, r.band, r.crossChain, r.priceConfirmed, r.priceConflict, r.missedSpId, r.storedSpId, r.changedVsStored].join(','));
        fs.writeFileSync(args.csv, [header, ...lines].join('\n'));
        console.log(`\n  CSV → ${args.csv} (${perLine.length} lines)`);
    }

    // ── Baseline diff. ──
    const baselineFile = args.baseline ?? (fs.existsSync(prev) ? prev : null);
    if (baselineFile && fs.existsSync(baselineFile)) {
        try {
            const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
            const baseMap = new Map<string, PerLine>((base.perLine ?? []).map((r: PerLine) => [`${r.receiptId}:${r.lineIdx}`, r]));
            let improved = 0, regressed = 0;
            const detail: string[] = [];
            for (const r of perLine) {
                const b = baseMap.get(`${r.receiptId}:${r.lineIdx}`);
                if (!b) continue;
                const better = (!b.topIsCatalog && r.topIsCatalog) || (!b.priceConfirmed && r.priceConfirmed) || (b.topSpId == null && r.topSpId != null && r.topIsCatalog);
                const worse = (b.topIsCatalog && !r.topIsCatalog) || (b.priceConfirmed && !r.priceConfirmed) || (b.topSpId != null && r.topSpId == null);
                if (better && !worse) { improved++; detail.push(`  + r${r.receiptId}#${r.lineIdx} "${r.ocrName}" ${b.topSpId}→${r.topSpId} (cat ${b.topIsCatalog}→${r.topIsCatalog})`); }
                else if (worse) { regressed++; detail.push(`  - r${r.receiptId}#${r.lineIdx} "${r.ocrName}" ${b.topSpId}→${r.topSpId} (cat ${b.topIsCatalog}→${r.topIsCatalog})`); }
            }
            console.log(`\n=== DIFF vs ${path.basename(baselineFile)}: improved ${improved}, regressed ${regressed} ===`);
            for (const d of detail.slice(0, 40)) console.log(d);
        } catch (e: any) { console.warn('diff failed:', e?.message ?? e); }
    }

    // ── Canary assertion (CI gate). ──
    let exitCode = 0;
    if (args.assert) {
        // Run the canary OCR name against the fixed candidate fixture — pure matcher logic,
        // no dependency on a stored receipt row or the live vocabulary.
        const m = findBestProductMatches(CANARY.ocrName, null, null, CANARY.candidates, undefined, RECOGNITION.match.topN, null);
        const topSpId = m[0]?.storeProductId ?? null;
        const ok = topSpId === CANARY.expectSpId;
        console.log(`\n[assert] "${CANARY.ocrName}" → top=#${topSpId ?? '-'} (expect #${CANARY.expectSpId}): ${ok ? 'PASS' : 'FAIL'}`);
        if (!ok) exitCode = 1;
    }

    await pool.end();
    process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(2); });
