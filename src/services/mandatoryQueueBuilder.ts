import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { isCardEligible } from './queueRanking.js';

/**
 * Pure builder for the MANDATORY post-scan swipe sequence (see
 * shared/SWIPE_QUEUE_REDESIGN.md). Extracted from the controller so the
 * "at most 3, one shot per item, your-items-first" rules are unit-testable
 * without a DB.
 *
 * Composition (Decisions 2, 6, 7):
 *   1. up to `mandatoryReceiptMax` (2) Card-B "is this right?" cards — the
 *      highest needs-human UNCERTAIN (S2/S3) lines not already asked/resolved.
 *   2. up to `mandatoryCrossStore` (1) cross-store identity card — the
 *      MOST-EXPENSIVE eligible line that has a viable cross-chain anchor.
 *   3. top up toward `mandatoryMaxCards` (3) with more cross-store cards.
 *      (Orphan / related-global top-up is added in Phase 3.)
 * Dedup is per receipt line — a line is carded at most once (its Card-B wins
 * over its cross-store card; if it's wrong, the cross-store question is moot).
 */
export interface SeqLine {
    lineIdx: number;
    band: 'S1' | 'S2' | 'S3';
    needsHuman: number;
    lineTotalEur: number;
}

export type MandatoryCard =
    | { kind: 'receipt'; lineIdx: number }
    | { kind: 'crossStore'; lineIdx: number };

export function buildMandatorySequence(
    lines: SeqLine[],
    resolved: Set<number>,
    /** Line indices that have a viable cross-chain anchor (supplied by the controller from slot1). */
    crossStoreLineIdxs: number[],
): MandatoryCard[] {
    const Q = RECOGNITION.queue;
    const byIdx = new Map<number, SeqLine>(lines.map((l) => [l.lineIdx, l]));
    const used = new Set<number>(); // line indices already carded (dedup)
    const out: MandatoryCard[] = [];

    // 1. Card-B: uncertain, un-asked lines by needs-human desc.
    const receiptCandidates = lines
        .filter((l) => isCardEligible(l.band) && l.needsHuman > 0 && !resolved.has(l.lineIdx))
        .sort((a, b) => b.needsHuman - a.needsHuman);
    for (const l of receiptCandidates) {
        if (out.length >= Q.mandatoryMaxCards || used.size >= Q.mandatoryReceiptMax) break;
        out.push({ kind: 'receipt', lineIdx: l.lineIdx });
        used.add(l.lineIdx);
    }

    // 2 + 3. Cross-store: most-expensive first, skipping lines already carded /
    //        asked, filling the designated slot then topping up toward the cap.
    const crossCandidates = crossStoreLineIdxs
        .filter((idx) => !used.has(idx) && !resolved.has(idx))
        .sort((a, b) => (byIdx.get(b)?.lineTotalEur ?? 0) - (byIdx.get(a)?.lineTotalEur ?? 0));
    for (const idx of crossCandidates) {
        if (out.length >= Q.mandatoryMaxCards) break;
        out.push({ kind: 'crossStore', lineIdx: idx });
        used.add(idx);
    }

    return out.slice(0, Q.mandatoryMaxCards);
}
