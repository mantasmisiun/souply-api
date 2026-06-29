import {
    createPrice,
    batchGetBaselinePriceAverages,
    batchGetLatestPricesForReceiptItems,
} from '../models/priceModel.js';
import { updateReceiptDetails, updateReceiptStore, updateReceiptSavedAmount } from '../models/receiptModel.js';
import { computeReceiptSavings } from './statsService.js';
import {
    replaceSwipeCandidates,
    type SwipeCandidate,
} from '../models/receiptSwipeCandidateModel.js';
import { resolveReceiptLineStoreProduct } from './receiptLineResolver.js';
import { applyPriceRound2Matching, type Round2Result } from './priceRound2Matcher.js';
import { propagateAllFallbackPrices } from './priceService.js';
import { refillForOrphans } from '../scripts/seedOrphanSwipeCandidates.js';
import pool from '../config/db.js';
import { normalizeReceiptDateForStorage, normalizeReceiptNo } from '../utils/receiptMetadata.js';
import { awardReceiptPoints } from './userPointsService.js';
import { initMandatorySwipeSession, MANDATORY_SWIPES_PER_RECEIPT } from './swipeSessionService.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { computeItemConfidence, type ItemConfidenceInput } from './itemConfidence.js';
import { computeNeedsHuman } from './queueRanking.js';
import { isMislabeledWeighableKg } from '../utils/productMatcher.js';
import { getStoreProductDisplayById } from '../models/storeProductModel.js';

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

        if (parsedData && typeof parsedData === 'object') {
            if ('receiptNo' in parsedData) {
                parsedData.receiptNo = normalizedReceiptNo;
            }
            if (parsedData.footer && typeof parsedData.footer === 'object') {
                parsedData.footer.receiptNo = normalizedReceiptNo;
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
            try {
                const r2Parsed = normalizedReceiptDate
                    ? new Date(normalizedReceiptDate.replace(' ', 'T'))
                    : null;
                const r2Date = r2Parsed && !Number.isNaN(r2Parsed.getTime()) ? r2Parsed : new Date();
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
                        // skipped_unpriced — leave the line UNMATCHED (it still shows
                        // on the receipt, but links to nothing and writes no price).
                        resolveSourceByLine.set(i, 'skipped_unpriced');
                        line.matchConfirmed = false;
                        if (input.products[i]) input.products[i].matchConfirmed = false;
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
                    console.warn(`Failed to resolve receipt line ${i}:`, e);
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
            for (let i = 0; i < parsedData.products.length; i++) {
                const line = parsedData.products[i];
                const spId = Number.isFinite(line?.storeProductId) ? Number(line.storeProductId) : null;
                if (spId === null || spId <= 0) continue;
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
            console.log(
                `=== RECEIPT ${receiptId} MATCH SUMMARY (chain ${input.chainId}): ` +
                `${perfect.size} perfect / ${repicked.size} repicked / ${rejected.size} price-rejected / ${rows.length} matched ===` +
                (rows.length ? `\n${rows.join('\n')}` : ''),
            );
        }

        await updateReceiptDetails(
            receiptId,
            normalizedReceiptNo,
            normalizedReceiptDate,
            'completed',
            parsedData,
            connection
        );
        if (input.storeId) {
            await updateReceiptStore(receiptId, input.storeId, connection);
        }

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

        for (const item of input.products) {
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
                null,
                false,
                writeDate,
                item.priceVerified === true,
                receiptId,
                false,
                connection
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
        // Only counts items that were successfully matched to a StoreProduct.
        const matchedItems = input.products
            .filter(p => p.matchConfirmed && p.storeProductId && p.price > 0)
            .map(p => ({
                storeProductId: p.storeProductId!,
                price: p.price,
                quantity: p.quantity || 1,
            }));
        const savedAmount = await computeReceiptSavings(matchedItems, connection);
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
                console.warn('Fallback propagation failed:', e);
            }
        })();
    }

    return result;
};
