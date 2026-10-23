import type { Request, Response, NextFunction } from 'express';

/**
 * Locale resolution for category translations.
 *
 * Reads `Accept-Language` (first language tag wins) and falls back to
 * Lithuanian. We only ship LT + EN today, so anything else collapses
 * to `lt` — the LEFT JOIN in `localizedCategoryNameSql` returns the
 * original `Category.name` (LT) when no translation row exists, so a
 * future locale that lacks seed rows degrades gracefully.
 *
 * Available locales come from the table contents; we don't hardcode
 * them here so a freshly-seeded language works immediately without a
 * server restart.
 */

export type Locale = 'lt' | 'en';

declare module 'express-serve-static-core' {
    interface Request {
        locale: Locale;
    }
}

const KNOWN: Locale[] = ['lt', 'en'];

function normalise(raw: string | undefined): Locale {
    if (!raw) return 'lt';
    // Accept-Language: "en-US,en;q=0.9,lt;q=0.8" → take the first tag,
    // strip region. q-weighting parsing is overkill for two languages.
    const first = raw.split(',')[0]?.trim().toLowerCase() ?? '';
    const base = first.split('-')[0];
    if ((KNOWN as string[]).includes(base)) return base as Locale;
    return 'lt';
}

export function resolveLocale(req: Request, _res: Response, next: NextFunction): void {
    // Query string `?lang=` wins over the header — useful for testing
    // and explicit deep links. Defensive against array values.
    const queryLang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    if (queryLang) {
        const base = queryLang.toLowerCase().split('-')[0];
        if ((KNOWN as string[]).includes(base)) {
            req.locale = base as Locale;
            return next();
        }
    }
    req.locale = normalise(req.header('Accept-Language'));
    next();
}

/**
 * SQL fragment for locale-aware category name resolution.
 *
 * Use as a building block in any SELECT that surfaces a category
 * name. Returns:
 *   - `joinSql`: a LEFT JOIN clause to splice into the FROM chain
 *   - `nameSql`: an expression with COALESCE fallback to LT
 *
 * Both are parameter-free strings; the locale is injected into the
 * `params` array via `params: [locale, ...]`. The join alias is
 * configurable so it doesn't clash if the query already aliases
 * Category as `c`.
 *
 * Example:
 *   const cat = localizedCategoryNameSql('en', { categoryAlias: 'c' });
 *   pool.query(`
 *     SELECT c.id, ${cat.nameSql} AS name, c.name AS nameKey
 *     FROM Category c
 *     ${cat.joinSql}
 *     WHERE c.parentCategoryId IS NULL
 *   `, [cat.localeParam]);
 */
export interface LocalizedNameSql {
    /** LEFT JOIN clause; references the category alias passed in. */
    joinSql: string;
    /** Expression resolving to translated name, fallback to LT. */
    nameSql: string;
    /** Locale parameter value to pass in the params array. */
    localeParam: Locale;
    /** Translation-table alias used inside `nameSql` / `joinSql`. */
    translationAlias: string;
}

export function localizedCategoryNameSql(
    locale: Locale,
    opts: { categoryAlias?: string; translationAlias?: string } = {},
): LocalizedNameSql {
    const cat = opts.categoryAlias ?? 'c';
    const tr = opts.translationAlias ?? 'ct';
    return {
        joinSql: `LEFT JOIN CategoryTranslation ${tr} ON ${tr}.categoryId = ${cat}.id AND ${tr}.locale = ?`,
        nameSql: `COALESCE(${tr}.name, ${cat}.name)`,
        localeParam: locale,
        translationAlias: tr,
    };
}

export interface LocalizedProductSql {
    /** Expression resolving to the localized product DISPLAY name. */
    nameSql: string;
    /** Expression resolving to the JSON array of image URLs. In EN the
     *  name-donor SP's photo leads so name + image can never diverge. */
    imageUrlsSql: string;
}

