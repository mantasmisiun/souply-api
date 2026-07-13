import { detectUnitConflict } from '../utils/unitConflict.js';

export interface RawSlot2Row {
    source: '2a' | '2b' | '2c';
    orphanSpId: number;
    candidateSpId: number;
    score: number;
    sameChain: boolean;
    orphan: {
        productId: number;
        name: string;
        brandName: string | null;
        imageUrl: string | null;
        unit: string | null;
        chainId: number;
        chainName: string;
        chainLogoUrl: string | null;
        categoryId: number;
        categoryName: string;
    };
    candidate: {
        productId: number;
        name: string;
        brandName: string | null;
        imageUrl: string | null;
        unit: string | null;
        chainId: number;
        chainName: string;
        chainLogoUrl: string | null;
        categoryId: number;
        categoryName: string;
    };
}

export interface Slot2QueueItem {
    cardId: string;
    slot: 2;
    score: number;
    source: '2a' | '2b' | '2c';
    orphanSpId: number;
    candidateSpId: number;
    sameChain: boolean;
    conflictDetected: boolean;
    orphan: RawSlot2Row['orphan'];
    candidate: RawSlot2Row['candidate'];
}

function canonicalKey(spA: number, spB: number): string {
    return `${Math.min(spA, spB)}-${Math.max(spA, spB)}`;
}

/**
 * Deduplicate, filter voted pairs, enrich with conflict info, and sort.
 *
 * Priority rule: source 2a wins over 2b for the same canonical pair because
 * 2a candidates have a stronger personalisation signal.
 */
export function buildSlot2Queue(
    rows: RawSlot2Row[],
    votedPairKeys: Set<string>,
): Slot2QueueItem[] {
    // Deduplicate: first pass — keep 2a over 2b for the same key.
    const seen = new Map<string, RawSlot2Row>();
    for (const row of rows) {
        const key = canonicalKey(row.orphanSpId, row.candidateSpId);
        const existing = seen.get(key);
        if (!existing) {
            seen.set(key, row);
        } else if (existing.source === '2b' && row.source === '2a') {
            // 2a always beats 2b
            seen.set(key, row);
        }
    }

    // Filter voted, compute conflict, build output.
    const items: Slot2QueueItem[] = [];
    for (const [key, row] of seen) {
        if (votedPairKeys.has(key)) continue;

        items.push({
            cardId: key,
            slot: 2,
            score: row.score,
            source: row.source,
            orphanSpId: row.orphanSpId,
            candidateSpId: row.candidateSpId,
            sameChain: row.sameChain,
            conflictDetected: detectUnitConflict(row.orphan.unit, row.candidate.unit),
            orphan: row.orphan,
            candidate: row.candidate,
        });
    }

    items.sort((a, b) => b.score - a.score);
    return items;
}
