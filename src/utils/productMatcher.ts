/**
 * Product name matching for OCR'd grocery receipt entries.
 *
 * Strategy: token-based fuzzy matching.
 *   - Tokenize both query and candidate (split on whitespace after normalization)
 *   - For each query token, find the best-matching candidate token (Levenshtein)
 *   - Score = weighted fraction of query tokens with a good match (weight = token length)
 *   - Amount/unit as a soft boost/penalty
 */

import { levenshtein } from './addressMatcher';

export function normalizeProductName(name: string): string {
    if (!name) return '';
    return name
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

export interface MatchCandidate {
    id: number;
    productId: number;
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

function scoreMatch(queryTokens: string[], candidateTokens: string[]): number {
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

    // Require at least half of query tokens to have matched at all.
    // Prevents coincidental single-token matches on short queries from passing
    // (e.g. "Gira SMETONIŠKA" matching "...KLEBONIŠKA dešra" via adjective suffix).
    if (matchedTokens / queryTokens.length < 0.5) return 0;

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

        let confidence = scoreMatch(queryTokens, candTokens);

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
        name: cand.storeProductName,
        brandName: cand.brandName,
        amount: cand.amount,
        unit: cand.unit,
        isWeighable: cand.isWeighable,
        imageUrl: cand.imageUrl,
        confidence: Math.round(confidence * 100) / 100,
    }));
}
