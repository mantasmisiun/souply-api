import { type SeqLine } from './mandatoryQueueBuilder.js';
import { getResolvedLineIdxSet, markLineAsked } from '../models/receiptLineResolutionModel.js';
import { getReceiptItemLines } from '../models/receiptItemModel.js';
import { getSpProposalDisplayById } from '../models/storeProductModel.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

/**
 * Builds the "resolve your receipt" cards (Card B) for one receipt. See
 * shared/SWIPE_QUEUE_REDESIGN.md. Pure read — the caller marks the served lines
 * 'asked' in the ledger.
 *
 * A line is a Card-B candidate only when it HAS a match (something to confirm)
 * and is uncertain (band S2/S3). The top `limit` highest needs-human, not-yet-asked
 * lines become cards (default = mandatory cap of 2; the voluntary flow passes the
 * larger `voluntaryReceiptHalf`). Older receipts saved before `needsHuman` existed
 * score 0 and simply produce no cards (graceful absence).
 */
type Db = any;

/** Per-line band geometry (parsed.image / OCR space) so the app can render the
 *  SAME skewed-parallelogram crop the receipt-detail "Items" tab draws. */
export interface ReceiptBandRegion {
    xLeft: number;
    xRight: number;
    yTop: number;
    yBottom: number;
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
    xMid?: number;
    yMidTop?: number;
    yMidBottom?: number;
    yMidTopR?: number;
    yMidBottomR?: number;
}

export interface ReceiptImageDims { width: number; height: number; }

export interface ReceiptResolveCard {
    cardKind: 'receipt';
    cardId: string;
    receiptLineIdx: number;
    ocr: { name: string; cropUrl: string };
    /** Band geometry for the client parallelogram crop; null on legacy receipts. */
    region: ReceiptBandRegion | null;
    matched: { spId: number; name: string | null; imageUrl: string | null };
    needsHuman: number;
    /**
     * PROPOSED card: the line is UNLINKED (no storeProductId) and `matched` shows the
     * best altMatches candidate as a PROPOSAL, not an existing link. The client must
     * echo `matched.spId` back as `proposedSpId` in the vote body — identical then
     * LINKS the SP (+ vocabulary alias), different records the rejected combo.
     */
    proposed?: boolean;
    /** Set on a CROSS-CHAIN rescue proposal — the candidate lives in this chain;
     *  an identical swipe mints a provisional SP in the receipt's chain. */
    sourceChainId?: number;
}

export interface ReceiptResolveResult {
    cards: ReceiptResolveCard[];
    /** parsed.image dims (OCR space) so the app can re-project the stored photo. */
    image: ReceiptImageDims | null;
}

