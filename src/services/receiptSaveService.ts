import {
    createPrice,
    getBaselinePriceAverage,
    getLatestPriceForReceiptItem,
} from '../models/priceModel.js';
import { updateReceiptDetails, updateReceiptStore } from '../models/receiptModel.js';
import {
    replaceSwipeCandidates,
    type SwipeCandidate,
} from '../models/receiptSwipeCandidateModel.js';
import { resolveReceiptLineStoreProduct } from './receiptLineResolver.js';
import { propagateFallbackPrices } from './priceService.js';
import pool from '../config/db.js';
import { normalizeReceiptDateForStorage, normalizeReceiptNo } from '../utils/receiptMetadata.js';

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
    _userId: string,
    parsedData: any,
    input: ParsedReceiptInput
): Promise<SaveResult> => {
    const result: SaveResult = {
        saved: 0,
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
                            unit: typeof line.unit === 'string' ? line.unit : null,
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
                return alt.slice(0, MAX_CANDIDATES_PER_LINE).map((am: any): SwipeCandidate => ({
                    storeProductId: Number(am.storeProductId),
                    matchScore: Number.isFinite(am.confidence) ? Number(am.confidence) : 0,
                    autoMatched:
                        verified &&
                        lineSpId !== null &&
                        Number(am.storeProductId) === lineSpId,
                }));
            }
        );
        await replaceSwipeCandidates(receiptId, candidatesByLine, connection);

        // No resolved store → can't attach prices, but parsedData + candidates were saved.
        if (!input.storeId) {
            await connection.commit();
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

        for (const item of input.products) {
            if (!item.matchConfirmed || !item.storeProductId) {
                result.skippedNoMatch++;
                continue;
            }
            if (!item.price || item.price <= 0) {
                result.skippedNoMatch++;
                continue;
            }

            const baseline = await getBaselinePriceAverage(
                item.storeProductId,
                input.storeId,
                BASELINE_WINDOW,
                connection
            );
            if (baseline !== null && item.price < baseline * CLEARANCE_RATIO) {
                result.skippedClearance++;
                continue;
            }

            const latest = await getLatestPriceForReceiptItem(
                item.storeProductId,
                input.storeId,
                receiptId,
                connection
            );
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
                connection
            );
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

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    // Fallback propagation runs fire-and-forget AFTER the HTTP response
    // would have returned. For a 20-product Maxima receipt, propagation is
    // ~1,000 INSERTs across the whole chain — previously this blocked the
    // mobile client for ~10–30 s before it saw the receipt saved. Detaching
    // it means the UI unlocks in under a second; propagation races to
    // completion in the background. Errors still log but never surface.
    void (async () => {
        for (const p of toPropagate) {
            try {
                await propagateFallbackPrices(
                    p.storeProductId,
                    p.storeId,
                    p.chainId,
                    p.price,
                    p.promoPrice,
                    p.date,
                    receiptId
                );
            } catch (e) {
                console.warn(`Fallback propagation failed for sp=${p.storeProductId}:`, e);
            }
        }
    })();

    return result;
};
