import type { Connection } from 'mysql2/promise';
import { computeItemConfidence } from './itemConfidence.js';
import { demoteReceiptLineDirect } from './receiptLineDemotionService.js';
import { setReceiptLinePriceVerified } from '../models/receiptLineIssueModel.js';
import { recordAliasVote } from '../models/storeProductAliasModel.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

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
    userId?: string,
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

    // VOCABULARY capture (Issue H): on an 'identical' confirm where the matcher
    // STRUGGLED (name confidence < auto-apply, so the catalog name alone didn't get
    // there), learn this receipt's OCR string as a chain-scoped alias for the SP — so
    // a future receipt with the same garbled print matches it directly. Only the
    // valuable hard cases; fail-open (a learning miss must never fail the vote).
    if (vote === 'identical' && userId) {
        const matchConf = Number(line.matchConfidence);
        const struggled = !Number.isFinite(matchConf) || matchConf < RECOGNITION.match.autoApplyThreshold;
        const chainId = Number(parsed?.header?.chainId);
        if (struggled && Number.isFinite(chainId) && typeof line.name === 'string' && line.name.trim()) {
            try {
                await recordAliasVote(
                    { chainId, storeProductId: sp, rawName: line.name, userId, vote: 'identical', receiptId },
                    conn,
                );
            } catch (e) {
                console.warn('[vocab] alias capture failed (non-fatal):', (e as Error)?.message ?? e);
            }
        }
    }
    return line;
}
