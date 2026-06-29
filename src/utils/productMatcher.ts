/**
 * Product name matching for OCR'd grocery receipt entries.
 *
 * Two scoring lanes combined:
 *   - tokenScore: per-token best-match with Levenshtein + length weighting.
 *     Good when OCR preserves word boundaries.
 *   - charScore: Levenshtein similarity on the joined normalized string.
 *     Rescues cases where OCR split a word across spaces (`gėr imas` for
 *     `gėrimas`) or lost/swapped a single letter — the full-string view
 *     sees most characters are still there even though the token view
 *     sees unmatched fragments.
 *
 * Final confidence = max(tokenScore, charScore * 0.95). Char is slightly
 * discounted so clean token matches still beat noisy-but-similar blobs
 * of the wrong product.
 *
 * Normalization additionally strips common receipt prefixes the parsers
 * may leak (loyalty card X's, `nuol.` / `galut. kaina` / "sutaupete" /
 * deposit markers) — defensive so matcher works even when a parser bug
 * slips a prefix through.
 */

import { levenshtein } from './addressMatcher.js';
import { extractPackSize } from '../../../shared/parsers/rimiParser.js';
import { sharesRequiredAnchor } from './nameMatchGate.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

/**
 * Strip OCR prefixes that hold no product signal but often leak through
 * parsers. Applied inside normalize so token splitting doesn't latch
 * onto the junk.
 *
 * Tokens stripped:
 *   - Loyalty card masks (`xxxxxxxxxxxxxxx9631` — Mano Rimi tail)
 *   - `nuol. -1,20` / `galut. kaina 2,27` discount markers (Rimi)
 *   - `sutaupete` and `aciu nuolaida prekei` (Maxima)
 *   - `pet (depozitinis) 0,10 eur 0,10` deposit lines (both chains)
 */
