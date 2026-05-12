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
    storeProductName: string;
    brandName: string | null;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
}

export interface ProductMatch {
    storeProductId: number;
    productId: number;
    categoryId: number;
    name: string;
    brandName: string | null;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    confidence: number;
}

function sameUnit(a: string | null, b: string | null): boolean {
    if (!a || !b) return false;
    return a.toLowerCase().replace(/\./g, '') === b.toLowerCase().replace(/\./g, '');
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
    minConfidence: number = 0.4,
    topN: number = 3
): ProductMatch[] {
    const normalizedQuery = normalizeProductName(ocrName);
    const queryTokens = tokenize(normalizedQuery);
    if (queryTokens.length === 0) return [];

    const scored: Array<{ cand: MatchCandidate; confidence: number }> = [];

    for (const cand of candidates) {
        const normalizedCand = normalizeProductName(cand.storeProductName);
        const candTokens = tokenize(normalizedCand);
        if (candTokens.length === 0) continue;

        const tokenScore = scoreTokens(queryTokens, candTokens);
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

        if (ocrAmount !== null && ocrUnit && cand.amount !== null && cand.unit) {
            const amountMatches = Math.abs(ocrAmount - cand.amount) < 0.01;
            const unitMatches = sameUnit(ocrUnit, cand.unit);
            if (amountMatches && unitMatches) {
                confidence = Math.min(1, confidence + 0.15);
            } else if (!amountMatches || !unitMatches) {
                confidence = Math.max(0, confidence - 0.2);
            }
        }

        if (confidence >= minConfidence) {
            scored.push({ cand, confidence });
        }
    }

    scored.sort((a, b) => b.confidence - a.confidence);

    return scored.slice(0, topN).map(({ cand, confidence }) => ({
        storeProductId: cand.id,
        productId: cand.productId,
        categoryId: cand.categoryId,
        name: cand.storeProductName,
        brandName: cand.brandName,
        amount: cand.amount,
        unit: cand.unit,
        isWeighable: cand.isWeighable,
        imageUrl: cand.imageUrl,
        confidence: Math.round(confidence * 100) / 100,
    }));
}
