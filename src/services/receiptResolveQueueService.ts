import { type SeqLine } from './mandatoryQueueBuilder.js';
import { getResolvedLineIdxSet, markLineAsked } from '../models/receiptLineResolutionModel.js';
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
    const products = parsed?.products;
    if (!Array.isArray(products)) return { cards: [], image: null };

    // parsed.image dims (OCR portrait space) — the app re-projects the stored photo
    // into this space so the per-line region corners line up 1:1 with the crop.
    const imgW = Number(parsed?.image?.width);
    const imgH = Number(parsed?.image?.height);
    const image: ReceiptImageDims | null =
        Number.isFinite(imgW) && Number.isFinite(imgH) && imgW > 0 && imgH > 0
            ? { width: imgW, height: imgH }
            : null;

    const seqLines: SeqLine[] = [];
    const skips: string[] = []; // per-line skip reasons, for the diagnostic summary below
    for (let i = 0; i < products.length; i++) {
        const line = products[i];
        const sp = Number(line?.storeProductId);
        const band = line?.itemConfidence?.band;
        if (!Number.isFinite(sp) || sp <= 0) { skips.push(`#${i + 1} no-match`); continue; } // nothing to confirm
        // Card B compares against a MATCHED product — an orphan line (no matchedName,
        // a freshly-created SP) has nothing to show on the match side, so skip it here;
        // it belongs to orphan-rescue, not "is this right?".
        if (typeof line.matchedName !== 'string' || !line.matchedName.trim()) { skips.push(`#${i + 1} orphan-no-matchedName`); continue; }
        if (band !== 'S2' && band !== 'S3') { skips.push(`#${i + 1} band-confident(${band ?? '—'})`); continue; }
        const qty = Number.isFinite(line.quantity) ? Number(line.quantity) : 1;
        const unitPrice = line.promoPrice != null && line.promoPrice < line.price ? Number(line.promoPrice) : Number(line.price);
        const lineTotalEur = Number.isFinite(unitPrice) ? Math.max(0, unitPrice) * (qty > 0 ? qty : 1) : 0;
        seqLines.push({ lineIdx: i, band, needsHuman: Number(line.needsHuman) || 0, lineTotalEur });
    }

    const resolved = await getResolvedLineIdxSet(receiptId, conn);
    const picked = seqLines
        .filter((l) => l.needsHuman > 0 && !resolved.has(l.lineIdx)) // band already gated in seqLines build
        .sort((a, b) => b.needsHuman - a.needsHuman)
        .slice(0, Math.max(0, limit));

    console.log(
        `=== RECEIPT ${receiptId} RESOLVE-CARDS: ${picked.length} carded / ${seqLines.length} eligible / ${skips.length} skipped (limit ${limit}) ===` +
        `\n  carded: ${picked.map((l) => `#${l.lineIdx + 1}(nh ${l.needsHuman.toFixed(2)} ${l.band})`).join(', ') || 'none'}` +
        `\n  skipped: ${skips.join(', ') || 'none'}` +
        `\n  resolved-already: ${[...resolved].map((x) => `#${x + 1}`).join(', ') || 'none'}`,
    );

    const cards: ReceiptResolveCard[] = picked.map((l) => {
        const line = products[l.lineIdx];
        const reg = line?.region;
        const region: ReceiptBandRegion | null =
            reg && Number.isFinite(Number(reg.yTop)) && Number.isFinite(Number(reg.yBottom))
                ? (reg as ReceiptBandRegion)
                : null;
        return {
            cardKind: 'receipt' as const,
            cardId: `rcpt:${receiptId}:${l.lineIdx}`,
            receiptLineIdx: l.lineIdx,
            ocr: {
                name: typeof line.name === 'string' ? line.name : '',
                cropUrl: `/api/receipts/${receiptId}/lines/${l.lineIdx}/crop`,
            },
            region,
            matched: {
                spId: Number(line.storeProductId),
                name: line.matchedName ?? null,
                imageUrl: line.storeProductImageUrl ?? null,
            },
            needsHuman: Number(line.needsHuman) || 0,
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
