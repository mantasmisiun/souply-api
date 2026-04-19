/**
 * Address matching for OCR'd Lithuanian store addresses.
 *
 * OCR noise examples this must handle:
 *   "Gequžių g. 30, Ši auli ai"  → "Gegužių g. 30, Šiauliai"
 *   "Aido g. 8-1, Siauliai"       → "Aido g. 8-1, Šiauliai"
 *   "Vilniaus pr, 100, Kaunas"    → "Vilniaus pr. 100, Kaunas"
 */

/**
 * Aggressively normalize an address for fuzzy comparison.
 * - Lowercase
 * - Strip diacritics (ą→a, ė→e, š→s, etc.)
 * - Normalize street abbreviations (g./pr./al./pl./a.)
 * - Remove ALL whitespace and punctuation (handles OCR word splits like "Ši auli ai")
 */
export function normalizeAddress(addr: string): string {
    if (!addr) return '';
    return addr
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .replace(/\b(gatve|g)\.?\b/g, 'g')
        .replace(/\b(prospektas|pr)\.?\b/g, 'pr')
        .replace(/\b(aleja|al)\.?\b/g, 'al')
        .replace(/\b(plentas|pl)\.?\b/g, 'pl')
        .replace(/\b(aikste|a)\.?\b/g, 'a')
        .replace(/[^a-z0-9]/g, ''); // drop everything else (spaces, commas, dashes)
}

/**
 * Standard Levenshtein edit distance.
 */
export function levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const m = a.length;
    const n = b.length;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);

    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,        // deletion
                curr[j - 1] + 1,    // insertion
                prev[j - 1] + cost  // substitution
            );
        }
        [prev, curr] = [curr, prev];
    }

    return prev[n];
}

export interface AddressMatch<T> {
    store: T;
    distance: number;
    confidence: number; // 0..1
}

/**
 * Find the best store match for an OCR'd address.
 * Returns null if no store is within the acceptable distance ratio.
 *
 * @param maxRatio - Maximum allowed (distance / maxLen) ratio. 0.3 = allow ~30% edit.
 */
export function findBestStoreMatch<T extends { address: string }>(
    ocrAddress: string,
    stores: T[],
    maxRatio: number = 0.3
): AddressMatch<T> | null {
    const normalizedOcr = normalizeAddress(ocrAddress);
    if (!normalizedOcr) return null;

    let best: AddressMatch<T> | null = null;

    for (const store of stores) {
        const normalizedStore = normalizeAddress(store.address);
        if (!normalizedStore) continue;

        const distance = levenshtein(normalizedOcr, normalizedStore);
        const maxLen = Math.max(normalizedOcr.length, normalizedStore.length);
        const ratio = distance / maxLen;
        const confidence = 1 - ratio;

        if (ratio <= maxRatio && (!best || distance < best.distance)) {
            best = { store, distance, confidence };
        }
    }

    return best;
}