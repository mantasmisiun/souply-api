import {
    createPrice,
    batchGetBaselinePriceAverages,
    batchGetLatestPricesForReceiptItems,
} from '../models/priceModel.js';
import { updateReceiptDetails, updateReceiptStore, updateReceiptSavedAmount } from '../models/receiptModel.js';
import { comboDiscountOf, computeReceiptSavings } from './statsService.js';
import {
    replaceSwipeCandidates,
    type SwipeCandidate,
} from '../models/receiptSwipeCandidateModel.js';
import { resolveReceiptLineStoreProduct } from './receiptLineResolver.js';
import { applyPriceRound2Matching, fishPriceScopedCandidates, type Round2Result } from './priceRound2Matcher.js';
import { propagateAllFallbackPrices } from './priceService.js';
import { refillForOrphans } from '../scripts/seedOrphanSwipeCandidates.js';
import pool from '../config/db.js';
import { normalizeReceiptDateForStorage, normalizeReceiptNo, normalizeReceiptNos } from '../utils/receiptMetadata.js';
import { awardReceiptPoints } from './userPointsService.js';
import { initMandatorySwipeSession, MANDATORY_SWIPES_PER_RECEIPT } from './swipeSessionService.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { computeItemConfidence, type ItemConfidenceInput } from './itemConfidence.js';
import { logInteraction, collectReceiptBuySpIds } from '../models/productInteractionModel.js';
import { computeNeedsHuman } from './queueRanking.js';
import { prewarmMandatoryQueue } from './mandatoryQueueService.js';
import { isMislabeledWeighableKg } from '../utils/productMatcher.js';
import { getStoreProductDisplayById } from '../models/storeProductModel.js';
import { replaceReceiptItems, updateReceiptItem } from '../models/receiptItemModel.js';
import { flagDivergentDifferentVotes } from '../models/userEquivalenceModel.js';
import { stripProductRawText } from '../util/receiptPII.js';
import { countFailOpen } from './failOpenMetrics.js';

const MAX_CANDIDATES_PER_LINE = RECOGNITION.price.maxCandidatesPerLine;

interface ParsedReceiptInput {
    chainId: number;
    storeId: number | null;
    receiptNo: string | null;
    date: string | null;
    /**
     * Receipt time (`HH:MM:SS` or `HH:MM`) — captured separately
     * from `date` because MLKit often splits the timestamp across
     * lines. When present, gets combined with `date` to produce a
     * `YYYY-MM-DD HH:MM:SS` storage value; otherwise we pad to
     * midnight.
     */
    time?: string | null;
    products: ParsedProductInput[];
}

interface ParsedProductInput {
    storeProductId: number | null;
    matchConfirmed: boolean;
    priceVerified: boolean;
    // Display fields re-synced to the linked SP after a resolver swap (best-effort).
    matchedName?: string | null;
    storeProductImageUrl?: string | null;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    /**
     * Set by Round 2 when the name match is PRICE-IMPLAUSIBLE (receipt regular
     * price wildly off the matched SP's known price, no plausible sibling) — the
     * price write is skipped so a wrong SP's reference price isn't poisoned.
     */
    priceImplausible?: boolean;
}

const CLEARANCE_RATIO = RECOGNITION.price.clearanceRatio;
const BASELINE_WINDOW = RECOGNITION.price.baselineWindow;

export interface SaveResult {
    saved: number;
    skippedNoMatch: number;
    skippedClearance: number;
    skippedDuplicate: number;
    /** Round-2 price-implausible matches whose write was skipped (protect data). */
    skippedImplausible: number;
    mandatorySwipesRequired: number;
}

/**
 * Image-dims autosave guard (band-drift class), pure for testability. `stored` is the
 * DB row {fp, w, h} read via JSON_EXTRACT; `incomingImg` is the client blob's image
 * object (MUTATED in place when rejected — dims restored to stored). Returns true when
 * a fabricated dims change was rejected. Rules: stored must have valid dims; the change
 * is rejected when the incoming filePath is missing OR equal to the stored one (same
 * underlying image) — a genuinely NEW filePath may bring new dims.
 */
export const guardImageDims = (
    stored: { fp: string | null; w: any; h: any } | undefined,
    incomingImg: any,
): boolean => {
    if (!stored || !incomingImg || typeof incomingImg !== 'object') return false;
    const w = Number(stored.w), h = Number(stored.h);
    if (!(w > 0) || !(h > 0)) return false;
    const sameFile = !incomingImg.filePath || !stored.fp || incomingImg.filePath === stored.fp;
    if (!sameFile) return false;
    if (Number(incomingImg.width) === w && Number(incomingImg.height) === h) return false;
    incomingImg.width = w;
    incomingImg.height = h;
    return true;
};

/**
 * TRIGGER A of the re-verification loop, receipt side: collect this receipt's
 * S1-confident matched SPs and flag the user's divergent personal 'different'
 * votes on them (same-Product pairs) for a priority re-swipe — see
 * flagDivergentDifferentVotes for the anti-nag semantics. Runs post-commit,
 * reads the just-written ReceiptItem rows (one indexed query), fail-open.
 */
const flagDivergenceFromReceipt = async (receiptId: number, userId: string): Promise<void> => {
    const [rows]: any = await pool.query(
        `SELECT DISTINCT matchedSpId FROM ReceiptItem
          WHERE receiptId = ? AND matchConfirmed = 1 AND band = 'S1' AND matchedSpId IS NOT NULL`,
        [receiptId],
    );
    const spIds = (rows as any[]).map((r) => Number(r.matchedSpId)).filter((v) => Number.isFinite(v) && v > 0);
    const flagged = await flagDivergentDifferentVotes(userId, spIds);
    if (flagged > 0) {
        console.log(`[REVERIFY] receipt ${receiptId}: flagged ${flagged} divergent 'different' vote(s) for re-swipe`);
    }
};

/**
 * Persist a receipt's confirmed prices.
 * - Writes parsedData to the Receipt row
 * - For each confirmed match: creates a new Price row (dated now) unless:
 *     (a) the price looks like clearance (<50% of baseline), OR
 *     (b) values are unchanged from the last Price for this (sp, store, receipt)
 * - New Price rows get priceVerified=1 only for explicitly verified rows from parsedData
 * - Propagates fallback prices to other stores in the chain AFTER commit
 */
