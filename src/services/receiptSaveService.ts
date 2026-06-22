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
import { propagateAllFallbackPrices } from './priceService.js';
import { refillForOrphans } from '../scripts/seedOrphanSwipeCandidates.js';
import pool from '../config/db.js';
import { normalizeReceiptDateForStorage, normalizeReceiptNo } from '../utils/receiptMetadata.js';
import { awardReceiptPoints } from './userPointsService.js';
import { initMandatorySwipeSession, MANDATORY_SWIPES_PER_RECEIPT } from './swipeSessionService.js';

const MAX_CANDIDATES_PER_LINE = 5;

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
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
}

const CLEARANCE_RATIO = 0.5;
const BASELINE_WINDOW = 5;

export interface SaveResult {
    saved: number;
    skippedNoMatch: number;
    skippedClearance: number;
    skippedDuplicate: number;
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
): Promise<SaveResult> => {
    const result: SaveResult = {
        saved: 0,
        mandatorySwipesRequired: 0,
        skippedNoMatch: 0,
        skippedClearance: 0,
        skippedDuplicate: 0,
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

        // Rule 1: resolve a concrete storeProductId for every receipt line
        // before we save. Lines already matched by mobile are left alone.
        // Unmatched lines get a dedup lookup first (same chain + exact name +
        // amount + unit); if nothing hits, we create a fresh Product + SP
        // (inheriting the top alt-match's category when available, else
        // falling back to the hidden Nepriskirta bucket). The new SP flows
        // into parsedData AND the filtered `input.products` so the downstream
        // Price-write loop sees it.
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
                    const res = await resolveReceiptLineStoreProduct(
                        input.chainId,
                        {
                            storeProductId: incomingSpId,
                            name: line.name,
                            brandName: typeof line.brandName === 'string' ? line.brandName : null,
                            amount: Number.isFinite(line.amount) ? Number(line.amount) : null,
                            unit: typeof line.sizeUnit === 'string' ? line.sizeUnit : null,
                            isWeighable: !!line.isWeighable,
                            imageUrl: typeof line.imageUrl === 'string' ? line.imageUrl : null,
                            price: Number.isFinite(line.price) ? Number(line.price) : null,
                            altMatchProductId:
                                Array.isArray(line.altMatches) && line.altMatches[0]?.productId
                                    ? Number(line.altMatches[0].productId)
                                    : null,
                        },
                        connection
                    );
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
                } catch (e) {
                    console.warn(`Failed to resolve receipt line ${i}:`, e);
                }
            }
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

        for (const item of input.products) {
            if (!item.matchConfirmed || !item.storeProductId) {
                result.skippedNoMatch++;
                continue;
            }
            if (!item.price || item.price <= 0) {
                result.skippedNoMatch++;
                continue;
            }

            const baseline = baselineMap.get(item.storeProductId) ?? null;
            if (baseline !== null && item.price < baseline * CLEARANCE_RATIO) {
                result.skippedClearance++;
                continue;
            }

            const latest = latestMap.get(item.storeProductId) ?? null;
            if (latest) {
                const samePrice = Math.abs(parseFloat(latest.price) - item.price) < 0.001;
                const latestPromo = latest.promoPrice === null ? null : parseFloat(latest.promoPrice);
                const samePromo =
                    latestPromo === item.promoPrice ||
                    (latestPromo !== null &&
                        item.promoPrice !== null &&
                        Math.abs(latestPromo - item.promoPrice) < 0.001);
                if (samePrice && samePromo) {
                    result.skippedDuplicate++;
                    continue;
                }
            }

            await createPrice(
                item.storeProductId,
                input.storeId,
                item.price,
                item.promoPrice,
                null,
                false,
                writeDate,
                item.priceVerified === true,
                receiptId,
                false,
                connection
            );
            // Update latestMap so within-receipt duplicates of the same SP
            // (e.g. parser bug generating 85 bands for one product) are
            // caught on the next iteration without needing a DB round-trip.
            latestMap.set(item.storeProductId, {
                price: String(item.price),
                promoPrice: item.promoPrice === null ? null : String(item.promoPrice),
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
                    promoPrice: item.promoPrice,
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
