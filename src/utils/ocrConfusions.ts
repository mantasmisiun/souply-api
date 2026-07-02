/**
 * OCR-tolerant weighted edit distance for the product-name matcher's char lane.
 *
 * OCR errors are not random typos — they're systematic VISUAL confusions (ML Kit on
 * Lithuanian thermal receipts): digit-for-letter (`ryžiai`→`ryz14`: 1←i, 4←a), homoglyphs
 * (`0`↔`o`), and multi-char shape collisions (`basmati`→`basmall`: `ti`↔`ll`, `rn`↔`m`). A
 * plain Levenshtein charges each of these the full cost of a wrong character, so a
 * correct-but-garbled name scores below the match floor and never surfaces.
 *
 * `weightedLevenshtein` makes KNOWN confusions cheap (~0.15–0.4 instead of 1.0), so a
 * garbled name that IS its catalog product clears the floor — WITHOUT lowering the floor
 * (which would flood false positives). Diacritics are already NFD-folded upstream (ž→z), so
 * those cost 0 for free. Seeded from the Unicode-confusables / OCR canon (see
 * shared/OCR_MATCHING.md); "Balanced" set = digit↔letter + homoglyphs + the common multi-
 * char visual pairs. Costs are tuned against `receipts:matchaudit`.
 */

// ── Single-char confusions (symmetric). cost < 1.0 = how confusable the pair is. ──
const SINGLE: ReadonlyArray<readonly [string, string, number]> = [
    // digit ↔ letter (the OCR killers on thermal fonts)
    ['0', 'o', 0.10], ['1', 'i', 0.15], ['1', 'l', 0.15], ['5', 's', 0.20], ['8', 'b', 0.20],
    ['4', 'a', 0.25], ['2', 'z', 0.20], ['6', 'b', 0.35], ['6', 'g', 0.35], ['9', 'g', 0.35],
    ['7', 't', 0.40], ['3', 'e', 0.40], ['0', 'c', 0.45],
    // letter ↔ letter homoglyphs
    ['i', 'l', 0.30], ['i', 'j', 0.45], ['c', 'e', 0.45], ['u', 'v', 0.35], ['n', 'h', 0.45],
];

// ── Multi-char confusions (Balanced). Checked in BOTH directions in the DP. ──
const MULTI: ReadonlyArray<readonly [string, string, number]> = [
    ['rn', 'm', 0.30], ['cl', 'd', 0.35], ['vv', 'w', 0.30], ['ll', 'u', 0.40],
    ['ll', 'ti', 0.40], ['ii', 'u', 0.40], ['nn', 'm', 0.40], ['rn', 'nn', 0.45],
];

// Symmetric single-char cost lookup, keyed by the sorted char pair.
const SUB = new Map<string, number>();
for (const [a, b, c] of SINGLE) SUB.set(a < b ? a + b : b + a, c);

/** Substitution cost of turning char `a` into `b` (0 if identical, [0,1] otherwise). */
function subCost(a: string, b: string): number {
    if (a === b) return 0;
    return SUB.get(a < b ? a + b : b + a) ?? 1;
}

/**
 * Weighted Levenshtein distance with OCR confusion costs, including variable-length
 * (multi-char) substitutions. Insert/delete cost 1; single-char substitution uses `subCost`;
 * multi-char confusions collapse `from`↔`to` at their combined cost. Returns a real number
 * (fractional, since confusion costs are < 1). O(n·m·|MULTI|) — the char lane's early length
 * bail keeps the candidate set small.
 */
export function weightedLevenshtein(a: string, b: string): number {
    const n = a.length, m = b.length;
    if (n === 0) return m;
    if (m === 0) return n;

    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = 0; i <= n; i++) dp[i][0] = i;
    for (let j = 0; j <= m; j++) dp[0][j] = j;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            let best = Math.min(
                dp[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]), // substitute
                dp[i - 1][j] + 1,                               // delete from a
                dp[i][j - 1] + 1,                               // insert into a
            );
            // Multi-char confusions, both directions (a-has-x / b-has-y AND a-has-y / b-has-x).
            for (const [x, y, cost] of MULTI) {
                if (i >= x.length && j >= y.length && a.startsWith(x, i - x.length) && b.startsWith(y, j - y.length)) {
                    const cand = dp[i - x.length][j - y.length] + cost;
                    if (cand < best) best = cand;
                }
                if (i >= y.length && j >= x.length && a.startsWith(y, i - y.length) && b.startsWith(x, j - x.length)) {
                    const cand = dp[i - y.length][j - x.length] + cost;
                    if (cand < best) best = cand;
                }
            }
            dp[i][j] = best;
        }
    }
    return dp[n][m];
}
