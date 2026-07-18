import { buildFuzzyNameClause } from './fuzzyNameClause.js';
import { stemQuery } from './searchStem.js';

/**
 * THE single source of truth for "does a product match this search query".
 *
 * Both surfaces that search products consume this: the ranked
 * `/api/products/search` (which runs the arms as separate ranked queries and
 * merges them by relevance) and the Discounts filter (which ORs every signal
 * into one WHERE against the pre-computed summary). Add or tune a signal HERE
 * and both pick it up — no second place to change.
 *
 * Signals (same order = relevance rank in the ranked search):
 *   1. full-token name match  (fuzzy, diacritic-folding LIKE)
 *   2. stemmed name match     (inflection recall: "sojos" → "sojų")
 *   3. StoreProduct name      (SP names diverge from the cluster head)
 *   4. SP translations        (StoreProductTranslation: EN names + LT synonyms
 *                              — this is what makes English queries hit)
 *   5. canonical receipt aliases (user-confirmed OCR namings)
 *
 * Locale-independent by design: every signal is searched regardless of the
 * caller's language, so a query in any language finds its product.
 */

const COLLATE = 'COLLATE utf8mb4_unicode_ci';

interface Clause { sql: string; params: any[] }

/** Every stem must LIKE the column (AND-composed): "kapu zvake" stays precise. */
function stemAnd(stems: string[], col: string): Clause {
    return {
        sql: stems.map(() => `${col} ${COLLATE} LIKE ?`).join(' AND '),
        params: stems.map((s) => `%${s}%`),
    };
}

export interface ProductSearchClauses {
    /** Arm 1: full-token fuzzy match on the name column. */
    nameFuzzy: Clause;
    /** Arm 2: stemmed match on the name column. null when the query has no
     *  stemmable tokens (very short queries) — callers skip it. */
    nameStem: Clause | null;
    /** Arms 3–5: productId-resolving subqueries in rank order (SP name →
     *  translations → aliases). Empty when the query has no stems. Each row's
     *  SELECT yields a `productId` column. */
    rankedIdArms: { key: string; sql: string; params: any[] }[];
    /** All signals OR-combined into one predicate keyed on `nameCol` + `idCol`
     *  — the FILTER form (Discounts). */
    matchAny: Clause;
    stems: string[];
}

/**
 * @param nameCol SQL expression for the product's display name in the host
 *   query (e.g. `p.name`, or the discounts summary's `d.name`).
 * @param idCol   SQL expression for the product's id (e.g. `p.id`,
 *   `d.productId`) — used to correlate the SP/translation/alias EXISTS arms.
 */
export function productSearchClauses(
    query: string,
    opts: { nameCol: string; idCol: string },
): ProductSearchClauses {
    const { nameCol, idCol } = opts;
    const nameFuzzy = buildFuzzyNameClause(query, nameCol);
    const stems = stemQuery(query);

    const nameStem = stems.length > 0 ? stemAnd(stems, nameCol) : null;

    // Arms 3–5 as reusable pieces: the ranked search wants productId subqueries;
    // the filter wants the same predicate as an EXISTS correlated on `idCol`.
    const rankedIdArms: { key: string; sql: string; params: any[] }[] = [];
    const anyClauses: string[] = [`(${nameFuzzy.sql})`];
    const anyParams: any[] = [...nameFuzzy.params];

    if (stems.length > 0 && nameStem) {
        anyClauses.push(`(${nameStem.sql})`);
        anyParams.push(...nameStem.params);

        const arms: { key: string; from: string; col: string }[] = [
            { key: 'spName', from: 'StoreProduct sp', col: 'sp.storeProductName' },
            { key: 'translations', from: 'StoreProductTranslation spt JOIN StoreProduct sp ON sp.id = spt.storeProductId', col: 'spt.normalized' },
            { key: 'aliases', from: "StoreProductReceiptAlias sar JOIN StoreProduct sp ON sp.id = sar.storeProductId AND sar.status = 'canonical'", col: 'sar.normalizedAlias' },
        ];
        for (const arm of arms) {
            const c = stemAnd(stems, arm.col);
            rankedIdArms.push({
                key: arm.key,
                sql: `SELECT DISTINCT sp.productId FROM ${arm.from} WHERE ${c.sql}`,
                params: c.params,
            });
            anyClauses.push(`EXISTS (SELECT 1 FROM ${arm.from} WHERE sp.productId = ${idCol} AND ${c.sql})`);
            anyParams.push(...c.params);
        }
    }

    return {
        nameFuzzy,
        nameStem,
        rankedIdArms,
        matchAny: { sql: `(${anyClauses.join(' OR ')})`, params: anyParams },
        stems,
    };
}
