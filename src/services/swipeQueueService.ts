export interface RawCandidateRow {
    receiptLineIdx: number;
    rankPos: number;
    storeProductId: number;
    matchScore: number;
    autoMatched: boolean;
    name: string;
    brandName: string | null;
    amount: any;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    productId: number;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
}

export interface QueueCandidate {
    rankPos: number;
    storeProductId: number;
    name: string;
    brandName: string | null;
    amount: any;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    productId: number;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    matchScore: number;
    autoMatched: boolean;
}

export interface QueueItem {
    receiptLineIdx: number;
    ocrName: string | null;
    ocrAmount: any;
    ocrUnit: string | null;
    ocrPrice: number | null;
    ocrPromoPrice: number | null;
    lineStoreProductId: number;
    candidates: QueueCandidate[];
}

/**
 * Pure function: filters and sorts raw candidate rows into swipe queue items.
 * Extracted from the controller so it can be unit-tested without DB calls.
 *
 * Filtering rules:
 * - Lines without a resolved storeProductId are skipped (no pair can be formed)
 * - Self-pairs (candidate == line SP) are skipped if the price is already verified
 * - Cross-pairs are skipped if the user has already voted on that SP pair
 *
 * Output is sorted lowest-confidence-first so uncertain matches appear first.
 */
export function buildSwipeQueue(
    flat: RawCandidateRow[],
    parsedProducts: any[],
    votedPairs: Set<string>,
    verifiedSpIds: Set<number>,
): QueueItem[] {
    const byLine = new Map<number, QueueItem>();

    for (const r of flat) {
        const line = parsedProducts[r.receiptLineIdx] ?? {};
        const lineSpId = Number.isFinite(line.storeProductId) ? Number(line.storeProductId) : null;
        const candidateSpId = Number(r.storeProductId);

        if (lineSpId === null) continue;

        if (candidateSpId === lineSpId) {
            if (verifiedSpIds.has(candidateSpId)) continue;
        } else {
            const a = Math.min(lineSpId, candidateSpId);
            const b = Math.max(lineSpId, candidateSpId);
            if (votedPairs.has(`${a}-${b}`)) continue;
        }

        if (!byLine.has(r.receiptLineIdx)) {
            byLine.set(r.receiptLineIdx, {
                receiptLineIdx: r.receiptLineIdx,
                ocrName: line.name ?? null,
                ocrAmount: line.amount ?? null,
                ocrUnit: line.unit ?? null,
                ocrPrice: line.price ?? null,
                ocrPromoPrice: line.promoPrice ?? null,
                lineStoreProductId: lineSpId,
                candidates: [],
            });
        }
        byLine.get(r.receiptLineIdx)!.candidates.push({
            rankPos: r.rankPos,
            storeProductId: candidateSpId,
            name: r.name,
            brandName: r.brandName ?? null,
            amount: r.amount,
            unit: r.unit,
            isWeighable: !!r.isWeighable,
            imageUrl: r.imageUrl ?? null,
            productId: r.productId,
            chainId: r.chainId,
            chainName: r.chainName,
            chainLogoUrl: r.chainLogoUrl ?? null,
            matchScore: Number(r.matchScore),
            autoMatched: !!r.autoMatched,
        });
    }

    return Array.from(byLine.values()).sort((a, b) => {
        const aTop = a.candidates[0]?.matchScore ?? 0;
        const bTop = b.candidates[0]?.matchScore ?? 0;
        return aTop - bTop;
    });
}