/**
 * Locale-aware product NAME + IMAGE resolution — the product counterpart of
 * `localizedCategoryNameSql`.
 *
 * Products don't have a translation column; English lives per-StoreProduct in
 * `StoreProductTranslation(lang='en', text)`. `Product.name` is the shortest of
 * the SPs' Lithuanian names, so the English analogue is the shortest of the
 * SPs' English `text`s.
 *
 * LT (default) is a strict NO-OP — the stored `p.name` and the plain image
 * aggregate, byte-identical to the pre-i18n queries (no join, no added cost).
 *
 * EN returns, as parameter-free expressions (locale is a validated enum, never
 * user text, so `'en'` is inlined — no `?` bind needed):
 *   - `nameSql`: the shortest `spt.text` across the product's SPs, COALESCE
 *     fallback to `p.name` for the rare SP with no `lang='en'` row.
 *   - `imageUrlsSql`: the image aggregate ORDER-BY'd so the SAME donor SP's
 *     `imageUrl` is first (the client reads index 0) — the "name and photo
 *     can't diverge" invariant.
 *
 * `productAlias` is the Product row alias in the host query (usually `p`). The
 * internal subquery aliases (`spt`, `sp2`, `spi`) are scoped to the subqueries
 * and won't clash with the outer query's `sp`.
 */
export function localizedProductNameSql(
    locale: Locale,
    opts: { productAlias?: string; idExpr?: string; nameExpr?: string } = {},
): LocalizedProductSql {
    const p = opts.productAlias ?? 'p';
    // The product's id + its LT display name in the host query. Both are
    // overridable so this works over a denormalized table (e.g. the discounts
    // summary keys on `productId` and carries a baked `name` column).
    const id = opts.idExpr ?? `${p}.id`;
    const ltName = opts.nameExpr ?? `${p}.name`;
    const plainImages =
        `(SELECT JSON_ARRAYAGG(spi.imageUrl) FROM StoreProduct spi ` +
        `WHERE spi.productId = ${id} AND spi.imageUrl IS NOT NULL)`;
    if (locale !== 'en') {
        return { nameSql: ltName, imageUrlsSql: plainImages };
    }
    // The SP donating the shortest English name — reused for name + image lead.
    const donorPick =
        `FROM StoreProductTranslation spt ` +
        `JOIN StoreProduct sp2 ON sp2.id = spt.storeProductId ` +
        `WHERE sp2.productId = ${id} AND spt.lang = 'en' ` +
        `ORDER BY CHAR_LENGTH(spt.text), spt.text, sp2.id LIMIT 1`;
    return {
        nameSql: `COALESCE((SELECT spt.text ${donorPick}), ${ltName})`,
        imageUrlsSql:
            `(SELECT JSON_ARRAYAGG(spi.imageUrl ORDER BY ` +
            `(spi.id = (SELECT sp2.id ${donorPick})) DESC, spi.id) ` +
            `FROM StoreProduct spi ` +
            `WHERE spi.productId = ${id} AND spi.imageUrl IS NOT NULL)`,
    };
}

/**
 * Localized display name for ONE SPECIFIC StoreProduct.
 *
 * Distinct from `localizedProductNameSql`, which resolves a *product's* English
 * name by picking a donor translation from any of its store products. That is
 * wrong for the swipe queue: its whole purpose is comparing two store products
 * that may not share a product yet — often one has no product at all — so the
 * name shown must belong to the SP on the card, not to a group it isn't in.
 *
 * Returns a bare SQL expression with **no placeholder**, so it can be dropped
 * into an existing query without disturbing positional parameters. Safe because
 * `locale` is a typed union and the alias is caller-supplied, never user input.
 *
 * Shortest translation wins, matching the donor-pick convention above — chain
 * names run long and the swipe card has two of them stacked.
 */
export function localizedSpNameSql(
    locale: Locale,
    spAlias: string,
    fallbackExpr: string,
): string {
    if (locale !== 'en') return fallbackExpr;
    return (
        `COALESCE((SELECT spt.text FROM StoreProductTranslation spt ` +
        `WHERE spt.storeProductId = ${spAlias}.id AND spt.lang = 'en' ` +
        `ORDER BY CHAR_LENGTH(spt.text), spt.id LIMIT 1), ${fallbackExpr})`
    );
}
