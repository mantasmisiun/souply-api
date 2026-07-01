import type { Connection } from 'mysql2/promise';
import { computeItemConfidence } from './itemConfidence.js';
import { demoteReceiptLineDirect } from './receiptLineDemotionService.js';
import { setReceiptLinePriceVerified } from '../models/receiptLineIssueModel.js';
import { recordAliasVote } from '../models/storeProductAliasModel.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

/**
 * Apply a Card-B swipe to a receipt line (see shared/SWIPE_QUEUE_REDESIGN.md):
 *   identical → confirm the product + trust the price (price-verified, S1).
 *   similar   → SUBSTITUTE: a same-category but DIFFERENT product, so demote the line
 *               (it isn't this exact SP) — the same-category link is learned as a
 *               'similarity' alias for L2-scoped re-matching, not kept on the line.
 *   different → demote (re-point to a same-chain runner-up ≥ auto-apply, else OCR).
 *
 * Every vote is ALSO recorded as a chain-scoped VOCABULARY alias vote (Issue H):
 *   identical → learn the alias when the matcher STRUGGLED (the valuable hard cases);
 *   similar/different → always (they correct/contest the match, feeding the alias
 *   state machine's similarity link + balanced veto + the no-repeat-combo blacklist).
 * Returns the mutated line (or null when there's nothing to act on). Reads + writes
 * parsedData FOR UPDATE inside the caller's transaction.
 */
export type ReceiptLineVote = 'identical' | 'similar' | 'different';

export async function castReceiptLineVote(
    receiptId: number,
    lineIdx: number,
    vote: ReceiptLineVote,
    conn: Connection,
    userId?: string,
): Promise<any | null> {
    // Read the line + the SP the user is judging BEFORE any demotion, so the alias
    // vote is recorded against the right SP even when we then demote the line.
    const [rows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ? FOR UPDATE', [receiptId]);
    const raw = rows?.[0]?.parsedData;
    let parsed: any = null;
    if (raw) {
        try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; }
    }
    const line = parsed?.products?.[lineIdx] ?? null;
    const sp = line ? Number(line.storeProductId) : NaN;
    const chainId = Number(parsed?.header?.chainId);
    const ocrName = line && typeof line.name === 'string' ? line.name : '';

    // ── VOCABULARY (Issue H): record the user's verdict as a chain-scoped alias vote.
    if (userId && Number.isFinite(chainId) && Number.isFinite(sp) && sp > 0 && ocrName.trim()) {
        const matchConf = Number(line.matchConfidence);
        const struggled = !Number.isFinite(matchConf) || matchConf < RECOGNITION.match.autoApplyThreshold;
        // identical only when the matcher struggled (skip redundant aliases the catalog
        // name already matches); similar/different always (corrections are always useful).
        if (vote !== 'identical' || struggled) {
            try {
                await recordAliasVote({ chainId, storeProductId: sp, rawName: ocrName, userId, vote, receiptId }, conn);
            } catch (e) {
                console.warn('[vocab] alias capture failed (non-fatal):', (e as Error)?.message ?? e);
            }
        }
    }

    // ── Apply the vote's effect to the receipt line.
    if (vote === 'different' || vote === 'similar') {
        // 'different' = wrong product; 'similar' = a same-category SUBSTITUTE (a
        // DIFFERENT product). Neither is THIS exact SP, so demote to a runner-up /
        // fresh orphan / OCR. The same-category link for 'similar' lives in the alias
        // (similarity status) and drives L2-scoped re-matching, not the line.
        return demoteReceiptLineDirect(receiptId, lineIdx, conn);
    }

    // 'identical' → confirm the product + trust the price (user-confirmed → S1).
    if (!line || !Number.isFinite(sp) || sp <= 0) return null; // no match to confirm
    line.matchConfirmed = true;
    line.priceVerified = true;
    line.variantUncertain = false;
    line.itemConfidence = computeItemConfidence({
        nameConf: Number.isFinite(line.matchConfidence) ? Number(line.matchConfidence) : null,
        nameText: ocrName,
        priceVerified: true,
        viaPromo: false,
        gapToRunnerUp: 0,
        source: 'reused',
        priceImplausible: false,
        userConfirmed: true,
    });

    await conn.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(parsed), receiptId]);
    await setReceiptLinePriceVerified(receiptId, sp, true, conn);
    return line;
}
