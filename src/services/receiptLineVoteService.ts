import type { Connection } from 'mysql2/promise';
import { computeItemConfidence } from './itemConfidence.js';
import { demoteReceiptLineDirect } from './receiptLineDemotionService.js';
import { setReceiptLinePriceVerified } from '../models/receiptLineIssueModel.js';

/**
 * Apply a Card-B swipe to a receipt line (see shared/SWIPE_QUEUE_REDESIGN.md):
 *   identical → confirm the product + trust the price (price-verified, S1).
 *   similar   → confirm the product but NOT the price (variant uncertain, S1, price unverified).
 *   different → demote (re-point to a same-chain runner-up ≥ auto-apply, else OCR).
 *
 * identical/similar mark the line user-confirmed (itemConfidence → S1, the strongest
 * signal) and sync the Price row. Returns the mutated line (or null if nothing to act on).
 * Reads + writes parsedData FOR UPDATE inside the caller's transaction.
 */
export type ReceiptLineVote = 'identical' | 'similar' | 'different';

export async function castReceiptLineVote(
    receiptId: number,
    lineIdx: number,
    vote: ReceiptLineVote,
    conn: Connection,
): Promise<any | null> {
    if (vote === 'different') {
        return demoteReceiptLineDirect(receiptId, lineIdx, conn);
    }

    const [rows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ? FOR UPDATE', [receiptId]);
    const raw = rows?.[0]?.parsedData;
    if (!raw) return null;
    let parsed: any;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    const line = parsed?.products?.[lineIdx];
    if (!line) return null;
    const sp = Number(line.storeProductId);
    if (!Number.isFinite(sp) || sp <= 0) return null; // no match to confirm

    const priceVerified = vote === 'identical'; // similar keeps the product but not the price
    line.matchConfirmed = true;
    line.priceVerified = priceVerified;
    line.variantUncertain = vote === 'similar'; // "right product, maybe wrong size/variant"
    line.itemConfidence = computeItemConfidence({
        nameConf: Number.isFinite(line.matchConfidence) ? Number(line.matchConfidence) : null,
        nameText: typeof line.name === 'string' ? line.name : '',
        priceVerified,
        viaPromo: false,
        gapToRunnerUp: 0,
        source: 'reused',
        priceImplausible: false,
        userConfirmed: true,
    });

    await conn.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(parsed), receiptId]);
    await setReceiptLinePriceVerified(receiptId, sp, priceVerified, conn);
    return line;
}
