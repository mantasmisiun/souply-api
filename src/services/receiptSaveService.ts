import {
    createPrice,
    getBaselinePriceAverage,
    getLatestPriceForReceiptItem,
} from '../models/priceModel.js';
import { updateReceiptDetails, updateReceiptStore } from '../models/receiptModel.js';
import { propagateFallbackPrices } from './priceService.js';
import pool from '../config/db.js';
import { normalizeReceiptDateForStorage, normalizeReceiptNo } from '../utils/receiptMetadata.js';

interface ParsedReceiptInput {
    chainId: number;
    storeId: number | null;
    receiptNo: string | null;
    date: string | null;
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
        const normalizedReceiptDate = normalizeReceiptDateForStorage(input.date);

        if (parsedData && typeof parsedData === 'object') {
            if ('receiptNo' in parsedData) {
                parsedData.receiptNo = normalizedReceiptNo;
            }
            if ('date' in parsedData) {
                parsedData.date = normalizedReceiptDate;
            }
            if (parsedData.footer && typeof parsedData.footer === 'object') {
                parsedData.footer.receiptNo = normalizedReceiptNo;
                parsedData.footer.date = normalizedReceiptDate;
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

        // No resolved store → can't attach prices, but parsedData is still saved
        if (!input.storeId) {
            await connection.commit();
            return result;
        }

        const writeDate = new Date();

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

            toPropagate.push({
                storeProductId: item.storeProductId,
                storeId: input.storeId,
                chainId: input.chainId,
                price: item.price,
                promoPrice: item.promoPrice,
                date: writeDate,
            });
        }

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    for (const p of toPropagate) {
        try {
            await propagateFallbackPrices(
                p.storeProductId,
                p.storeId,
                p.chainId,
                p.price,
                p.promoPrice,
                p.date
            );
        } catch (e) {
            console.warn(`Fallback propagation failed for sp=${p.storeProductId}:`, e);
        }
    }

    return result;
};