export async function buildReceiptResolveCards(
    receiptId: number,
    conn: Db,
    limit: number = RECOGNITION.queue.mandatoryReceiptMax,
): Promise<ReceiptResolveResult> {
    const [rows]: any = await conn.query('SELECT parsedData FROM Receipt WHERE id = ?', [receiptId]);
    const raw = rows?.[0]?.parsedData;
    if (!raw) return { cards: [], image: null };
    let parsed: any;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return { cards: [], image: null };
    }
    // Products come from ReceiptItem rows (P2 source of truth), blob fallback if not backfilled.
    let products = await getReceiptItemLines(receiptId, conn);
    if (products.length === 0 && Array.isArray(parsed?.products)) products = parsed.products;
    if (!Array.isArray(products) || products.length === 0) return { cards: [], image: null };

    // parsed.image dims (OCR portrait space) — the app re-projects the stored photo
    // into this space so the per-line region corners line up 1:1 with the crop.
    const imgW = Number(parsed?.image?.width);
    const imgH = Number(parsed?.image?.height);
    const image: ReceiptImageDims | null =
        Number.isFinite(imgW) && Number.isFinite(imgH) && imgW > 0 && imgH > 0
            ? { width: imgW, height: imgH }
            : null;

    // Per-line CARDING trail (Log 2): for EVERY line, why it does or doesn't become a
    // Card-B swipe card — the matched SP, its band + confidence score + needsHuman, and
    // the verdict. Answers "which cards were suggested, and why these".
    const chainId = Number(parsed?.header?.chainId);
    interface Trail { idx: number; ocr: string; sp: number | null; name: string | null; band: string; score: number | null; needsHuman: number; verdict: string }
    const trail: Trail[] = [];
    const seqLines: SeqLine[] = [];
    // lineIdx → the PROPOSED candidate for an unlinked line (best altMatch, same-chain
    // verified). The card map below renders it in `matched` with proposed=true.
    const proposals = new Map<number, { spId: number; name: string | null; imageUrl: string | null; sourceChainId?: number }>();
    for (let i = 0; i < products.length; i++) {
        const line = products[i];
        const sp = Number(line?.storeProductId);
        const band = line?.itemConfidence?.band ?? '—';
        const s = Number(line?.itemConfidence?.score);
        const needsHuman = Number(line?.needsHuman) || 0;
        const name = typeof line?.matchedName === 'string' ? line.matchedName : null;
        const t: Trail = {
            idx: i, ocr: typeof line?.name === 'string' ? line.name : '',
            sp: Number.isFinite(sp) && sp > 0 ? sp : null, name, band,
            score: Number.isFinite(s) ? s : null, needsHuman, verdict: '',
        };
        const linked = Number.isFinite(sp) && sp > 0;
        if (!linked) {
            // UNLINKED line — the old dead end ("no link → no card → the same failure
            // repeats forever"). When Round-1/2.5 left candidates in altMatches, card
            // the BEST one as a PROPOSAL instead: identical links it (+ vocabulary
            // alias), different blacklists the combo. Price-anchored (viaPrice) entries
            // get the fishing bonus so an exact-regular-price rescue outranks a stale
            // name-only tie. SAME-CHAIN candidates take priority; when none qualifies,
            // a CROSS-CHAIN candidate may propose (the rescue card): the card shows the
            // source chain's badge, the paid price must sit within the ±40% band of that
            // chain's latest price, and an 'identical' MINTS a provisional same-chain SP
            // (crossChainMintService) — linking itself always stays same-chain.
            if (band !== 'S2' && band !== 'S3') {
                t.verdict = `SKIP unlinked band-${band} (not in surfaceBands)`; trail.push(t); continue;
            }
            const alts = Array.isArray(line?.altMatches) ? line.altMatches : [];
            const ranked = alts
                .filter((am: any) => Number.isFinite(Number(am?.storeProductId)) && Number(am?.storeProductId) > 0)
                .map((am: any) => ({
                    am,
                    rank: (Number.isFinite(am?.confidence) ? Number(am.confidence) : 0)
                        + (am?.viaPrice ? RECOGNITION.price.fishPriceBonus : 0),
                }))
                .sort((a: any, b: any) => b.rank - a.rank);
            let proposal: { spId: number; name: string | null; imageUrl: string | null; sourceChainId?: number } | null = null;
            let crossFallback: { spId: number; name: string | null; imageUrl: string | null; sourceChainId?: number } | null = null;
            const linePaid = line?.promoPrice != null && Number(line.promoPrice) > 0
                ? Number(line.promoPrice)
                : (Number.isFinite(Number(line?.price)) && Number(line.price) > 0 ? Number(line.price) : null);
            for (const { am } of ranked) {
                const spId = Number(am.storeProductId);
                const disp = await getSpProposalDisplayById(spId, conn);
                if (!disp) continue;                                    // deleted SP
                if (Number.isFinite(chainId) && disp.chainId !== chainId) {
                    // CROSS-CHAIN rescue candidate — remember the best one that passes the
                    // paid-vs-candidate-chain price band; used only if no same-chain wins.
                    if (crossFallback) continue;
                    if (linePaid != null) {
                        const [pr]: any = await conn.query(
                            `SELECT price FROM Price WHERE storeProductId = ? ORDER BY date DESC, id DESC LIMIT 1`,
                            [spId],
                        );
                        const cand = pr?.[0] ? Number(pr[0].price) : null;
                        if (cand != null && cand > 0) {
                            const ratio = linePaid / cand;
                            if (ratio < RECOGNITION.crossChainMint.cardPriceBandLow ||
                                ratio > RECOGNITION.crossChainMint.cardPriceBandHigh) continue;
                        }
                    }
                    crossFallback = { spId, name: disp.name ?? am.name ?? null, imageUrl: disp.imageUrl, sourceChainId: disp.chainId };
                    continue;
                }
                proposal = { spId, name: disp.name ?? am.name ?? null, imageUrl: disp.imageUrl };
                break;
            }
            if (!proposal && crossFallback) proposal = crossFallback;
            if (!proposal) { t.verdict = 'SKIP no-match (line linked to no SP, no proposable candidate)'; trail.push(t); continue; }
            proposals.set(i, proposal);
            t.sp = proposal.spId;
            t.name = proposal.name;
        } else {
            // Card B compares against a MATCHED product — an orphan line (no matchedName, a
            // freshly-created SP) has nothing to show on the match side; it belongs to
            // orphan-rescue, not "is this right?".
            if (!name || !name.trim()) { t.verdict = 'SKIP orphan-no-matchedName (a minted orphan → goes to orphan-rescue, not Card-B)'; trail.push(t); continue; }
            if (band !== 'S2' && band !== 'S3') { t.verdict = `SKIP band-confident (${band} = matcher is sure, no human needed)`; trail.push(t); continue; }
        }
        const qty = Number.isFinite(line.quantity) ? Number(line.quantity) : 1;
        const unitPrice = line.promoPrice != null && line.promoPrice < line.price ? Number(line.promoPrice) : Number(line.price);
        const lineTotalEur = Number.isFinite(unitPrice) ? Math.max(0, unitPrice) * (qty > 0 ? qty : 1) : 0;
        seqLines.push({ lineIdx: i, band, needsHuman, lineTotalEur });
        trail.push(t); // eligible — verdict finalized after the pick below
    }

    const resolved = await getResolvedLineIdxSet(receiptId, conn);
    const picked = seqLines
        .filter((l) => l.needsHuman > 0 && !resolved.has(l.lineIdx)) // band already gated in seqLines build
        .sort((a, b) => b.needsHuman - a.needsHuman)
        .slice(0, Math.max(0, limit));
    const pickedSet = new Set(picked.map((l) => l.lineIdx));

    // Finalize the eligible (S2/S3 + matched) lines' verdicts now the pick is known.
    for (const t of trail) {
        if (t.verdict) continue; // already a SKIP decided above
        if (resolved.has(t.idx)) t.verdict = 'SKIP already-resolved (you voted on it before)';
        else if (t.needsHuman <= 0) t.verdict = 'SKIP needsHuman=0 (uncertain but low value to ask)';
        else if (pickedSet.has(t.idx)) t.verdict = proposals.has(t.idx)
            ? 'CARDED-PROPOSED (unlinked line — asks you to confirm the best candidate)'
            : 'CARDED (uncertain match — asks you to confirm / reject)';
        else t.verdict = 'SKIP over card limit (deprioritized this session)';
    }

    console.log(
        `=== RECEIPT ${receiptId} CARDING (chain ${Number.isFinite(chainId) ? chainId : '—'}, limit ${limit}) ===\n` +
        trail.map((t) =>
            `  L${t.idx} ${JSON.stringify(t.ocr)} → ${t.sp ? `SP ${t.sp}${t.name ? ` ${JSON.stringify(t.name)}` : ''}` : 'no SP'}` +
            ` | band=${t.band} score=${t.score != null ? t.score.toFixed(2) : '—'} needsHuman=${t.needsHuman.toFixed(2)}\n       → ${t.verdict}`,
        ).join('\n') +
        `\n  => carded ${picked.length}, skipped ${trail.length - picked.length}, eligible ${seqLines.length}`,
    );

    const cards: ReceiptResolveCard[] = picked.map((l) => {
        const line = products[l.lineIdx];
        const reg = line?.region;
        const region: ReceiptBandRegion | null =
            reg && Number.isFinite(Number(reg.yTop)) && Number.isFinite(Number(reg.yBottom))
                ? (reg as ReceiptBandRegion)
                : null;
        const proposal = proposals.get(l.lineIdx);
        return {
            cardKind: 'receipt' as const,
            cardId: `rcpt:${receiptId}:${l.lineIdx}`,
            receiptLineIdx: l.lineIdx,
            ocr: {
                name: typeof line.name === 'string' ? line.name : '',
                cropUrl: `/api/receipts/${receiptId}/lines/${l.lineIdx}/crop`,
            },
            region,
            matched: proposal
                ? { spId: proposal.spId, name: proposal.name, imageUrl: proposal.imageUrl }
                : {
                    spId: Number(line.storeProductId),
                    name: line.matchedName ?? null,
                    imageUrl: line.storeProductImageUrl ?? null,
                },
            needsHuman: Number(line.needsHuman) || 0,
            ...(proposal ? { proposed: true } : {}),
            // Cross-chain rescue card: the client shows the source chain's badge so the
            // user knowingly confirms "same product as this <chain> item".
            ...(proposal?.sourceChainId != null ? { sourceChainId: proposal.sourceChainId } : {}),
        };
    });
    return { cards, image };
}

/**
 * Terminal ask-once write for a completed MANDATORY session: every Card-B line
 * still SERVABLE (offered but not yet resolved by a vote) is recorded 'asked',
 * so future sessions don't re-nag it. Called from POST /complete-swipes — NOT
 * from the resolve-queue GET, which must stay a pure idempotent read (else a
 * benign re-fetch would mark the cards asked and the second fetch would return
 * an empty queue, the "cards not showing up" bug). Returns how many were marked.
 */
export async function markServedResolveLinesAsked(receiptId: number, conn: Db): Promise<number> {
    const { cards } = await buildReceiptResolveCards(receiptId, conn);
    for (const c of cards) {
        await markLineAsked(receiptId, c.receiptLineIdx, conn);
    }
    return cards.length;
}
