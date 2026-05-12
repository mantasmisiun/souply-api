const SLOT3_MIN_SCORE = 0.75;

export interface RawSlot3Row {
    spIdA: number;
    spIdB: number;
    score: number;
    left: {
        productId: number;
        name: string;
        brandName: string | null;
        imageUrl: string | null;
        chainId: number;
        chainName: string;
        chainLogoUrl: string | null;
        categoryId: number;
        categoryName: string;
    };
    right: {
        productId: number;
        name: string;
        brandName: string | null;
        imageUrl: string | null;
        chainId: number;
        chainName: string;
        chainLogoUrl: string | null;
        categoryId: number;
        categoryName: string;
    };
}

export interface Slot3QueueItem {
    cardId: string;
    slot: 3;
    score: number;
    spIdA: number;
    spIdB: number;
    left: RawSlot3Row['left'];
    right: RawSlot3Row['right'];
}

function canonicalKey(spA: number, spB: number): string {
    return `${Math.min(spA, spB)}-${Math.max(spA, spB)}`;
}

/**
 * Filter below-threshold pairs, deduplicate symmetric rows, remove voted pairs,
 * and sort descending by score.
 */
export function buildSlot3Queue(
    rows: RawSlot3Row[],
    votedPairKeys: Set<string>,
): Slot3QueueItem[] {
    const seenSpPairs = new Set<string>();
    const seenProductPairs = new Set<string>();
    const items: Slot3QueueItem[] = [];

    for (const row of rows) {
        const spKey = canonicalKey(row.spIdA, row.spIdB);
        if (seenSpPairs.has(spKey)) continue;
        seenSpPairs.add(spKey);

        // Deduplicate by product ID pair — multiple SP combos for the same
        // two products (e.g. 3 Fairy Lemon SPs × 2 Fairy Apple SPs) should
        // only produce one card.
        const productKey = canonicalKey(row.left.productId, row.right.productId);
        if (seenProductPairs.has(productKey)) continue;
        seenProductPairs.add(productKey);

        if (votedPairKeys.has(spKey)) continue;

        items.push({
            cardId: spKey,
            slot: 3,
            score: row.score,
            spIdA: row.spIdA,
            spIdB: row.spIdB,
            left: row.left,
            right: row.right,
        });
    }

    items.sort((a, b) => b.score - a.score);
    return items;
}