export const persistReceiptPrices = async (
    receiptId: number,
    userId: string,
    parsedData: any,
    input: ParsedReceiptInput,
    awardPoints = false,
    // The match summary is logged only on the INITIAL save (receipt create). The
    // app then PUTs a debounced autosave to bake in the image filePath, which
    // re-runs this with the SAME products — Round 2 must re-run there to preserve
    // its disambiguation (the app re-sends the phone's original picks), but the
    // summary would just be a duplicate, so it's suppressed on updates.
    isInitialSave = true,
): Promise<SaveResult> => {
    const result: SaveResult = {
        saved: 0,
        mandatorySwipesRequired: 0,
        skippedNoMatch: 0,
        skippedClearance: 0,
        skippedDuplicate: 0,
        skippedImplausible: 0,
    };

    const toPropagate: Array<{
        storeProductId: number;
        storeId: number;
        chainId: number;
        price: number;
        promoPrice: number | null;
        date: Date;
    }> = [];

    const connection = await (pool as any).getConnection();

    try {
        await connection.beginTransaction();

        const footerRawText = parsedData?.footer?.rawText ?? null;
        const normalizedReceiptNo = normalizeReceiptNo(input.receiptNo, footerRawText);
        const normalizedReceiptDate = normalizeReceiptDateForStorage(input.date, input.time);
        // Full identifier set: the parser writes footer.receiptNos for chains that print several
        // (IKI); fall back to the single canonical for the others / older payloads. Normalized the
        // same way and kept canonical-first (the canonical remains the dedup key + UI value).
        const parsedReceiptNos: unknown = parsedData?.footer?.receiptNos;
        const normalizedReceiptNos = normalizeReceiptNos(
            Array.isArray(parsedReceiptNos) ? (parsedReceiptNos as string[]) : (input.receiptNo ? [input.receiptNo] : []),
            normalizedReceiptNo,
        );
        // The canonical scalar MUST equal receiptNos[0] (UI shows it, recovery keys off it). They
        // already agree in the normal path; this fallback guarantees it even on a degraded payload
        // where the scalar normalized to null but the array still has a value.
        const canonicalReceiptNo = normalizedReceiptNos[0] ?? normalizedReceiptNo;

        if (parsedData && typeof parsedData === 'object') {
            if ('receiptNo' in parsedData) {
                parsedData.receiptNo = canonicalReceiptNo;
            }
            if (parsedData.footer && typeof parsedData.footer === 'object') {
                parsedData.footer.receiptNo = canonicalReceiptNo;
                parsedData.footer.receiptNos = normalizedReceiptNos;
                // Don't overwrite parsedData.footer.date with the combined
                // SQL datetime — the canonical timestamp lives in the
                // Receipt.receiptDate column. The mobile renderer joins
                // {footer.date} {footer.time}, so writing "YYYY-MM-DD HH:MM:SS"
                // here caused the time to appear twice after reopen.
            }
        }

        // Round 2 (PRICE-based matching): confirm / disambiguate the Round-1
        // (name-fuzzy) candidates against each candidate's as-of-receipt-date
        // chain price history. The big win is PACK-SIZE disambiguation among
        // tied same-name variants (NAMINIS 1L/2L/500ml) — name can't separate
        // them, price can. A price-matching candidate wins and is flagged
        // priceVerified (which improves the cost-elsewhere comparison). Runs
        // BEFORE the resolver below so a re-picked SP flows through the same
        // same-chain reuse path, and BEFORE this receipt's own Price rows are
        // written (the lookup also excludes this receipt by id → no
        // self-confirmation). Fail-OPEN: any error / no match leaves Round 1.
        let r2Result: Round2Result | null = null;
        if (Number.isFinite(input.chainId) && Array.isArray(parsedData?.products)) {
            const r2Parsed = normalizedReceiptDate
                ? new Date(normalizedReceiptDate.replace(' ', 'T'))
                : null;
            const r2Date = r2Parsed && !Number.isNaN(r2Parsed.getTime()) ? r2Parsed : new Date();
            try {
                r2Result = await applyPriceRound2Matching(
                    parsedData.products,
                    input.chainId,
                    r2Date,
                    receiptId,
                    connection,
                );
            } catch (e) {
                console.warn('[price-round2] skipped (non-fatal):', e);
            }
            // Round-2.5: lines STILL unlinked get price-scoped rescue candidates fished
            // into altMatches (never auto-linked) — feeds the proposed-card swipe +
            // vocabulary loop. Runs before the resolver/persist so the entries flow into
            // ReceiptItem.altMatches and the swipe-candidate rows. Fail-open.
            try {
                await fishPriceScopedCandidates(
                    parsedData.products,
                    input.chainId,
                    r2Date,
                    receiptId,
                    connection,
                );
            } catch (e) {
                console.warn('[price-fish] skipped (non-fatal):', e);
            }
        }
        // Flag price-implausible lines so the price-write loop skips them (protect
        // the matched SP's reference price). Indices align: input.products[i] ↔
        // parsedData.products[i]. Round 2 mutates parsedData; this mirrors its
        // reject verdict onto the input the write loop iterates.
        if (r2Result && r2Result.rejected.size > 0) {
            for (const i of r2Result.rejected) {
                if (input.products[i]) input.products[i].priceImplausible = true;
            }
        }

        // Rule 1: resolve a concrete storeProductId for every receipt line
        // before we save. Lines already matched by mobile are left alone.
        // Unmatched lines get a dedup lookup first (same chain + exact name +
        // amount + unit); if nothing hits, we create a fresh Product + SP
        // (inheriting the top alt-match's category when available, else
        // falling back to the hidden Nepriskirta bucket). The new SP flows
        // into parsedData AND the filtered `input.products` so the downstream
        // Price-write loop sees it.
        // Resolver outcome per line — fed to the per-item confidence score below.
        const resolveSourceByLine = new Map<number, ItemConfidenceInput['source']>();
        if (Number.isFinite(input.chainId) && Array.isArray(parsedData?.products)) {
            for (let i = 0; i < parsedData.products.length; i++) {
                const line = parsedData.products[i];
                // Always route through the resolver — even lines the mobile
                // matcher already assigned an SP to. The resolver has to see
                // them because the SP might belong to a DIFFERENT chain
                // (Lidl/Norfa receipts matched against Maxima/Rimi catalog
                // via cross-chain fallback). Same-chain SPs exit fast after
                // a single lookup; cross-chain ones trigger the bootstrap
                // path that mints a proper SP in the receipt's chain.
                const incomingSpId =
                    Number.isFinite(line?.storeProductId) && Number(line.storeProductId) > 0
                        ? Number(line.storeProductId)
                        : null;
                if (!line?.name || typeof line.name !== 'string' || !line.name.trim()) {
                    continue; // empty/garbage OCR line
                }
                try {
                    // A line with no usable price (≤0) is treated as too garbled to
                    // trust: REUSE an existing SP if one matches, but never CREATE a
                    // fresh one (no catalog junk from a broken parse).
                    const linePrice = Number.isFinite(line.price) ? Number(line.price) : null;
                    const res = await resolveReceiptLineStoreProduct(
                        input.chainId,
                        {
                            storeProductId: incomingSpId,
                            name: line.name,
                            brandName: typeof line.brandName === 'string' ? line.brandName : null,
                            amount: Number.isFinite(line.amount) ? Number(line.amount) : null,
                            unit: typeof line.sizeUnit === 'string' ? line.sizeUnit : null,
                            // Trust the parser/app flag when present; otherwise derive it from
                            // the by-weight signal (display unit 'kg' at amount null/1). Without
                            // this a weighed line with a null flag reads as a packaged form and
                            // the resolver drops a weighable catalog SP to a same-name orphan.
                            isWeighable:
                                line.isWeighable != null
                                    ? !!line.isWeighable
                                    : isMislabeledWeighableKg(
                                          Number.isFinite(line.amount) ? Number(line.amount) : null,
                                          typeof line.unit === 'string' ? line.unit : null,
                                      ),
                            imageUrl: typeof line.imageUrl === 'string' ? line.imageUrl : null,
                            price: linePrice,
                            altMatchProductId:
                                Array.isArray(line.altMatches) && line.altMatches[0]?.productId
                                    ? Number(line.altMatches[0].productId)
                                    : null,
                            altMatchConfidence:
                                Array.isArray(line.altMatches) && Number.isFinite(line.altMatches[0]?.confidence)
                                    ? Number(line.altMatches[0].confidence)
                                    : null,
                            matchConfidence: Number.isFinite(line.matchConfidence) ? Number(line.matchConfidence) : null,
                        },
                        connection,
                        linePrice !== null && linePrice > 0, // allowCreate
                    );
                    if (res.storeProductId == null) {
                        // 'unmatched' (no-mint: nothing in the catalog matched) or
                        // 'skipped_unpriced' (no usable price — OCR too garbled to trust).
                        // Either way the line links to NOTHING: record the resolver's TRUE
                        // reason, and NULL the app/round-1 pick — leaving it on the line
                        // would persist a stale (possibly cross-chain) SP id into
                        // ReceiptItem.matchedSpId on a line whose source says unmatched.
                        resolveSourceByLine.set(i, res.source);
                        line.storeProductId = null;
                        line.matchConfirmed = false;
                        line.matchedName = null;
                        line.storeProductImageUrl = null;
                        // Round-2 may have price-verified the SP it promoted; unlinking keeps
                        // NO SP, so the flag must go too — a dangling priceVerified feeds the
                        // +0.15 itemConfidence confirmer for a product the line isn't linked
                        // to (receipt-237 salmon: unmatched line scored 0.828, nearly S1).
                        line.priceVerified = false;
                        if (input.products[i]) {
                            input.products[i].storeProductId = null;
                            input.products[i].matchConfirmed = false;
                            input.products[i].matchedName = null;
                            input.products[i].storeProductImageUrl = null;
                            input.products[i].priceVerified = false;
                        }
                        continue;
                    }
                    resolveSourceByLine.set(i, res.source);
                    line.storeProductId = res.storeProductId;
                    line.matchConfirmed = true;
                    if (line.priceVerified === undefined || line.priceVerified === null) {
                        line.priceVerified = false;
                    }
                    if (input.products[i]) {
                        input.products[i].storeProductId = res.storeProductId;
                        input.products[i].matchConfirmed = true;
                        input.products[i].priceVerified = !!line.priceVerified;
                    }
                    // Resolver SWAP: the line was redirected to a DIFFERENT existing SP than
                    // the app/round-1 pick — either a same-chain dedup 'reuse', OR a
                    // cross-chain match that 'bootstrapped'/reused a same-chain SP (the app
                    // picked e.g. a Norfa "GUDOBELĖS" SP, the resolver linked an IKI "CLEVER"
                    // one). Re-sync the shown name/image to the LINKED SP so the card can't
                    // advertise a product (wrong brand/photo) the line no longer points at.
                    if (incomingSpId != null && (res.source === 'reused' || res.source === 'bootstrapped') && res.storeProductId !== incomingSpId) {
                        try {
                            const disp = await getStoreProductDisplayById(res.storeProductId, connection);
                            if (disp) {
                                line.matchedName = disp.name;
                                line.storeProductImageUrl = disp.imageUrl;
                                if (input.products[i]) {
                                    input.products[i].matchedName = disp.name;
                                    input.products[i].storeProductImageUrl = disp.imageUrl;
                                }
                            }
                        } catch { /* display re-sync is best-effort */ }
                        console.warn(
                            `[resolve-swap] receipt ${receiptId} line ${i} "${String(line.name).slice(0, 32)}": ` +
                            `app/round1 SP ${incomingSpId} → resolved SP ${res.storeProductId} (${res.source})`,
                        );
                    }
                } catch (e) {
                    // FAIL TO UNMATCHED, not to client state: a resolver throw must NOT leave the
                    // client-supplied (possibly cross-chain / stale) storeProductId on the line —
                    // that would persist into ReceiptItem.matchedSpId and write a Price under the
                    // wrong SP, violating the never-write-a-wrong-chain-price invariant. Scrub the
                    // match so the line is recorded as an unmatched observation.
                    countFailOpen('resolver-line');
                    console.warn(`Failed to resolve receipt line ${i} — failing to unmatched:`, e);
                    resolveSourceByLine.set(i, 'unmatched');
                    line.storeProductId = null;
                    line.matchConfirmed = false;
                    line.matchedName = null;
                    line.storeProductImageUrl = null;
                    line.priceVerified = false; // same dangling-flag guard as the unmatched path
                    if (input.products[i]) {
                        input.products[i].storeProductId = null;
                        input.products[i].matchConfirmed = false;
                        input.products[i].matchedName = null;
                        input.products[i].storeProductImageUrl = null;
                        input.products[i].priceVerified = false;
                    }
                }
            }
        }

        // ── Per-item CONFIDENCE (DISPLAY-ONLY): fold name + OCR-reliability +
        //    Round-2 + resolve signals into one score + breakdown, persisted on
        //    each line so the Items tab picks a band (S1/S2/S3) and the admin queue
        //    can sort/review. Does NOT change which SP is linked. ────────────────
        if (Array.isArray(parsedData?.products)) {
            const perfect = r2Result?.perfect ?? new Map();
            const rejected = r2Result?.rejected ?? new Set<number>();
            for (let i = 0; i < parsedData.products.length; i++) {
                const line = parsedData.products[i];
                if (!line || typeof line.name !== 'string' || !line.name.trim()) continue;
                const alt = Array.isArray(line.altMatches) ? line.altMatches : [];
                const gap =
                    alt.length >= 2 && Number.isFinite(alt[0]?.confidence) && Number.isFinite(alt[1]?.confidence)
                        ? Number(alt[0].confidence) - Number(alt[1].confidence)
                        : 0;
                const source = resolveSourceByLine.get(i) ?? 'none';
                line.itemConfidence = computeItemConfidence({
                    nameConf: Number.isFinite(line.matchConfidence) ? Number(line.matchConfidence) : null,
                    nameText: line.name,
                    priceVerified: !!line.priceVerified,
                    viaPromo: !!perfect.get(i)?.viaPromo,
                    gapToRunnerUp: gap > 0 ? gap : 0,
                    source,
                    priceImplausible: rejected.has(i),
                });
                // needs-human: how much a user's swipe would help here (ambiguity ×
                // price-impact) — drives WHICH uncertain lines become cards. Every
                // signal is already in scope, so compute it in the same pass.
                const qty = Number.isFinite(line.quantity) ? Number(line.quantity) : 1;
                const unit = line.promoPrice != null && line.promoPrice < line.price ? Number(line.promoPrice) : Number(line.price);
                const lineTotalEur = Number.isFinite(unit) ? Math.max(0, unit) * (qty > 0 ? qty : 1) : 0;
                line.needsHuman = computeNeedsHuman({
                    band: line.itemConfidence.band,
                    gapToRunnerUp: gap > 0 ? gap : 0,
                    candidateCount: alt.length,
                    hasVeto: Array.isArray(line.itemConfidence.vetoes) && line.itemConfidence.vetoes.length > 0,
                    source,
                    lineTotalEur,
                });
            }
        }

        // Per-line MATCH SUMMARY in the server logs: a plain Round-1 NAME match
        // vs a Round-2 PERFECT MATCH (price-confirmed against chain history).
        // `perfect` carries the price detail (regular/promo) and, when Round 2
        // changed the pick, the original name→SP so the swap is visible. Logged
        // once per receipt (initial save only — the autosave PUT would dupe it).
        if (isInitialSave && Array.isArray(parsedData?.products) && parsedData.products.length > 0) {
            const perfect = r2Result?.perfect ?? new Map();
            const repicked = r2Result?.repicked ?? new Map();
            const rejected = r2Result?.rejected ?? new Set<number>();
            const rows: string[] = [];
            // Log 5 — per-receipt band roll-up (derived from the itemConfidence bands +
            // needsHuman already computed above; no new logic). One glance headline: how
            // many lines auto-applied, how many will become cards, how many feed vocab.
            let nS1 = 0, nS2 = 0, nS3 = 0, nOrphan = 0, nNoMatch = 0, nWillCard = 0, nVocab = 0;
            for (let i = 0; i < parsedData.products.length; i++) {
                const line = parsedData.products[i];
                const spId = Number.isFinite(line?.storeProductId) ? Number(line.storeProductId) : null;
                // Roll-up tally — counts EVERY line (incl. no-match) before the match-row skip.
                const mc = Number(line?.matchConfidence);
                const hasName = typeof line?.matchedName === 'string' && line.matchedName.trim().length > 0;
                const icBand = (line as any)?.itemConfidence?.band;
                if (spId !== null && spId > 0 && (!Number.isFinite(mc) || mc < RECOGNITION.match.autoApplyThreshold)) nVocab++;
                if (spId === null || spId <= 0) { nNoMatch++; continue; }
                // Partition (each line counted once): no-match | orphan (SP, no catalog
                // name) | band S1/S2/S3 (matched to a named SP). Orphans always carry a
                // low band too, so keep them OUT of the band buckets to avoid double count.
                if (!hasName) {
                    nOrphan++;
                } else {
                    if (icBand === 'S1') nS1++; else if (icBand === 'S2') nS2++; else if (icBand === 'S3') nS3++;
                    if ((icBand === 'S2' || icBand === 'S3') && (Number(line?.needsHuman) || 0) > 0) nWillCard++;
                }
                const alt = Array.isArray(line?.altMatches) ? line.altMatches : [];
                const chosen = alt.find((am: any) => Number(am?.storeProductId) === spId);
                const conf = chosen && Number.isFinite(chosen.confidence) ? Number(chosen.confidence).toFixed(2) : '—';
                const name = (typeof line?.name === 'string' ? line.name : '').slice(0, 40);
                const p = perfect.get(i);
                const rp = repicked.get(i);
                const ic = (line as any).itemConfidence;
                const band = ic ? `  → ${ic.band} ${ic.score}${ic.vetoes?.length ? ` veto:${ic.vetoes[0].reason}` : ''}` : '';
                if (p) {
                    const swap = p.from !== null && p.from !== spId ? `  [name→SP ${p.from}, price→SP ${spId}]` : '';
                    rows.push(`  #${i + 1} PERFECT MATCH  "${name}" → SP ${spId}  (price ${p.viaPromo ? 'promo' : 'regular'}, name ${conf})${swap}${band}`);
                } else if (rp) {
                    rows.push(`  #${i + 1} PRICE-REPICKED "${name}" → SP ${spId}  (dropped implausible SP ${rp.from}, name ${conf})${band}`);
                } else if (rejected.has(i)) {
                    rows.push(`  #${i + 1} PRICE-REJECTED "${name}" → SP ${spId}  (price implausible — write skipped, name ${conf})${band}`);
                } else {
                    rows.push(`  #${i + 1} match          "${name}" → SP ${spId}  (name ${conf})${band}`);
                }
            }
            // Mint count this scan (resolver source 'created' = a NEW SP was minted). Per-SP
            // detail — uncategorised vs catalog-clustered — is in the [ORPHAN] lines above.
            let nMinted = 0;
            for (const s of resolveSourceByLine.values()) if (s === 'created') nMinted++;
            console.log(
                `=== RECEIPT ${receiptId} MATCH SUMMARY (chain ${input.chainId}): ` +
                `${perfect.size} perfect / ${repicked.size} repicked / ${rejected.size} price-rejected / ${rows.length} matched ===` +
                `\n  bands: S1 ${nS1} · S2 ${nS2} · S3 ${nS3} · orphan ${nOrphan} · no-match ${nNoMatch}` +
                `\n  → will card ${nWillCard} (S2/S3 needing human) · vocabulary-eligible (struggled) ${nVocab} · minted ${nMinted} new SP(s)` +
                (rows.length ? `\n${rows.join('\n')}` : ''),
            );
        }

        await updateReceiptDetails(
            receiptId,
            normalizedReceiptNos,
            normalizedReceiptDate,
            'completed',
            // The blob keeps only STRUCTURED header + footer + geometry: the per-line
            // products[] now live in ReceiptItem (dual-written just below, from the in-memory
            // copy), and stripProductRawText drops the header/footer rawText dumps that
            // duplicated the whole receipt's product text (now in ReceiptItem.rawLines).
            stripProductRawText({ ...parsedData, products: [] }),
            connection
        );
        if (input.storeId) {
            await updateReceiptStore(receiptId, input.storeId, connection);
        }

        // Dual-write ReceiptItem rows (P1 of the ReceiptItem migration — see
        // shared/RECEIPT_ITEM_MIGRATION.md). The blob stays the READ source until the hard
        // cutover; the rows are kept in lock-step via the SAME canonical lineToItem mapping
        // the backfill uses, so a live save and a backfill produce identical rows. matchSource
        // is injected from the resolver result WITHOUT polluting the blob. Non-fatal: a row
        // write must never fail the save while the blob is still authoritative.
        // ReceiptItem rows are AUTHORITATIVE post-cutover (the blob stores products: []),
        // so a failed row write must FAIL the save — swallowing it here would commit the
        // DELETE half of the replace and permanently empty the receipt's items while the
        // client believes the save succeeded. The whole transaction rolls back instead.
        let itemIdByLine = new Map<number, number>(); // lineIdx → ReceiptItem id, to stamp Price.receiptItemId
        const itemLines = (parsedData?.products ?? []).map((line: any, i: number) => {
            // manualMatch is a CLIENT-ONLY marker (consumed by applyReceiptAutosave's merge);
            // persisting it would ride lineToItem's `extra` catch-all and echo back to every
            // reader, leaving the autosave guard dependent on the app dropping it.
            const { manualMatch: _clientOnly, ...rest } = line ?? {};
            return {
                ...rest,
                matchSource: resolveSourceByLine.get(i) ?? line.matchSource ?? null,
            };
        });
        itemIdByLine = (await replaceReceiptItems(receiptId, itemLines, connection)) ?? itemIdByLine;

        // Swipe candidates must be written whether or not a store matched —
        // Phase C's swipe UI still wants to offer validation for unmatched
        // receipts, and the candidate rows reference StoreProduct, not
        // Store.  Doing this BEFORE the no-storeId early return.
        const candidatesByLine: SwipeCandidate[][] = (parsedData?.products ?? []).map(
            (line: any) => {
                const alt = Array.isArray(line?.altMatches) ? line.altMatches : [];
                const lineSpId = Number.isFinite(line?.storeProductId)
                    ? Number(line.storeProductId)
                    : null;
                const verified = !!line?.priceVerified;
                const seenSpIds = new Set<number>();
                const deduped = alt.filter((am: any) => {
                    const spId = Number(am.storeProductId);
                    if (!Number.isFinite(spId) || spId <= 0 || seenSpIds.has(spId)) return false;
                    seenSpIds.add(spId);
                    return true;
                });
                const candidates: SwipeCandidate[] = deduped.slice(0, MAX_CANDIDATES_PER_LINE).map((am: any): SwipeCandidate => ({
                    storeProductId: Number(am.storeProductId),
                    matchScore: Number.isFinite(am.confidence) ? Number(am.confidence) : 0,
                    autoMatched:
                        verified &&
                        lineSpId !== null &&
                        Number(am.storeProductId) === lineSpId,
                }));
                // For resolver-created SPs (e.g. Lidl lines that had no catalog match),
                // the confirmed SP is never in altMatches so autoMatched stays false on
                // every RSC row → slot1 sees 0 anchors and skips the receipt entirely.
                // Inject it here so slot1 can pair it against cross-chain candidates.
                if (
                    line.matchConfirmed &&
                    lineSpId !== null &&
                    !deduped.some((am: any) => Number(am.storeProductId) === lineSpId)
                ) {
                    candidates.push({ storeProductId: lineSpId, matchScore: 1.0, autoMatched: true });
                }
                return candidates;
            }
        );
        await replaceSwipeCandidates(receiptId, candidatesByLine, connection);

        // Mandatory count is always the full cap — Slot 1 cross-chain search
        // generates enough pairs from confirmed SPs to fill it; lower tiers backfill.
        result.mandatorySwipesRequired = await initMandatorySwipeSession(receiptId, MANDATORY_SWIPES_PER_RECEIPT, connection);

        // NB: `awardReceiptPoints` moved to AFTER commit (see end of function).
        // Holding the User-row write lock inside this long transaction was
        // causing `/users/:id/profile` requests (which call `updateLastActive`)
        // to time out under load — every concurrent profile fetch piled up
        // behind the receipt save's points UPDATE.

        // No resolved store → can't attach prices, but parsedData + candidates were saved.
        if (!input.storeId) {
            await connection.commit();
            if (awardPoints) {
                awardReceiptPoints(userId, input.products.length).catch((e) =>
                    console.warn(
                        `[persistReceiptPrices] points award failed for receipt ${receiptId}:`,
                        e,
                    ),
                );
            }
            return result;
        }

        // Prices inherit the receipt's OCR date, not "now", so history lines up
        // with when the user actually paid. Fall back to now only if normalization failed.
        const parsedReceiptDate = normalizedReceiptDate
            ? new Date(normalizedReceiptDate.replace(' ', 'T'))
            : null;
        const writeDate =
            parsedReceiptDate && !Number.isNaN(parsedReceiptDate.getTime())
                ? parsedReceiptDate
                : new Date();

        // Pre-fetch baselines and duplicate-check data in two queries
        // instead of 2×N individual calls inside the loop.
        const eligibleSpIds = input.products
            .filter(p => p.matchConfirmed && p.storeProductId && p.price > 0)
            .map(p => p.storeProductId as number);

        const [baselineMap, latestMap] = await Promise.all([
            batchGetBaselinePriceAverages(eligibleSpIds, input.storeId, BASELINE_WINDOW, connection),
            batchGetLatestPricesForReceiptItems(eligibleSpIds, input.storeId, receiptId, connection),
        ]);

        // MIXED-DEAL DUPLICATE GUARD: the receipt can list the SAME product twice (you
        // bought two — e.g. two "CLEVER … DUO" loaves) where only ONE carries a discount
        // ("50% NUOLAIDA"). That discount is a per-UNIT deal/coupon, NOT the product's
        // price, and recording it as a promo would mislead reference pricing (and the
        // existing same-price/same-promo dedup misses it because the promo differs). When
        // an SP appears 2+ times with BOTH a discounted and a regular occurrence, record
        // only its REGULAR price (no promo). The line's own display keeps its real discount;
        // only the written reference price is normalised. (Needs the duplicate's name to be
        // recovered so both units resolve to the same SP — see ikiParser duplicate-name
        // recovery.)
        const mixedDealSpIds = new Set<number>();
        {
            const bySp = new Map<number, { regular: boolean; discounted: boolean; count: number }>();
            for (const it of input.products) {
                if (!it.matchConfirmed || !it.storeProductId || !(Number(it.price) > 0)) continue;
                const e = bySp.get(it.storeProductId) ?? { regular: false, discounted: false, count: 0 };
                e.count++;
                if (it.promoPrice != null && Number(it.promoPrice) < Number(it.price)) e.discounted = true;
                else e.regular = true;
                bySp.set(it.storeProductId, e);
            }
            for (const [sp, e] of bySp) if (e.count >= 2 && e.regular && e.discounted) mixedDealSpIds.add(sp);
        }

        for (let lineIdx = 0; lineIdx < input.products.length; lineIdx++) {
            const item = input.products[lineIdx];
            if (!item.matchConfirmed || !item.storeProductId) {
                result.skippedNoMatch++;
                continue;
            }
            if (!item.price || item.price <= 0) {
                result.skippedNoMatch++;
                continue;
            }

            // Round-2 price-implausibility guard: the receipt's regular price is
            // wildly off this matched SP's known chain price (and no plausible
            // sibling existed), so the name match is almost certainly wrong — don't
            // write this price under it and poison its reference price.
            if (item.priceImplausible) {
                result.skippedImplausible++;
                continue;
            }

            const baseline = baselineMap.get(item.storeProductId) ?? null;
            if (baseline !== null && item.price < baseline * CLEARANCE_RATIO) {
                result.skippedClearance++;
                continue;
            }

            // For a mixed-deal duplicate SP, write the REGULAR price only (drop the per-unit
            // discount); the line's own display keeps its real promo (see mixedDealSpIds).
            const writePromo = mixedDealSpIds.has(item.storeProductId) ? null : item.promoPrice;

            const latest = latestMap.get(item.storeProductId) ?? null;
            if (latest) {
                const samePrice = Math.abs(parseFloat(latest.price) - item.price) < 0.001;
                const latestPromo = latest.promoPrice === null ? null : parseFloat(latest.promoPrice);
                const samePromo =
                    latestPromo === writePromo ||
                    (latestPromo !== null &&
                        writePromo !== null &&
                        Math.abs(latestPromo - writePromo) < 0.001);
                if (samePrice && samePromo) {
                    result.skippedDuplicate++;
                    continue;
                }
            }

            await createPrice(
                item.storeProductId,
                input.storeId,
                item.price,
                writePromo,
                // A receipt-observed promo expires: promoEnd NULL reads as an ETERNAL
                // promo in getActivePromoPrices, discounting comparisons forever.
                writePromo != null
                    ? new Date(writeDate.getTime() + RECOGNITION.price.receiptPromoValidityDays * 24 * 60 * 60 * 1000)
                    : null,
                false,
                writeDate,
                item.priceVerified === true,
                receiptId,
                false,
                connection,
                itemIdByLine.get(lineIdx) ?? null, // Price.receiptItemId — links the price to its exact line
            );
            // Update latestMap so within-receipt duplicates of the same SP
            // (e.g. parser bug generating 85 bands for one product, OR a mixed-deal
            // duplicate normalised to its regular price above) are caught on the next
            // iteration without needing a DB round-trip.
            latestMap.set(item.storeProductId, {
                price: String(item.price),
                promoPrice: writePromo === null ? null : String(writePromo),
            });
            result.saved++;

            // Only queue fallback propagation for prices the user has
            // already confirmed. Propagating unverified prices (newly
            // auto-created SPs that the user hasn't swiped yet) would fan
            // out ~50 fallback rows per item to every store in the chain
            // for data that may turn out to be garbage OCR. Swipe-identical
            // flips priceVerified later, which is where we'd re-trigger
            // propagation (future enhancement — for now, verified-at-save
            // only).
            if (item.priceVerified === true) {
                toPropagate.push({
                    storeProductId: item.storeProductId,
                    storeId: input.storeId,
                    chainId: input.chainId,
                    price: item.price,
                    promoPrice: writePromo,
                    date: writeDate,
                });
            }
        }

        // Compute savings: delta between receipt prices and cross-chain market average.
        // Only counts items that were successfully matched to a StoreProduct. Uses the
        // price the user actually PAID (promo when set) — the same convention the
        // profile's totalSavings (getUserStats) applies, so the receipt header and the
        // profile can't diverge on discounted items.
        const matchedItems = input.products
            .filter(p => p.matchConfirmed && p.storeProductId && p.price > 0)
            .map(p => ({
                storeProductId: p.storeProductId!,
                price: p.promoPrice != null && p.promoPrice > 0 && p.promoPrice < p.price ? p.promoPrice : p.price,
                quantity: p.quantity || 1,
            }));
        // A receipt-level combo/set-deal discount (footer.comboDiscount, e.g. IKI's bare
        // "RINKINYS -1,90") means the user paid that much less than the line prices imply —
        // savings vs the market average shift up by exactly it. Capped at the lines' paid
        // sum so an OCR-garbled value can't explode the figure.
        const lineSum = input.products.reduce((s, p) => s + (p.price > 0 ? p.price * (p.quantity || 1) : 0), 0);
        const combo = comboDiscountOf(parsedData, lineSum);
        const savedAmount = Math.round((await computeReceiptSavings(matchedItems, connection) + combo) * 100) / 100;
        await updateReceiptSavedAmount(receiptId, savedAmount, connection);

        await connection.commit();
        // Points award is fire-and-forget AFTER the receipt transaction
        // commits. Holding this UPDATE inside the transaction made
        // `/users/:id/profile` requests time out under load — see the
        // long comment near the removed in-transaction call site.
        if (awardPoints) {
            awardReceiptPoints(userId, input.products.length).catch((e) =>
                console.warn(
                    `[persistReceiptPrices] points award failed for receipt ${receiptId}:`,
                    e,
                ),
            );
        }
        // TRIGGER A (re-verification, receipt evidence — fire-and-forget, fail-open):
        // a fresh S1-confident match contradicting the user's old personal 'different'
        // (same-Product pair) flags that vote for a priority re-swipe instead of
        // silently demoting the line's display forever. Post-commit: a flag failure
        // must never fail a save.
        flagDivergenceFromReceipt(receiptId, userId).catch((e) =>
            console.warn(`[persistReceiptPrices] reverification flagging failed for receipt ${receiptId}:`, e),
        );
        // PREWARM the mandatory swipe queue (fire-and-forget): matching already ran in
        // this save, so the card set is knowable NOW — by the time the user reaches the
        // swipe screen the GET serves the snapshot instead of a multi-second live build.
        // Initial save only (the autosave PUT re-sends the same products).
        if (isInitialSave) {
            prewarmMandatoryQueue(userId, receiptId).catch((e) =>
                console.warn(`[persistReceiptPrices] mandatory-queue prewarm failed for receipt ${receiptId}:`, e),
            );
            // Souply 2.0 receipt_buy (weight 5, the strongest ranking signal):
            // one interaction per S1/S2 resolved line, INITIAL SAVE ONLY (the
            // autosave PUT re-sends the same products; reparse never re-fires).
            // Post-commit fire-and-forget — ranking must never fail a save.
            void (async () => {
                try {
                    const buySpIds = collectReceiptBuySpIds(parsedData?.products ?? []);
                    if (buySpIds.length === 0) return;
                    const [prodRows]: any = await pool.query(
                        'SELECT id, productId FROM StoreProduct WHERE id IN (?)', [buySpIds]);
                    const bySp = new Map<number, number>(prodRows.map((r: any) => [Number(r.id), Number(r.productId)]));
                    for (const spId of buySpIds) {
                        const productId = bySp.get(spId);
                        if (productId) await logInteraction(userId, productId, 'receipt_buy');
                    }
                } catch (e) {
                    console.warn(`[persistReceiptPrices] receipt_buy logging failed for receipt ${receiptId}:`, e);
                }
            })();
        }
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    // Fire-and-forget: seed OrphanSwipeCandidate rows for any 688-category SPs
    // resolved during this upload so they surface in slot2a immediately.
    // Gated to the points-awarding (create / final-confirm) save only: each
    // refill does a full-table snapshot load, so running it on every debounced
    // edit auto-save needlessly hammers the connection pool — which can stall the
    // concurrent product-match calls and leave the client stuck on "scanning".
    // Edits that create new orphans are covered by the periodic batch seed +
    // on-demand refillForOrphan from the extra-queue endpoint.
    const resolvedSpIds = (parsedData?.products ?? [])
        .map((p: any) => Number(p?.storeProductId))
        .filter((id: number) => Number.isFinite(id) && id > 0);

    if (awardPoints && resolvedSpIds.length > 0) {
        void (async () => {
            try {
                const [orphanRows]: any = await pool.query(
                    `SELECT DISTINCT p.id AS productId
                       FROM StoreProduct sp
                       JOIN Product p ON p.id = sp.productId
                      WHERE sp.id IN (?)
                        AND p.categoryId = 688
                        AND p.mergedIntoId IS NULL`,
                    [resolvedSpIds],
                );
                const orphanProductIds = (orphanRows as any[]).map((r: any) => Number(r.productId));
                if (orphanProductIds.length > 0) {
                    // Retry once on deadlock — INSERT ... ON DUPLICATE KEY UPDATE
                    // can deadlock transiently when two uploads run concurrently.
                    for (let attempt = 1; attempt <= 2; attempt++) {
                        try {
                            await refillForOrphans(orphanProductIds);
                            break;
                        } catch (e: any) {
                            if (e?.code === 'ER_LOCK_DEADLOCK' && attempt < 2) {
                                await new Promise(r => setTimeout(r, 200));
                                continue;
                            }
                            throw e;
                        }
                    }
                }
            } catch (e) {
                countFailOpen('orphan-refill');
                console.warn('OrphanSwipeCandidate refill failed:', e);
            }
        })();
    }

    // Fallback propagation runs fire-and-forget AFTER the HTTP response
    // would have returned. Previously ran one propagateFallbackPrices() per
    // product in parallel, producing N×M individual INSERTs that exhausted
    // the DB pool and blocked the swipe-queue query for 10–30 s.
    // Now runs as a single batch (3 queries total regardless of product count).
    if (toPropagate.length > 0) {
        void (async () => {
            try {
                // Skip category 688 (Nepriskirta) SPs — OCR garbage that slipped through
                // the resolver. Propagating them fans out hundreds of identical fallback
                // rows to every store in the chain.
                const [catRows]: any = await pool.query(
                    `SELECT sp.id AS spId, p.categoryId
                       FROM StoreProduct sp
                       JOIN Product p ON p.id = sp.productId
                      WHERE sp.id IN (?)`,
                    [toPropagate.map(t => t.storeProductId)],
                );
                const validSpIds = new Set<number>(
                    (catRows as any[])
                        .filter((r: any) => Number(r.categoryId) !== 688)
                        .map((r: any) => Number(r.spId)),
                );
                const eligible = toPropagate.filter(t => validSpIds.has(t.storeProductId));
                if (eligible.length > 0) {
                    await propagateAllFallbackPrices(eligible, receiptId);
                }
            } catch (e) {
                countFailOpen('fallback-propagation');
                console.warn('Fallback propagation failed:', e);
            }
        })();
    }

    return result;
};

/**
 * NON-DESTRUCTIVE autosave for `PUT /receipts/:id` (the client's debounced edit save).
 *
 * The old behavior routed autosaves through the FULL persistReceiptPrices pipeline, which
 * re-ran Round-2 + the resolver and DELETE+INSERTed every ReceiptItem row — cascading away
 * the receipt's Price rows (Price.receiptItemId is ON DELETE CASCADE) and overwriting
 * server-owned vote state (matchConfirmed / priceVerified flips from swipes, Card-B
 * demotions, reject-match vetoes) with the client's STALE blob copy on every keystroke's
 * debounce. This function replaces that with an ownership-aware MERGE:
 *
 *   CLIENT-OWNED (always merged): header/footer blob, storeId, and per-line content the
 *     user can edit — name, price, promoPrice, quantity, unit. A price/promo edit also
 *     updates the line's OWN Price row in place (same row id — no cascade, no re-mint).
 *   CLIENT-OWNED WHEN EXPLICIT (merged only when the line carries `manualMatch: true`,
 *     set by the app's manual-rematch flow): matchedSpId + display fields. A stale line
 *     WITHOUT the marker can never re-adjudicate a match — so the initial-save Round-2
 *     repicks, swipe votes, and reject-match vetoes all survive autosaves.
 *   SERVER-OWNED (never touched here): matchConfirmed/priceVerified vote state, bands,
 *     matchSource, swipe candidates, the mandatory-swipe session, points, propagation.
 *
 * Lines are matched by lineIdx; autosave never creates or deletes lines. Receipts with NO
 * ReceiptItem rows (pre-migration, un-backfilled) fall back to the legacy full save.
 */
export const applyReceiptAutosave = async (
    receiptId: number,
    userId: string,
    parsedData: any,
    input: ParsedReceiptInput,
): Promise<SaveResult> => {
    const result: SaveResult = {
        saved: 0,
        mandatorySwipesRequired: 0,
        skippedNoMatch: 0,
        skippedClearance: 0,
        skippedDuplicate: 0,
        skippedImplausible: 0,
    };

    // Legacy fallback: a receipt that predates the ReceiptItem migration has no rows to
    // merge into — route it through the original full save so its edits still persist.
    const [cntRows]: any = await pool.query(
        'SELECT COUNT(*) AS n FROM ReceiptItem WHERE receiptId = ?',
        [receiptId],
    );
    if (Number(cntRows?.[0]?.n ?? 0) === 0) {
        return persistReceiptPrices(receiptId, userId, parsedData, input, false, false);
    }

    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        // ── Identity normalization — same rules as the initial save ──
        const footerRawText = parsedData?.footer?.rawText ?? null;
        const normalizedReceiptNo = normalizeReceiptNo(input.receiptNo, footerRawText);
        const normalizedReceiptDate = normalizeReceiptDateForStorage(input.date, input.time);
        const parsedReceiptNos: unknown = parsedData?.footer?.receiptNos;
        const normalizedReceiptNos = normalizeReceiptNos(
            Array.isArray(parsedReceiptNos) ? (parsedReceiptNos as string[]) : (input.receiptNo ? [input.receiptNo] : []),
            normalizedReceiptNo,
        );
        const canonicalReceiptNo = normalizedReceiptNos[0] ?? normalizedReceiptNo;
        if (parsedData && typeof parsedData === 'object') {
            if ('receiptNo' in parsedData) parsedData.receiptNo = canonicalReceiptNo;
            if (parsedData.footer && typeof parsedData.footer === 'object') {
                parsedData.footer.receiptNo = canonicalReceiptNo;
                parsedData.footer.receiptNos = normalizedReceiptNos;
            }
        }

        // ── Image-dims guard (band-drift class) ──
        // The OCR coordinate-space dims are written ONCE at initial save and never
        // legitimately change for the same image file. An autosave arriving with the
        // same (or missing) filePath but DIFFERENT width/height is a fabricated client
        // snapshot — e.g. built during loadExistingReceipt's null-imageDims window from
        // geometry extents (receipt-230: 914x3402 fabricated vs 925x3699 real → every
        // band drifted down ×1.087 on the next open). Keep the stored dims; only a NEW
        // filePath (genuine re-upload) may bring new dims.
        try {
            const [imgRows]: any = await connection.query(
                `SELECT JSON_UNQUOTE(JSON_EXTRACT(parsedData, '$.image.filePath')) AS fp,
                        JSON_EXTRACT(parsedData, '$.image.width')  AS w,
                        JSON_EXTRACT(parsedData, '$.image.height') AS h
                   FROM Receipt WHERE id = ?`,
                [receiptId],
            );
            const stored = imgRows?.[0];
            if (guardImageDims(stored, parsedData?.image)) {
                console.warn(
                    `[applyReceiptAutosave] receipt ${receiptId}: rejected client image-dims change — kept stored ${stored.w}x${stored.h}`,
                );
            }
        } catch { /* guard is fail-open — a malformed blob must not block the save */ }

        // ── Blob: header/footer only (products live in ReceiptItem; rawText stripped) ──
        await updateReceiptDetails(
            receiptId,
            normalizedReceiptNos,
            normalizedReceiptDate,
            'completed',
            stripProductRawText({ ...parsedData, products: [] }),
            connection,
        );
        if (input.storeId) {
            await updateReceiptStore(receiptId, input.storeId, connection);
        }

        // ── Per-line merge ──
        const [rows]: any = await connection.query(
            `SELECT id, lineIdx, name, price, promoPrice, quantity, unit, matchedSpId
               FROM ReceiptItem WHERE receiptId = ? FOR UPDATE`,
            [receiptId],
        );
        const rowByIdx = new Map<number, any>(rows.map((r: any) => [Number(r.lineIdx), r]));
        const clientLines: any[] = Array.isArray(parsedData?.products) ? parsedData.products : [];
        const num = (v: any): number | null => {
            if (v == null || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };

        for (let i = 0; i < clientLines.length; i++) {
            const line = clientLines[i];
            const row = rowByIdx.get(i);
            if (!line || !row) continue; // autosave never creates/deletes lines

            const updates: Record<string, any> = {};

            // User-editable content fields.
            if (typeof line.name === 'string' && line.name.trim() && line.name !== row.name) {
                updates.name = line.name;
            }
            const newPrice = num(line.price);
            const rowPrice = num(row.price);
            if (newPrice != null && newPrice !== rowPrice) updates.price = newPrice;
            const newPromo = num(line.promoPrice);
            const rowPromo = num(row.promoPrice);
            if (newPromo !== rowPromo) updates.promoPrice = newPromo;
            const newQty = num(line.quantity);
            if (newQty != null && newQty > 0 && newQty !== num(row.quantity)) updates.quantity = newQty;
            if (typeof line.unit === 'string' && line.unit && line.unit !== row.unit) updates.unit = line.unit;

            // Explicit manual rematch ONLY (the app marks the line). A differing SP
            // WITHOUT the marker is stale client state and must not win.
            const rowSp = row.matchedSpId == null ? null : Number(row.matchedSpId);
            const clientSpRaw = num(line.storeProductId);
            const clientSp = clientSpRaw != null && clientSpRaw > 0 ? clientSpRaw : null;
            let matchChanged = false;
            if (line.manualMatch === true && clientSp !== rowSp) {
                // Guard: a manual pick must exist and belong to the receipt's chain.
                let spOk = clientSp == null;
                if (clientSp != null) {
                    const [spRows]: any = await connection.query(
                        'SELECT chainId FROM StoreProduct WHERE id = ?',
                        [clientSp],
                    );
                    spOk = spRows.length > 0 &&
                        (!Number.isFinite(input.chainId) || Number(spRows[0].chainId) === Number(input.chainId));
                }
                if (spOk) {
                    matchChanged = true;
                    updates.matchedSpId = clientSp;
                    updates.matchedName = line.matchedName ?? null;
                    updates.storeProductImageUrl = line.storeProductImageUrl ?? null;
                    updates.matchConfidence = line.matchConfidence ?? null;
                    updates.matchConfirmed = false;   // a fresh manual pick is not vote-confirmed
                    updates.priceVerified = false;
                    if (Array.isArray(line.altMatches)) updates.altMatches = line.altMatches;
                    // Re-derive the confidence band for the NEW match (same recipe the
                    // demotion service uses) — leaving the old match's band on the row
                    // would permanently exclude the fresh unconfirmed pick from Card-B.
                    const ic = computeItemConfidence({
                        nameConf: Number.isFinite(Number(line.matchConfidence)) ? Number(line.matchConfidence) : null,
                        nameText: typeof line.name === 'string' ? line.name : (row.name ?? ''),
                        priceVerified: false,
                        viaPromo: false,
                        gapToRunnerUp: 0,
                        source: clientSp != null ? 'reused' : 'unmatched',
                        priceImplausible: false,
                        userRejected: false,
                    });
                    updates.itemConfidence = ic;
                    updates.band = ic.band;
                    const nhQty = newQty != null && newQty > 0 ? newQty : (num(row.quantity) ?? 1);
                    const nhUnit = newPrice != null ? newPrice : (rowPrice ?? 0);
                    updates.needsHuman = computeNeedsHuman({
                        band: ic.band,
                        gapToRunnerUp: 0,
                        candidateCount: Array.isArray(line.altMatches) ? line.altMatches.length : 0,
                        hasVeto: Array.isArray(ic.vetoes) && ic.vetoes.length > 0,
                        source: clientSp != null ? 'reused' : 'unmatched',
                        lineTotalEur: Math.max(0, nhUnit) * nhQty,
                    });
                }
            }

            if (Object.keys(updates).length === 0) continue;
            await updateReceiptItem(receiptId, i, updates, connection);
            result.saved++;

            // ── Keep the line's OWN Price row in step (in place — never delete/re-mint) ──
            // Effective merged values; a promo only counts when positive and below the price
            // (the full save's convention). Every write here resets priceVerified — an edited
            // value / re-pointed SP is no longer the verified observation.
            const effPrice = updates.price != null ? updates.price : rowPrice;
            const effPromo0 = 'promoPrice' in updates ? updates.promoPrice : rowPromo;
            const effPromo = effPromo0 != null && effPrice != null && effPromo0 > 0 && effPromo0 < effPrice ? effPromo0 : null;
            if (matchChanged) {
                if (clientSp == null) {
                    // Un-linked: mirror the demotion convention — keep the observation, unverify it.
                    await connection.query(
                        'UPDATE Price SET priceVerified = 0 WHERE receiptItemId = ? AND isFallback = 0',
                        [row.id],
                    );
                } else {
                    let repointed = 1;
                    try {
                        const [pres]: any = await connection.query(
                            'UPDATE Price SET storeProductId = ?, priceVerified = 0 WHERE receiptItemId = ? AND isFallback = 0',
                            [clientSp, row.id],
                        );
                        repointed = pres?.affectedRows ?? 0;
                    } catch (e: any) {
                        // (sp, store, date) unique collision — another row already records this
                        // SP at that slot. Keep the old row but make sure it can't verify-pollute.
                        if (e?.code !== 'ER_DUP_ENTRY') throw e;
                        await connection.query(
                            'UPDATE Price SET priceVerified = 0 WHERE receiptItemId = ? AND isFallback = 0',
                            [row.id],
                        );
                    }
                    // Previously-UNMATCHED line: it has NO Price row (unmatched lines never
                    // write one), so a manual match must INSERT the observation here — no
                    // later flow will. Guarded to a real positive price + a known store.
                    if (repointed === 0 && input.storeId && effPrice != null && effPrice > 0) {
                        const d = normalizedReceiptDate ? new Date(normalizedReceiptDate.replace(' ', 'T')) : new Date();
                        const priceDate = Number.isNaN(d.getTime()) ? new Date() : d;
                        await createPrice(
                            clientSp, input.storeId, effPrice, effPromo,
                            effPromo != null
                                ? new Date(priceDate.getTime() + RECOGNITION.price.receiptPromoValidityDays * 24 * 60 * 60 * 1000)
                                : null,
                            false, priceDate,
                            false, receiptId, false, connection, row.id,
                        );
                    }
                }
            }
            if (updates.price != null || 'promoPrice' in updates) {
                // A nonpositive edited price never reaches the reference table (the full
                // save's `price <= 0` skip) — the ReceiptItem keeps it for display only.
                if (effPrice != null && effPrice > 0) {
                    await connection.query(
                        'UPDATE Price SET price = ?, promoPrice = ?, priceVerified = 0 WHERE receiptItemId = ? AND isFallback = 0',
                        [effPrice, effPromo, row.id],
                    );
                }
            }
        }

        // ── savedAmount from the MERGED rows (a price edit changes the savings) ──
        // Promo-aware, matching the initial save + the profile's totalSavings.
        const [merged]: any = await connection.query(
            'SELECT matchedSpId, matchConfirmed, price, promoPrice, quantity FROM ReceiptItem WHERE receiptId = ?',
            [receiptId],
        );
        const matchedItems = (merged as any[])
            .filter((r) => r.matchConfirmed && r.matchedSpId && Number(r.price) > 0)
            .map((r) => {
                const price = Number(r.price);
                const promo = r.promoPrice != null ? Number(r.promoPrice) : null;
                return {
                    storeProductId: Number(r.matchedSpId),
                    price: promo != null && promo > 0 && promo < price ? promo : price,
                    quantity: Number(r.quantity) || 1,
                };
            });
        // Same combo/set-deal adjustment as the initial save (footer.comboDiscount rides
        // the incoming blob), capped at the merged rows' paid sum.
        const mergedSum = (merged as any[]).reduce(
            (s, r) => s + (Number(r.price) > 0 ? Number(r.price) * (Number(r.quantity) || 1) : 0), 0);
        const combo = comboDiscountOf(parsedData, mergedSum);
        const savedAmount = Math.round((await computeReceiptSavings(matchedItems, connection) + combo) * 100) / 100;
        await updateReceiptSavedAmount(receiptId, savedAmount, connection);

        await connection.commit();
        // TRIGGER A — same as the initial-save path: an edit/rematch can newly produce
        // an S1 match that contradicts an old personal 'different'. Fail-open.
        flagDivergenceFromReceipt(receiptId, userId).catch((e) =>
            console.warn(`[applyReceiptAutosave] reverification flagging failed for receipt ${receiptId}:`, e),
        );
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};
