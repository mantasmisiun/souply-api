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
