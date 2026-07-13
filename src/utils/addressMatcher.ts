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
    // Normalized comparison variants: the FULL address plus every comma-segment that looks
    // like a STREET (carries a house number). Adding the street segment — not just the first
    // part — makes matching ORDER-INDEPENDENT: the street is found whether the OCR printed
    // "Lyros g. 19A-1, Šiauliai" or "Šiauliai, Lyros g. 19A-1". A bare CITY segment is never
    // added — matching city-to-city would tie every store in that town at distance 0.
    const streetVariants = (addr: string): string[] => {
        const out = [normalizeAddress(addr)];
        for (const part of addr.split(',')) {
            const np = normalizeAddress(part);
            if (np && /\d/.test(np)) out.push(np); // a house number ⇒ this segment is the street
        }
        return Array.from(new Set(out.filter((s) => s.length > 0)));
    };
    const ocrVariants = streetVariants(ocrAddress);
    if (ocrVariants.length === 0) return null;

    const ocrCity = extractCity(ocrAddress);
    // Only gate when the OCR gave us a usable city token (≥3 letters after the comma).
    const gateActive = cityGate > 0 && ocrCity.length >= 3;

    let best: AddressMatch<T> | null = null;

    // Position-independent city presence: the folded OCR address (all letters, no spaces/
    // punctuation) — so the store's city can be found whether the OCR printed it LAST
    // ("Lyros g. 19A-1, Šiauliai") or FIRST ("Šiauliai, Lyros g. 19A-1"). extractCity only
    // reads the last comma-segment, so a city-first address made it grab the STREET as the
    // "city" and the gate then rejected the correct store (Šiauliai Lyros).
    const ocrFolded = normalizeAddress(ocrAddress).replace(/[0-9]/g, '');

    for (const store of stores) {
        // CITY GATE — disqualify a store in a different town before scoring its street.
        // Passes through when the store address has no usable city (can't gate it).
        if (gateActive) {
            const storeCity = extractCity(store.address ?? '');
            // Pass if the city matches the last segment (OCR-truncation tolerant) OR appears
            // ANYWHERE in the folded OCR address (order-independent — city-first or -last).
            if (storeCity.length >= 3) {
                const cityPresent =
                    citySimilarity(ocrCity, storeCity) >= cityGate ||
                    (storeCity.length >= 4 && ocrFolded.includes(storeCity));
                if (!cityPresent) continue;
            }
        }

        const storeVariants = streetVariants(store.address ?? '');
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

        // TOKEN lane (order-independent): OCR can scramble the word ORDER entirely
        // ("36-101, Vilnius auletekio al." for "Saulėtekio al. 36-101, Vilnius" —
        // receipt-302), which defeats edit distance on any variant pairing. Accept when
        // the store's HOUSE NUMBER appears as an exact token AND its STREET NAME
        // fuzzy-matches (≤25% edits — tolerates the dropped "S" of "auletekio") one of
        // the OCR's letter tokens. The number+street pair is specific enough that word
        // order becomes irrelevant; scored just under a clean full match.
        if (bestRatio > maxRatio) {
            const tokens = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
                .split(/[^a-z0-9]+/).filter(Boolean);
            const ocrToks = tokens(ocrAddress);
            const storeStreetSeg = (store.address ?? '').split(',').find((p) => /\d/.test(p)) ?? '';
            const houseNum = (storeStreetSeg.match(/\d[\w-]*/g) ?? []).map((h) => h.replace(/[^a-z0-9]/gi, '').toLowerCase());
            const streetNames = tokens(storeStreetSeg).filter((t) => t.length >= 5 && !/\d/.test(t));
            const houseHit = houseNum.length > 0 && houseNum.every((h) =>
                ocrToks.includes(h) || ocrToks.join('').includes(h));
            const streetHit = streetNames.length > 0 && streetNames.some((sn) =>
                ocrToks.some((ot) => ot.length >= 4 && levenshtein(ot, sn) <= Math.ceil(sn.length * 0.25)));
            if (houseHit && streetHit) {
                const conf = 0.9;
                if (!best || best.confidence < conf) best = { store, distance: 1, confidence: conf };
                continue;
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