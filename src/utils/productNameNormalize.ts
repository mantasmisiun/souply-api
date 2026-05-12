/**
 * Product name normalisation + similarity for clustering and candidate ranking.
 *
 * Used by:
 *  - The one-shot baseProduct migration (src/scripts/seedBaseProducts.ts).
 *  - Future Product-creation code that needs to pick an existing baseProduct
 *    when a new Product's name resembles one already in the DB.
 *
 * Design:
 *  - Diacritics stripped via NFD decomposition + combining-mark removal, so
 *    `Juodosios` and `juodosios` collapse to the same form.
 *  - Amount/unit tokens (`200g`, `1,5 l`, `3 vnt`, `40%`) are removed so that
 *    same-brand different-size Products cluster together.
 *  - Brand-name tokens (MAXIMA, RIMI) are retained intentionally — they help
 *    separate "Jaffa olives" from "Select olives" within the same category.
 *  - Similarity = normalised Levenshtein ratio in [0, 1].
 */

const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalizeProductName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    // Drop amount+unit tokens: `200 g`, `1,5 l`, `3 vnt.`, `40 proc`, `40 %`
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|vnt\.?|pak\.?|proc\.?|%)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
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
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Normalised similarity in [0, 1]. 1 = identical after normalisation.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeProductName(a);
  const nb = normalizeProductName(b);
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// Chain-specific brand tokens that pollute cross-chain name comparisons.
const CHAIN_TOKENS = /\b(rimi|maxima|iki|lidl|norfa|smart|barbora)\b/g;

/**
 * Normalise for cross-chain comparison.
 * Intentionally does NOT strip numeric tokens so that pack-size differences
 * ("32 vnt" vs "72 vnt") produce measurably lower similarity instead of
 * collapsing to identical strings.
 */
function crossChainNormalize(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(CHAIN_TOKENS, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Like nameSimilarity but strips chain-brand tokens and preserves numbers
 * so pack-size variants ("32 vnt" vs "72 vnt") are not treated as identical.
 */
export function crossChainNameSimilarity(a: string, b: string): number {
  const na = crossChainNormalize(a);
  const nb = crossChainNormalize(b);
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}
