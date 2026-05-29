/**
 * Build a forgiving `WHERE` fragment for product/store-product name
 * searches. Every public-facing search input in the app routes through
 * one of these clauses, so getting it right here is a global win.
 *
 * Behavior:
 *   1. Tokenize the query on whitespace; empty queries pass through as
 *      `1=1` so callers can compose unconditionally.
 *   2. For each token build `<col> COLLATE utf8mb4_unicode_ci LIKE ?`
 *      with `%token%`. `utf8mb4_unicode_ci` weights `ž`/`z`, `ė`/`e`,
 *      `ą`/`a`, etc. as equivalent at the primary level, so a query
 *      typed without accents (the Lithuanian default on phone keyboards)
 *      matches accented names.
 *   3. AND the per-token clauses together — so "kapu zvake" finds
 *      "Kapų raudona žvakė" even though the middle word was skipped.
 *
 * Typo tolerance is intentionally NOT done at the SQL layer here. MariaDB
 * has no native trigram/edit-distance index, and full-table Levenshtein
 * would defeat any LIKE-friendly index path. Client-side
 * `utils/fuzzyMatch.ts` layers Levenshtein over the server's first-pass
 * results when that's needed; long-term we can revisit with a FULLTEXT
 * or precomputed fold column if recall ever falls short.
 */
export function buildFuzzyNameClause(
    query: string,
    columnExpr: string,
): { sql: string; params: string[] } {
    const tokens = (query ?? '')
        .trim()
        .split(/\s+/)
        .filter(t => t.length > 0);
    if (tokens.length === 0) return { sql: '1=1', params: [] };
    const clauses = tokens.map(
        () => `${columnExpr} COLLATE utf8mb4_unicode_ci LIKE ?`,
    );
    const params = tokens.map(t => `%${t}%`);
    return { sql: clauses.join(' AND '), params };
}
