import { RECOGNITION, confidenceBand, type ItemConfidence } from '../../../shared/recognitionConfig.js';

export type { ItemConfidence };

/**
 * Unified per-receipt-LINE confidence score (souply-api).
 *
 * One number in [0,1] + a full breakdown, computed AFTER Round-2 and the line
 * resolver (where every signal exists). It answers "how sure are we this line is
 * the correct store product?" and drives the Items-tab display band (DISPLAY-ONLY
 * — it does not change which SP gets linked; the name≥autoApply gate still does).
 *
 * Combine order honours the VETO-CAPS-NAME rule (the slyvos / saffran lesson):
 *   base(name × ocr) + Σ confirmers, THEN min(score, lowest veto cap),
 *   THEN overrides (created-OCR-only can't exceed band S2).
 *
 * All caps/weights live in RECOGNITION.confidence and are TUNABLE DEFAULTS to be
 * calibrated against real receipts — never re-inline them here.
 *
 * NOTE on availability: ocrReliability is derived from the line NAME's alnum ratio
 * (the OCR's own dedup/tiled metadata is app-side and not threaded to the server).
 * The amount/unit-agreement + parse-validity confirmers, the cross-chain &
 * clearance-skip vetoes, and the user-confirmed override need signals not yet
 * surfaced here (matcher lane provenance / per-line crossChain flag / a confirm
 * action) — they're left out of v1 and noted as follow-ups, not silently faked.
 */
export interface ItemConfidenceInput {
    /** Round-1 name confidence of the chosen candidate (line.matchConfidence). */
    nameConf: number | null;
    /** The OCR product name text (for the OCR-reliability term). */
    nameText: string;
    /** Round-2 confirmed this line's price (regular or active promo). */
    priceVerified: boolean;
    /** The confirm came via promo only (weaker than a regular-price confirm). */
    viaPromo: boolean;
    /** Top-candidate confidence minus runner-up (0 when <2 candidates). */
    gapToRunnerUp: number;
    /** Resolver outcome for this line. */
    source: 'reused' | 'created' | 'bootstrapped' | 'skipped_unpriced' | 'unmatched' | 'none';
    /** Round-2 flagged the regular price implausible (catalog-poison guard). */
    priceImplausible: boolean;
    /** The user swiped 'different' on this line's match (personal 1-vote split). */
    userRejected?: boolean;
    /** The user swiped identical/similar — confirmed the product is right (→ S1). */
    userConfirmed?: boolean;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
// Letters (incl. Lithuanian) + digits — a garbled OCR name ("AY4 813Ml1") has a
// low ratio of these to its length, signalling we should trust the name less.
const ALNUM_RE = /[a-z0-9ąčęėįšųūž]/gi;

export function computeItemConfidence(input: ItemConfidenceInput): ItemConfidence {
    const C = RECOGNITION.confidence;
    const nameConf = clamp01(input.nameConf ?? 0);

    // OCR reliability from the name's alnum ratio (server-derivable slice of the
    // fuller app-side formula). dedup/tiled penalties omitted — not available here.
    const len = input.nameText ? input.nameText.length : 0;
    const alnumRatio = len ? (input.nameText.match(ALNUM_RE) || []).length / len : 0;
    const ocrReliability = clamp01(C.ocrReliability.start + C.ocrReliability.slope * alnumRatio);

    // base — OCR quality MODULATES name identity, never dominates it.
    const base = nameConf * (C.baseOcrFloor + (1 - C.baseOcrFloor) * ocrReliability);

    // confirmers — each only ADDS.
    const confirmers: Record<string, number> = {};
    if (input.priceVerified) confirmers.priceVerified = C.confirmers.priceVerified;
    if (input.viaPromo) confirmers.viaPromo = C.confirmers.viaPromo;
    if (input.gapToRunnerUp > 0) {
        confirmers.gap = C.confirmers.gapMax * Math.min(1, input.gapToRunnerUp / C.confirmers.gapNorm);
    }
    if (input.source === 'reused') confirmers.reuse = C.confirmers.reuse;
    let score = clamp01(base + Object.values(confirmers).reduce((a, b) => a + b, 0));

    // vetoes — multiplicative CAPS; the LOWEST wins (a strong name can't rescue).
    const vetoes: { reason: string; cap: number }[] = [];
    if (input.priceImplausible) vetoes.push({ reason: 'priceImplausible', cap: C.vetoCaps.priceImplausible });
    if (input.source === 'bootstrapped' && !input.priceVerified) {
        vetoes.push({ reason: 'bootstrappedUnverified', cap: C.vetoCaps.bootstrappedUnverified });
    }
    if (input.source === 'skipped_unpriced') {
        vetoes.push({ reason: 'skippedUnpriced', cap: C.vetoCaps.skippedUnpriced });
    }
    // A user-rejected line (swiped 'different') can never read as a confirmed match —
    // a single personal vote is authoritative (the 1-vote split rule).
    if (input.userRejected) vetoes.push({ reason: 'userRejected', cap: C.vetoCaps.userRejected });
    if (vetoes.length) score = Math.min(score, Math.min(...vetoes.map((v) => v.cap)));

    // override — a fresh OCR-only SP (no priced evidence) may not reach band S1.
    let override: ItemConfidence['override'] = null;
    if (input.source === 'created') {
        const justBelowS1 = RECOGNITION.display.bandS1 - 0.001;
        if (score > justBelowS1) {
            score = justBelowS1;
            override = 'created_ocr_only';
        }
    }

    // The user explicitly confirmed this is the right product (swiped identical /
    // similar) — the strongest signal there is. It wins over every veto and the
    // created cap: a confirmed line is S1. (Mutually exclusive with userRejected.)
    if (input.userConfirmed) {
        score = 1;
        override = 'user_confirmed';
    }

    score = round3(score);
    return {
        score,
        band: confidenceBand(score),
        base: round3(base),
        nameConf: round3(nameConf),
        ocrReliability: round3(ocrReliability),
        confirmers,
        vetoes,
        override,
    };
}
