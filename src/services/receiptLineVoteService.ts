import type { Connection } from 'mysql2/promise';
import { computeItemConfidence } from './itemConfidence.js';
import { demoteReceiptLineDirect } from './receiptLineDemotionService.js';
import { setReceiptLinePriceVerified } from '../models/receiptLineIssueModel.js';
import { getSpProposalDisplayById } from '../models/storeProductModel.js';
import { recordAliasVote, fetchSpCategoryLabels, type AliasVoteOutcome } from '../models/storeProductAliasModel.js';
import { syncReceiptItemMatchState, itemToLine } from '../models/receiptItemModel.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

/**
 * Apply a Card-B swipe to a receipt line (see shared/SWIPE_QUEUE_REDESIGN.md +
 * RECEIPT_VOCABULARY.md):
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
 *
 * Emits a coherent [VOCAB] log block per swipe (header → alias effect → line effect) so
 * the whole flow is inspectable. Returns the mutated line (or null when there's nothing
 * to act on). Reads + writes parsedData FOR UPDATE inside the caller's transaction.
 */
export type ReceiptLineVote = 'identical' | 'similar' | 'different';

export async function castReceiptLineVote(
    receiptId: number,
    lineIdx: number,
    vote: ReceiptLineVote,
    conn: Connection,
    userId?: string,
    // PROPOSED-card path (unlinked line whose card showed the best altMatches
    // candidate): the client echoes the card's SP id back here. Validated below
    // against the line's STORED candidates + the receipt's chain — never trusted
    // raw. identical → LINK it; different/similar → alias verdict only.
    proposedSpId?: number | null,
): Promise<any | null> {
    // Read the line from its ReceiptItem row (the source of truth) FOR UPDATE — the confirm
    // below is a single-row UPDATE, not a whole-blob rewrite. The chain comes from the
    // receipt header (still on the blob; products[] no longer are).
    const [itemRows]: any = await conn.query('SELECT * FROM ReceiptItem WHERE receiptId = ? AND lineIdx = ? FOR UPDATE', [receiptId, lineIdx]);
    const line = itemRows?.[0] ? itemToLine(itemRows[0]) : null;
    let chainId = NaN;
    const [hdrRows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ?', [receiptId]);
    if (hdrRows?.[0]?.parsedData) {
        try {
            const p = typeof hdrRows[0].parsedData === 'string' ? JSON.parse(hdrRows[0].parsedData) : hdrRows[0].parsedData;
            chainId = Number(p?.header?.chainId);
        } catch { /* chainId stays NaN → alias vote skipped */ }
    }
    const sp = line ? Number(line.storeProductId) : NaN;
    const ocrName = line && typeof line.name === 'string' ? line.name : '';

    // ── PROPOSED-card validation: only for an UNLINKED line, only an SP that is in the
    //    line's stored altMatches, only same-chain (the chain-price invariant). A failed
    //    validation degrades to the plain unlinked behavior — never an error.
    let proposal: { spId: number; name: string | null; imageUrl: string | null; confidence: number | null;
                    categoryId: number | null; categoryName: string | null; categoryL2Name: string | null } | null = null;
    if (proposedSpId != null && line && !(Number.isFinite(sp) && sp > 0)) {
        const alt = (Array.isArray(line.altMatches) ? line.altMatches : [])
            .find((am: any) => Number(am?.storeProductId) === proposedSpId);
        if (!alt) {
            console.log(`        proposal → REJECTED sp=${proposedSpId} (not among this line's stored candidates)`);
        } else {
            const disp = await getSpProposalDisplayById(proposedSpId, conn);
            if (!disp || (Number.isFinite(chainId) && disp.chainId !== chainId)) {
                console.log(`        proposal → REJECTED sp=${proposedSpId} (${!disp ? 'SP no longer exists' : 'cross-chain'})`);
            } else {
                proposal = {
                    spId: proposedSpId,
                    name: disp.name ?? (typeof alt.name === 'string' ? alt.name : null),
                    imageUrl: disp.imageUrl,
                    confidence: Number.isFinite(alt?.confidence) ? Number(alt.confidence) : null,
                    categoryId: Number.isFinite(Number(alt?.categoryId)) ? Number(alt.categoryId) : null,
                    categoryName: typeof alt?.categoryName === 'string' ? alt.categoryName : null,
                    categoryL2Name: typeof alt?.categoryL2Name === 'string' ? alt.categoryL2Name : null,
                };
            }
        }
    }
    // The SP this vote is ABOUT — the linked one, or the validated proposal (alias
    // learning below attributes the verdict to it either way).
    const effSp = Number.isFinite(sp) && sp > 0 ? sp : (proposal?.spId ?? NaN);

    // ── [VOCAB] header — one coherent block per swipe.
    console.log(`[VOCAB] r${receiptId}/L${lineIdx} ${vote.toUpperCase()}  sp=${Number.isFinite(effSp) ? effSp : '—'}${proposal ? ' (proposed)' : ''} chain=${Number.isFinite(chainId) ? chainId : '—'} ocr=${JSON.stringify(ocrName)}`);

    // ── VOCABULARY (Issue H): record the user's verdict as a chain-scoped alias vote,
    //    logging exactly why it did (or didn't) learn / update the vocabulary.
    let aliasOutcome: AliasVoteOutcome | null = null;
    if (!userId) {
        console.log('        alias → skipped (no userId sent — the client must include it in the vote body)');
    } else if (!(Number.isFinite(chainId) && Number.isFinite(effSp) && effSp > 0 && ocrName.trim())) {
        console.log('        alias → skipped (no chain / SP / OCR text on this line)');
    } else {
        const matchConf = Number(line.matchConfidence);
        const struggled = !Number.isFinite(matchConf) || matchConf < RECOGNITION.match.autoApplyThreshold;
        if (vote === 'identical' && !struggled) {
            // The catalog name already matched confidently — nothing new to learn.
            console.log(`        alias → skipped (matcher already matched confidently, conf=${matchConf.toFixed(2)} ≥ ${RECOGNITION.match.autoApplyThreshold} — nothing to learn)`);
        } else {
            try {
                aliasOutcome = await recordAliasVote({ chainId, storeProductId: effSp, rawName: ocrName, userId, vote, receiptId }, conn);
            } catch (e) {
                console.warn('[vocab] alias capture failed (non-fatal):', (e as Error)?.message ?? e);
            }
            if (aliasOutcome) {
                const tallies = `votes id/sim/diff=${aliasOutcome.identicalUsers}/${aliasOutcome.similarUsers}/${aliasOutcome.differentUsers}`;
                const st = aliasOutcome.status.toUpperCase();
                if (aliasOutcome.status === 'similarity') {
                    const cat = await fetchSpCategoryLabels(effSp, conn);
                    console.log(`        alias → #${aliasOutcome.aliasId} status=${st}  category-link L2=${JSON.stringify(cat.l2)} L3=${JSON.stringify(cat.l3)}  ${tallies}`);
                } else if (aliasOutcome.status === 'canonical') {
                    console.log(`        alias → #${aliasOutcome.aliasId} status=${st} (now used as a match target for everyone)  ${tallies}`);
                } else if (aliasOutcome.status === 'rejected') {
                    console.log(`        alias → #${aliasOutcome.aliasId} status=${st} (combo blacklisted — suppressed in future matching)  ${tallies}`);
                } else {
                    console.log(`        alias → ${vote === 'identical' ? 'CAPTURED' : 'recorded'} #${aliasOutcome.aliasId} status=${st} (needs ${RECOGNITION.vocab.canonicalDistinctUsers} distinct identical voters to go canonical)  ${tallies}`);
                }
            } else {
                console.log('        alias → not recorded (OCR normalizes to nothing significant — too garbled to be a useful alias)');
            }
        }
    }

    // ── Apply the vote's effect to the receipt line.
    if (vote === 'different' || vote === 'similar') {
        if (proposal) {
            // PROPOSED card rejected: the line was never linked, so there is nothing to
            // demote — the alias verdict above (rejected combo / similarity link) is the
            // whole effect, and the resolution ledger stops the re-nag. The NEXT scan's
            // matcher sees the blacklisted combo suppressed and the runner-up proposes.
            console.log(`        line  → PROPOSAL ${vote.toUpperCase()} — line stays unlinked; alias verdict recorded`);
            return line;
        }
        // 'different' = wrong product; 'similar' = a same-category SUBSTITUTE (a
        // DIFFERENT product). Neither is THIS exact SP, so demote to a runner-up /
        // fresh orphan / OCR. The same-category link for 'similar' lives in the alias
        // (similarity status) and drives L2-scoped re-matching, not the line.
        const demoted = await demoteReceiptLineDirect(receiptId, lineIdx, conn);
        const effect = !demoted ? 'nothing to act on (no matched SP)'
            : demoted.storeProductId == null ? 'cleared to OCR name (no SP link)'
            : demoted.matchConfirmed ? `re-pointed to same-chain runner-up SP ${demoted.storeProductId}`
            : `minted a fresh quarantined orphan SP ${demoted.storeProductId}`;
        console.log(`        line  → DEMOTED — ${effect}${vote === 'different' ? '  (no category kept)' : ''}`);
        return demoted;
    }

    // ── 'identical' on a PROPOSED card: LINK the validated candidate. A name confirm
    //    by the user, NOT price evidence — priceVerified stays false (Round-2 already
    //    declined to price-confirm this line; a swipe must not launder it).
    if (proposal) {
        line.storeProductId = proposal.spId;
        line.matchConfirmed = true;
        line.matchedName = proposal.name;
        line.storeProductImageUrl = proposal.imageUrl;
        line.variantUncertain = false;
        line.priceVerified = false;
        if (proposal.categoryId != null) {
            line.categoryId = proposal.categoryId;
            line.categoryName = proposal.categoryName;
            line.categoryL2Name = proposal.categoryL2Name;
        }
        if (proposal.confidence != null) line.matchConfidence = proposal.confidence;
        line.itemConfidence = computeItemConfidence({
            nameConf: proposal.confidence,
            nameText: ocrName,
            priceVerified: false,
            viaPromo: false,
            gapToRunnerUp: 0,
            source: 'reused',
            priceImplausible: false,
            userConfirmed: true,
        });
        await syncReceiptItemMatchState(receiptId, lineIdx, line, conn);
        console.log(`        line  → LINKED proposed SP ${proposal.spId} ${JSON.stringify(proposal.name ?? '')} (user confirm; price stays unverified), itemConfidence ${line.itemConfidence?.band ?? '?'}`);
        return line;
    }

    // 'identical' → confirm the product; trust the price ONLY when Round-2 didn't
    // reject it. The card asks "is your line this product?" — a yes confirms the
    // IDENTITY, not the printed number. A priceImplausible line (receipt-232: the
    // deposit's 0,10 clustered onto the water, rejected against the known €1.49
    // regular) must stay price-unverified, or the confirm would launder a wrong
    // price into "verified" and let it into reference pricing.
    if (!line || !Number.isFinite(sp) || sp <= 0) {
        console.log('        line  → no match to confirm');
        return null;
    }
    const priceRejected = !!line.priceImplausible;
    line.matchConfirmed = true;
    line.priceVerified = !priceRejected;
    line.variantUncertain = false;
    line.itemConfidence = computeItemConfidence({
        nameConf: Number.isFinite(line.matchConfidence) ? Number(line.matchConfidence) : null,
        nameText: ocrName,
        priceVerified: !priceRejected,
        viaPromo: false,
        gapToRunnerUp: 0,
        source: 'reused',
        priceImplausible: priceRejected,
        userConfirmed: true,
    });

    // Confirm the line as a single-row ReceiptItem UPDATE (P2 Step C — the blob no longer
    // carries products[]). This is the authoritative write, so a failure must surface.
    await syncReceiptItemMatchState(receiptId, lineIdx, line, conn);
    if (!priceRejected) await setReceiptLinePriceVerified(receiptId, sp, true, conn);
    console.log(`        line  → CONFIRMED — kept SP ${sp}, ${priceRejected ? 'price stays UNVERIFIED (Round-2 rejected)' : 'price-verified'}, itemConfidence ${line.itemConfidence?.band ?? '?'}`);
    return line;
}
