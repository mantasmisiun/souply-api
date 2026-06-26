/**
 * Anchor-token gate for product-name matching.
 *
 * Problem it solves: short product names that share a similar *ending* but
 * have a different *beginning* slip past character-level Levenshtein. The
 * real incident: Lidl "Airanas" was clustered with Maxima/IKI "Šafranas
 * KOTANYI" (productId 5125) because the single tokens "airanas" vs
 * "safranas" are 0.75 char-similar (edit distance 2 over 8 — same "…ranas"
 * tail). That mis-cluster then priced an Airanas receipt against a 0.010 g
 * saffran SP and blew a basket up by €230.
 *
 * The rule (from the product owner): when a name has *no other significant
 * words to latch onto* — i.e. it reduces to a single significant token —
 * it may only match a name that contains that token EXACTLY. Names with two
 * or more significant tokens on both sides carry enough signal and are left
 * to the caller's existing similarity threshold.
 *
 *   "Airanas"                              → {airanas}
 *   "Šafranas KOTANYI"                     → {safranas, kotanyi}   no exact → BLOCK
 *   "ILZENBERGO DVARO airanas 1% 500 ml"   → {ilzenbergo, dvaro, airanas}   has airanas → ALLOW
 *   "Rokiškio Naminis pienas 2.5%" vs "Naminis 2.5% pienas"
 *        {rokiskio, naminis, pienas} vs {naminis, pienas}  → both ≥2 tokens → DEFER
 *
 * The gate only ever *rejects* — it never creates a match — so it cannot
 * introduce new false positives; it can only remove the short-name ones.
 */

/** Tokens longer than 3 chars carry product identity. Units (g/ml/kg/l/vnt/
 *  pak/rit) and pure numbers are ≤3 chars or non-alphabetic and drop out. */
const SIGNIFICANT_MIN_LEN = 4;

function gateNormalize(s: string): string {
    return (s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // fold ąčęėįšųūž → aceeisuuz
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Significant tokens of a name: words ≥4 chars that contain a letter. Works
 * on raw or already-normalized input (gateNormalize is idempotent).
 */
export function significantTokens(name: string): string[] {
    return gateNormalize(name)
        .split(' ')
        .filter(t => t.length >= SIGNIFICANT_MIN_LEN && /[a-z]/.test(t));
}

/**
 * Returns false when two names must NOT be clustered/matched because the
 * side with the fewest significant tokens has only one ("nothing else to
 * latch onto") and that token does not appear EXACTLY among the other
 * name's significant tokens.
 *
 * Returns true (defer to the caller's similarity check) when either side has
 * no significant tokens, or both sides have ≥2 significant tokens.
 */
export function sharesRequiredAnchor(nameA: string, nameB: string): boolean {
    const a = significantTokens(nameA);
    const b = significantTokens(nameB);
    if (!a.length || !b.length) return true;          // can't judge → don't block
    if (Math.min(a.length, b.length) > 1) return true; // enough context → defer
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    const longSet = new Set(long);
    return short.some(t => longSet.has(t));
}
