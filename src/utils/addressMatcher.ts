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

/**
 * Extract the CITY component of an address: the segment after the LAST comma,
 * reduced to lowercase ASCII letters (diacritics folded, digits/punctuation/spaces
 * dropped). Returns '' when the address has no comma (no city part), e.g. IKI's
 * in-app street-only view "LYROS G. 5A".
 *
 *   "Vilniaus g. 128-2, Šiauliai" → "siauliai"
 *   "Vilniaus g. l 2, Siau'iai"   → "siauiai"   (OCR-garbled Šiauliai)
 *   "LYROS G. 5A"                 → ""          (no city)
 */
export function extractCity(addr: string): string {
    if (!addr) return '';
    const parts = addr.split(',');
    if (parts.length < 2) return '';
    return parts[parts.length - 1]
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z]/g, '');
}

/** City-name similarity 0..1 (1 = identical), tolerant of OCR truncation via a prefix bonus. */
export function citySimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    // OCR often truncates the tail of a city ("siau" for "šiauliai"); treat a solid
    // shared prefix as a full match so a cut-off-but-correct city still clears the gate.
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= 4 && long.startsWith(short)) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
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
 * Tries both full and street-only (part before first comma) normalizations on
 * each side. IKI's in-app receipt view surfaces only the street ("LYROS G. 5A")
 * with no city, while the stored DB address usually includes the city
 * ("Lyros g. 5A, Šiauliai"). Matching street-to-street recovers from that
 * mismatch, while the full-to-full pairing still wins for Rimi/Maxima where
 * the OCR captures both parts.
 *
 * CITY GATE: when the OCR carries a city (the address had a comma), a store in a
 * DIFFERENT city is disqualified BEFORE the street is scored. Many chains reuse the
 * same street name across towns (IKI has 13 "Vilniaus g." stores), so a garbled house
 * number can leave the street a near-match to the WRONG town's branch ("Vilniaus g. l 2,
 * Šiauliai" scored 1 edit from "Vilniaus g.62, Ukmergė"). Requiring city agreement first
 * makes the town the decisive signal. Skipped entirely when the OCR has no city (IKI's
 * in-app street-only view) so that path is unchanged.
 *
 * @param maxRatio - Maximum allowed (distance / maxLen) ratio. 0.3 = allow ~30% edit.
 * @param cityGate - Minimum city similarity (0..1) a store must clear when the OCR has a
 *                   city. 0 disables the gate.
 */
export function findBestStoreMatch<T extends { address: string }>(
    ocrAddress: string,
    stores: T[],
    maxRatio: number = 0.3,
    cityGate: number = 0.6
): AddressMatch<T> | null {
    const ocrVariants = Array.from(
        new Set(
            [
                normalizeAddress(ocrAddress),
                normalizeAddress(ocrAddress.split(',')[0]),
            ].filter((s) => s.length > 0)
        )
    );
    if (ocrVariants.length === 0) return null;

    const ocrCity = extractCity(ocrAddress);
    // Only gate when the OCR gave us a usable city token (≥3 letters after the comma).
    const gateActive = cityGate > 0 && ocrCity.length >= 3;

    let best: AddressMatch<T> | null = null;

    for (const store of stores) {
        // CITY GATE — disqualify a store in a different town before scoring its street.
        // Passes through when the store address has no usable city (can't gate it).
        if (gateActive) {
            const storeCity = extractCity(store.address ?? '');
            if (storeCity.length >= 3 && citySimilarity(ocrCity, storeCity) < cityGate) continue;
        }

        const storeVariants = Array.from(
            new Set(
                [
                    normalizeAddress(store.address ?? ''),
                    normalizeAddress((store.address ?? '').split(',')[0]),
                ].filter((s) => s.length > 0)
            )
        );
        if (storeVariants.length === 0) continue;

        // Pick the variant pairing with the smallest ratio. Using ratio (not
        // raw distance) so short-vs-short matches aren't unfairly disqualified
        // by longer alternatives scoring the same absolute distance.
        let bestRatio = Infinity;
        let bestDistance = Infinity;
        for (const o of ocrVariants) {
            for (const s of storeVariants) {
                const d = levenshtein(o, s);
                const r = d / Math.max(o.length, s.length);
                if (r < bestRatio) {
                    bestRatio = r;
                    bestDistance = d;
                }
            }
        }

        const confidence = 1 - bestRatio;
        if (
            bestRatio <= maxRatio &&
            (!best || bestDistance < best.distance)
        ) {
            best = { store, distance: bestDistance, confidence };
        }
    }

    return best;
}