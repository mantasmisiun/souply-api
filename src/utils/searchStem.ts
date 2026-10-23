/**
 * Souply 2.0 search — pragmatic Lithuanian stemmer for query tokens.
 *
 * Goal is RECALL across noun/adjective inflections ("saldi"→"saldžios",
 * "sojos"→"sojų"), not linguistic correctness: we strip one inflectional
 * ending and search LIKE %stem%. Tokens are AND-ed together by the caller,
 * so short stems stay precise in combination. Diacritics are folded FIRST
 * (matches the utf8mb4_unicode_ci collation the SQL side uses and the
 * `normalized` column in StoreProductTranslation).
 */

export const foldLithuanian = (s: string): string =>
    s.toLowerCase()
        .replace(/ą/g, 'a').replace(/č/g, 'c').replace(/ę/g, 'e').replace(/ė/g, 'e')
        .replace(/į/g, 'i').replace(/š/g, 's').replace(/ų/g, 'u').replace(/ū/g, 'u')
        .replace(/ž/g, 'z');

/** Longest-first so "-iais" wins over "-s". Folded forms only (fold first). */
const ENDINGS = [
    'iausias', 'iausia', 'iesiems', 'uosius',
    'iams', 'iais', 'iose', 'iuos', 'ioms', 'iams',
    'ams', 'ais', 'oms', 'ems', 'uose', 'yse', 'ose', 'ese',
    'ios', 'ius', 'iai', 'iam', 'iui', 'ims',
    'as', 'is', 'us', 'ys', 'os', 'es', 'ai', 'ei', 'io', 'iu', 'ia', 'ui', 'ie',
    'a', 'e', 'i', 'o', 'u', 'y', 's',
];

const MIN_STEM = 3;

/** Fold + strip ONE inflectional ending, keeping ≥3 chars of stem. */
export const stemToken = (token: string): string => {
    const folded = foldLithuanian(token.trim());
    if (folded.length <= MIN_STEM) return folded;
    for (const end of ENDINGS) {
        if (folded.length - end.length >= MIN_STEM && folded.endsWith(end)) {
            return folded.slice(0, folded.length - end.length);
        }
    }
    return folded;
};

/** Full-string normalization for stored vocabulary rows (fold + collapse
 *  whitespace) — the import script and the search arm MUST use the same. */
export const normalizeForSearch = (s: string): string =>
    foldLithuanian(s).replace(/\s+/g, ' ').trim();

/** Query → folded stems (empty tokens dropped). */
export const stemQuery = (query: string): string[] =>
    (query ?? '')
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .map(stemToken);