function stripReceiptPrefixes(s: string): string {
    return s
        // Loyalty-card masks — accept K/X prefix series (OCR reads first
        // X as K) with 4+ mask chars, optionally followed by some digits.
        .replace(/\b[kx][kx]{3,}\s*\d{0,8}(?:\s+\d)?/gi, ' ')
        .replace(/\bnuol\.?\s*-?\s*\d+[.,]\d+\b/gi, ' ')
        .replace(/\bgalut\s*\.?\s*kaina\s*\d+[.,]\d+\b/gi, ' ')
        .replace(/\bsutaupete\b\s*:?/gi, ' ')
        .replace(/\baciu\s+nuo\s*la\s*ida\s+prekei\s*:?/gi, ' ')
        .replace(/\b(pet|skardine)\s*\(depozitin[ei]s?\)\s*\d+[.,]\d+\s*eur?\s*\d+[.,]\d+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeProductName(name: string): string {
    if (!name) return '';
    // Strip receipt-specific noise on the raw string FIRST so the patterns
    // can match the original dots, commas and parentheses they depend on.
    // Normalization (dot→space, paren removal) would neutralise them otherwise.
    const stripped = stripReceiptPrefixes(name);
    return stripped
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[.,/]/g, ' ')
        .replace(/[^a-z0-9+\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(normalizedName: string): string[] {
    return normalizedName.split(' ').filter(t => t.length > 0);
}

function bestTokenMatch(queryToken: string, candidateTokens: string[]): number {
    let best = 0;
    for (const cand of candidateTokens) {
        if (queryToken === cand) return 1;
        if (queryToken.length <= 3 || cand.length <= 3) continue;
        const distance = levenshtein(queryToken, cand);
        const maxLen = Math.max(queryToken.length, cand.length);
        const score = 1 - distance / maxLen;
        if (score > best) best = score;
    }
    return best;
}

/**
 * Levenshtein similarity on whole normalized strings with inner
 * whitespace removed. Catches split-word OCR where the tokenizer sees
 * unusable 3-char fragments but character-wise the texts are nearly
 * identical. Returns [0, 1].
 *
 * Early-bail on big length differences to keep the matcher fast when
 * the caller ranks thousands of chain candidates per query.
 */
function charSimilarity(a: string, b: string): number {
    const aCompact = a.replace(/\s+/g, '');
    const bCompact = b.replace(/\s+/g, '');
    const maxLen = Math.max(aCompact.length, bCompact.length);
    if (maxLen === 0) return 0;
    const minLen = Math.min(aCompact.length, bCompact.length);
    if (minLen / maxLen < 0.4) return 0;
    const dist = levenshtein(aCompact, bCompact);
    return 1 - dist / maxLen;
}

export interface MatchCandidate {
    id: number;
    productId: number;
    categoryId: number;
    /** Category.name joined in by storeProductModel queries — used by
     *  mobile C3 (category-spending breakdown) so it doesn't have to
     *  carry a mirror of the server taxonomy. */
    categoryName: string | null;
    /** L2 ancestor (mid-level) name. Single source of truth for the
     *  receipt breakdown so it matches Profilis (statsService uses the
     *  same CASE). NULL when the product is filed directly at L1. */
    categoryL2Name: string | null;
    storeProductName: string;
    brandName: string | null;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    /** True = a real scraped catalog SKU (has a receiptId-NULL price); false/undefined
     *  = a receipt-minted orphan. Used as a near-tie ranking preference. */
    isCatalog?: boolean;
}

export interface ProductMatch {
    storeProductId: number;
    productId: number;
    categoryId: number;
    categoryName: string | null;
    categoryL2Name: string | null;
    name: string;
    brandName: string | null;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    confidence: number;
    isCatalog?: boolean;
}

function sameUnit(a: string | null, b: string | null): boolean {
    if (!a || !b) return false;
    return a.toLowerCase().replace(/\./g, '') === b.toLowerCase().replace(/\./g, '');
}

const normUnit = (unit: string | null): string | null =>
    unit ? unit.toLowerCase().replace(/\./g, '').trim() : null;

// A FIXED form = a concrete, sized/counted package a by-weight line must NOT match:
// a sealed pack (g/ml), a per-ITEM count (vnt/rit), a LIQUID (l — nothing is sold by
// weight in litres), or a multi-unit weight BAG (kg with amount ≥ 2). The only
// weight-compatible "packaged" rows are kg @ amount 1/null and unsized (no unit, e.g.
// pre-packed-by-weight produce like "Fasuoti obuoliai").
export function hasFixedPackForm(amount: number | null, unit: string | null): boolean {
    const u = normUnit(unit);
    if (u === 'kg') return !(amount === null || amount === 1); // kg @2+ is a fixed bag
    return !!u; // g/ml/l/vnt/rit/etc → fixed; null unit → not fixed
}

// The weighable self-heal only flips a "1 kg" produce row wrongly flagged
// isWeighable=false: kg @ amount 1/null ONLY — never a litre (no liquid is weighable),
// never a per-item count, never a sized bag.
export function isMislabeledWeighableKg(amount: number | null, unit: string | null): boolean {
    return normUnit(unit) === 'kg' && (amount === null || amount === 1);
}

// Distinguishing-noun disagreement penalty. Generic brand/packaging words
// ("Fasuoti", "IKI", "ŪKIS") match across very different products, so a candidate
// can clear token coverage on those alone while the DISTINGUISHING noun disagrees
// ("obuoliai"/apples vs "bulvės"/potatoes → matched potatoes at 0.51). For each
// SIGNIFICANT (long) query token with no good per-token counterpart among the
// candidate's long tokens, levy a penalty. Caller applies it to the TOKEN lane
// only, so the whole-string char-rescue (OCR split-word) lane stays intact.
function distinguishingPenalty(queryTokens: string[], candidateTokens: string[]): number {
    const candLong = candidateTokens.filter((t) => t.length > RECOGNITION.match.shortTokenThreshold);
    if (candLong.length === 0) return 0;
    let unmatched = 0;
    for (const qt of queryTokens) {
        if (qt.length <= RECOGNITION.match.shortTokenThreshold) continue; // only long tokens distinguish
        if (bestTokenMatch(qt, candLong) < RECOGNITION.match.nounSimFloor) unmatched++;
    }
    return Math.min(RECOGNITION.match.nounDisagreementCap, unmatched * RECOGNITION.match.nounDisagreementPenalty);
}

function scoreTokens(queryTokens: string[], candidateTokens: string[]): number {
    if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

    const tokenMatchThreshold = 0.75;  // tightened from 0.7
    let weightedScoreSum = 0;
    let weightSum = 0;
    let matchedTokens = 0;

    for (const qt of queryTokens) {
        const weight = qt.length;
        const match = bestTokenMatch(qt, candidateTokens);
        const effective = match >= tokenMatchThreshold ? match : 0;
        weightedScoreSum += effective * weight;
        weightSum += weight;
        if (effective > 0) matchedTokens++;
    }

    // Require at least half of query tokens to have matched. Use only
    // long-token count as the denominator — short tokens (≤3 chars, e.g.
    // "2", "5", "%" fragments) can only pass via exact-match and should
    // not inflate the denominator and penalise legitimate matches.
    // Example: "Kefyras 2,5 %" (long tokens: ["kefyras"]) should match
    // "Kefyras" even though "2"/"5" can't contribute.
    // Fall back to full token count when there are no long tokens at all
    // (purely numeric/short queries like "3 A").
    const queryLongCount = queryTokens.filter(t => t.length > 3).length;
    const effectiveDenom = queryLongCount > 0 ? queryLongCount : queryTokens.length;
    // For queries with ≥ 3 long tokens, require 67% coverage (effectively
    // 2 of 3 must match). This prevents a shared 2-word prefix like
    // "karštai rūkytos" from creating false positives between different
    // smoked products where the 3rd distinguishing token doesn't match.
    const coverageThreshold = queryLongCount >= 3 ? 0.67 : 0.5;
    if (matchedTokens / effectiveDenom < coverageThreshold) return 0;

    // Candidate long-token coverage guard. Fires when the candidate has
    // more long tokens than the query (candLong >= queryLong+1). At least
    // 40% of candidate long tokens must be covered by the query.
    // Catches false positives from shared-prefix matches — e.g.:
    //   "sviestas" (1 long) vs "Livarno stalinis Led sviestuvas" (3 long):
    //     1/3 = 33% < 40% → rejected.
    //   "Apelsinai 4/5dyd." (2 long) vs "Apelsinų nekt. ELMENHORSTER" (3 long):
    //     1/3 = 33% < 40% → rejected.
    //   "Bananai" (1 long) vs "Bananai Chiquita" (2 long):
    //     1/2 = 50% ≥ 40% → passes. Short receipt names match slightly-longer SPs.
    const candLongTokens = candidateTokens.filter(t => t.length > 3);
    if (candLongTokens.length >= queryLongCount + 1) {
        const candMatchedCount = candLongTokens.filter(
            ct => bestTokenMatch(ct, queryTokens) >= tokenMatchThreshold
        ).length;
        if (candMatchedCount / candLongTokens.length < 0.4) return 0;
    }

    return weightSum > 0 ? weightedScoreSum / weightSum : 0;
}

export function findBestProductMatches(
    ocrName: string,
    ocrAmount: number | null,
    ocrUnit: string | null,
    candidates: MatchCandidate[],
    minConfidence: number = RECOGNITION.match.minConfidence,
    topN: number = RECOGNITION.match.topN,
    // When set (not null), a HARD weighable gate: a by-WEIGHT receipt line
    // (sold per kg, no fixed pack) may only match weighable SPs, and a PACKAGED
    // line only fixed-pack SPs. Prevents a loose paprikos (0,47 kg) collapsing
    // onto a packaged "Raudonosios paprikos BON VIA" (180 g) — different product
    // forms the name matcher can't tell apart. Null = no gate (legacy callers).
    ocrIsWeighable: boolean | null = null,
): ProductMatch[] {
    const normalizedQuery = normalizeProductName(ocrName);
    const queryTokens = tokenize(normalizedQuery);
    if (queryTokens.length === 0) return [];

    const scored: Array<{ cand: MatchCandidate; confidence: number }> = [];

    for (const cand of candidates) {
        // Effective pack size: catalog columns, else a size parsed from the NAME
        // (many SPs carry size in the name but null amount/unit columns). Computed
        // up here so the weighable gate below can use it too.
        let candAmount = cand.amount;
        let candUnit = cand.unit;
        if ((candAmount === null || !candUnit) && cand.storeProductName) {
            const extracted = extractPackSize(cand.storeProductName);
            if (extracted.amount !== null && extracted.unit) {
                candAmount = candAmount ?? extracted.amount;
                candUnit = candUnit ?? extracted.unit;
            }
        }

        // Weighable (cross-form) gate. A by-weight line and a "packaged" SP are
        // normally different FORMS — EXCEPT when the packaged side has NO FIXED form:
        // pre-packed-by-weight produce ("Fasuoti obuoliai IKI ŪKIS", isWeighable=0 but
        // sold per kg, no size) and bulk-weight (kg/l) rows ARE weight-compatible and
        // must match. A real FIXED form stays excluded — a sealed package ("180 g") OR
        // a PER-ITEM count ("1 vnt", e.g. Raudonosios paprikos BON VIA sold per item) —
        // so loose 0,47 kg paprikos never collapses onto a per-item or 180 g pack.
        if (ocrIsWeighable !== null && cand.isWeighable !== ocrIsWeighable) {
            const packagedHasFixedForm =
                cand.isWeighable === false
                    ? hasFixedPackForm(candAmount, candUnit)
                    : hasFixedPackForm(ocrAmount, ocrUnit);
            if (packagedHasFixedForm) continue;
        }

        const normalizedCand = normalizeProductName(cand.storeProductName);
        const candTokens = tokenize(normalizedCand);
        if (candTokens.length === 0) continue;

        // Anchor-token gate: a query with a single significant word may only
        // match a candidate that contains that word EXACTLY. The exception is
        // when the two strings are near-identical character-wise — that's the
        // OCR split-word case (e.g. "gėr imas" → "gėrimas") which the charScore
        // lane below is meant to rescue. Without this, "Airanas" fuzzy-matched
        // "Šafranas KOTANYI" at 0.75 and got clustered into the saffron Product.
        if (!sharesRequiredAnchor(normalizedQuery, normalizedCand)
            && charSimilarity(normalizedQuery, normalizedCand) < 0.85) {
            continue;
        }

        let tokenScore = scoreTokens(queryTokens, candTokens);
        // Dock the TOKEN score when a distinguishing query noun has no counterpart
        // (apples vs potatoes share only "Fasuoti/IKI/ŪKIS"). Token lane only — the
        // char lane below still rescues genuine OCR split-word variants.
        if (tokenScore > 0) tokenScore = Math.max(0, tokenScore - distinguishingPenalty(queryTokens, candTokens));
        // Always compute char-similarity — cheap early-bail inside
        // handles the 99% of candidates that aren't close in length.
        const charScore = charSimilarity(normalizedQuery, normalizedCand);
        // charScore is a rescue for OCR-split tokens (e.g. "ger imas" →
        // "gerimas"). Only apply it when charScore ≥ 0.6 so incidental
        // substring overlap between unrelated Lithuanian words (e.g.
        // "bananai"/"mandarinai" share "-anai", charScore≈0.5) doesn't
        // produce false positives. The 0.6 floor corresponds to Levenshtein
        // distance ≤ 40% of the longer string — genuinely similar texts.
        const charContribution = charScore >= 0.6 ? charScore * 0.95 : 0;
        let confidence = Math.max(tokenScore, charContribution);

        // candAmount/candUnit were computed above (before the weighable gate) — the
        // name-extraction fallback covers ZEWA-class SPs whose size lives only in the
        // name (amount=null columns) so the size-mismatch penalty still fires.
        if (ocrAmount !== null && ocrUnit && candAmount !== null && candUnit) {
            const amountMatches = Math.abs(ocrAmount - candAmount) < RECOGNITION.match.amountTolerance;
            const unitMatches = sameUnit(ocrUnit, candUnit);
            if (amountMatches && unitMatches) {
                confidence = Math.min(1, confidence + RECOGNITION.match.amountBonus);
            } else if (unitMatches && !amountMatches) {
                // Same unit, different pack size — strong negative signal.
                // Multiple same-named pack variants (e.g. ZEWA EVERYDAY
                // 12/16/24/32 rit.) are the case this catches: name
                // similarity is identical so without a real penalty the
                // matcher picks the first variant at confidence 1.0.
                // Scale by relative size error so a near-match (32 vs 30)
                // hurts less than a wild miss (32 vs 12).
                const relErr = Math.abs(ocrAmount - candAmount) / Math.max(ocrAmount, candAmount, 1);
                const penalty = Math.min(RECOGNITION.match.sizePenaltyCap, RECOGNITION.match.sizePenaltyBase + RECOGNITION.match.sizePenaltyScale * relErr);
                confidence = Math.max(0, confidence - penalty);
            } else if (!unitMatches) {
                // Different unit family — usually a different product.
                confidence = Math.max(0, confidence - RECOGNITION.match.unitFamilyPenalty);
            }
        }

        if (confidence >= minConfidence) {
            scored.push({ cand, confidence });
        }
    }

    // CATALOG-FIRST tiebreak: when a real scraped catalog SKU and a receipt-minted
    // ORPHAN score within `catalogPreferenceMargin` of each other, prefer the catalog
    // one — even if the orphan scored marginally higher (its garbled OCR name lexically
    // hugs the equally-garbled query). Outside the margin, pure confidence wins. (User:
    // "match catalog first." Today only the exact-name dedup preferred catalog.)
    const margin = RECOGNITION.match.catalogPreferenceMargin;
    scored.sort((a, b) => {
        const dc = b.confidence - a.confidence;
        if (Math.abs(dc) <= margin && !!a.cand.isCatalog !== !!b.cand.isCatalog) {
            return a.cand.isCatalog ? -1 : 1; // catalog first
        }
        return dc;
    });

    return scored.slice(0, topN).map(({ cand, confidence }) => ({
        storeProductId: cand.id,
        productId: cand.productId,
        categoryId: cand.categoryId,
        categoryName: cand.categoryName,
        categoryL2Name: cand.categoryL2Name,
        name: cand.storeProductName,
        brandName: cand.brandName,
        amount: cand.amount,
        unit: cand.unit,
        isWeighable: cand.isWeighable,
        imageUrl: cand.imageUrl,
        confidence: Math.round(confidence * 100) / 100,
        isCatalog: cand.isCatalog,
    }));
}
