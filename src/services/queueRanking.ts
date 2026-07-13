import { RECOGNITION } from '../../../shared/recognitionConfig.js';

/**
 * needs-human ranking (souply-api). One score per receipt LINE answering "how much
 * would a human's answer help here?" = ambiguity × price-impact. The swipe queue
 * surfaces the few highest-scoring UNCERTAIN (S2/S3) lines as cards; the rest are
 * resolved by system actions. See shared/SWIPE_QUEUE_REDESIGN.md.
 *
 *   ambiguity   = bandWeight[band] + gapBonus(close call) + vetoBonus(suspect match)
 *                 × loneCreatedDamp (a lone never-seen product has nothing to choose)
 *   priceImpact = clamp01(lineTotal / norm), floored so cheap items still count a bit
 *   needsHuman  = ambiguity × (priceFloor + (1−priceFloor) × priceImpact)
 *
 * All weights live in RECOGNITION.queue.needsHuman — tunable defaults, never re-inlined.
 */
export interface NeedsHumanInput {
    /** Display band of the line's match (S1 is confident → never carded). */
    band: 'S1' | 'S2' | 'S3';
    /** Top-candidate confidence minus runner-up (0 when < 2 candidates). */
    gapToRunnerUp: number;
    /** Number of altMatch candidates the matcher returned. */
    candidateCount: number;
    /** Any confidence veto present on the line (price-implausible, cross-chain, …). */
    hasVeto: boolean;
    /** Resolver outcome for this line. */
    source: 'reused' | 'created' | 'bootstrapped' | 'skipped_unpriced' | 'unmatched' | 'none';
    /** Total € paid for the line (price × qty, promo if lower) — the price-impact driver. */
    lineTotalEur: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function computeNeedsHuman(input: NeedsHumanInput): number {
    const Q = RECOGNITION.queue.needsHuman;
    const base = Q.bandWeight[input.band] ?? 0;
    if (base <= 0) return 0; // S1 (or unknown) — confident, never carded

    const gapBonus =
        input.candidateCount >= 2 && input.gapToRunnerUp >= 0
            ? Q.gapBonusMax * (1 - Math.min(1, input.gapToRunnerUp / Q.gapNorm))
            : 0;
    const vetoBonus = input.hasVeto ? Q.vetoBonus : 0;

    let ambiguity = base + gapBonus + vetoBonus;
    // A LONE freshly-created product has no real alternative to disambiguate — a card
    // can't do much, so it's lower-priority than a genuine multi-candidate close call.
    if (input.source === 'created' && input.candidateCount < 2) ambiguity *= Q.loneCreatedDamp;
    ambiguity = clamp01(ambiguity);

    const priceImpact = clamp01((Number.isFinite(input.lineTotalEur) ? input.lineTotalEur : 0) / Q.priceImpactNormEur);
    const priceFactor = Q.priceFloor + (1 - Q.priceFloor) * priceImpact;

    return round3(ambiguity * priceFactor);
}

/** Whether a line is uncertain enough to be eligible for a card at all. */
export function isCardEligible(band: 'S1' | 'S2' | 'S3'): boolean {
    return RECOGNITION.queue.surfaceBands.includes(band);
}
