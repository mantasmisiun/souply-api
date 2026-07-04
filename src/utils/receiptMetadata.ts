const KASA_SUFFIX_RE = /\s*Kasa\s*\d+\b.*$/i;
const KVITO_NR_RE = /Kvito\s+Nr\./i;
const BANK_KVITO_NR_RE = /Banko\s+Kvito\s+Nr\./i;
const KVITO_NR_PREFIX_RE = /^.*?Kvito\s+Nr\.\s*/i;
const KVITO_NUMERIS_RE = /Kvito\s+numeris\s+([A-Za-z0-9\/-]+)/i;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

// OCR-garbled dates reach this normalizer VERBATIM ("2026-16-18" — the printed 06 read
// with 0→1). A shape-only regex let that through to MySQL, which rejects the INSERT and
// the client retry-loops on a deterministic 500 (receipt-242 re-scan). Any implausible
// month/day makes the value unusable → the caller falls through to its now() fallback.
const plausibleYmd = (y: string, m: string, d: string): boolean => {
    const mm = Number(m), dd = Number(d), yy = Number(y);
    return yy >= 2000 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
};

const cleanWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const stripKasaSuffix = (value: string): string => cleanWhitespace(value.replace(KASA_SUFFIX_RE, ''));

const formatSqlDateTime = (date: Date): string => {
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const extractReceiptNoFromFooterRawText = (footerRawText: string): string | null => {
    const lines = footerRawText
        .split(/\r?\n/)
        .map((line) => cleanWhitespace(line))
        .filter(Boolean);

    for (const line of lines) {
        if (!KVITO_NR_RE.test(line) || BANK_KVITO_NR_RE.test(line)) {
            continue;
        }

        const value = stripKasaSuffix(line.replace(KVITO_NR_PREFIX_RE, ''));
        if (value && /[0-9]/.test(value)) {
            return value;
        }
    }

    const kvitoNumerisMatch = footerRawText.match(KVITO_NUMERIS_RE);
    if (kvitoNumerisMatch?.[1]) {
        const value = cleanWhitespace(kvitoNumerisMatch[1]);
        if (value) return value;
    }

    return null;
};

export const normalizeReceiptNo = (
    receiptNo: string | null | undefined,
    footerRawText?: string | null
): string | null => {
    if (typeof receiptNo === 'string') {
        const value = stripKasaSuffix(receiptNo);
        if (value) return value;
    }

    if (typeof footerRawText === 'string') {
        return extractReceiptNoFromFooterRawText(footerRawText);
    }

    return null;
};

/**
 * Normalize the full set of receipt identifiers (a single physical receipt can print several —
 * IKI shows "Kvitas", "Kvito Nr." and "Kvito numeris"). Each value is Kasa-stripped/whitespace-
 * cleaned the same way as the canonical id, the canonical is forced to the FRONT (it stays the
 * dedup key + the value the UI shows), and duplicates are dropped while order is preserved.
 * Falls back to just the canonical when no array was parsed (older chains / older stored data).
 */
export const normalizeReceiptNos = (
    values: ReadonlyArray<string | null | undefined> | null | undefined,
    canonical: string | null
): string[] => {
    // Normalize the canonical too (idempotent in the live path where it's already clean) so a
    // backfill over an un-normalized stored receiptNo can't leak a "Kasa N" suffix into the array.
    const cleanedCanonical = normalizeReceiptNo(canonical);
    const cleaned = (values ?? [])
        .map((v) => normalizeReceiptNo(v))
        .filter((v): v is string => !!v);
    const ordered = cleanedCanonical ? [cleanedCanonical, ...cleaned] : cleaned;
    return [...new Set(ordered)];
};

/**
 * Build a SQL DATETIME from the parsed-receipt fields.
 *
 * `receiptDate` may be:
 *   - a full ISO datetime ("YYYY-MM-DD HH:MM:SS" or with `T`),
 *   - a date only ("YYYY-MM-DD"),
 *   - or any string that `new Date()` can parse.
 *
 * `receiptTime` is consulted only when `receiptDate` is a date-only
 * value — the parser captures date and time separately on receipts
 * where MLKit splits the row, and we want to combine them so the
 * stored timestamp matches when the shopping happened, not midnight
 * of that day. Time may be `HH:MM` or `HH:MM:SS`.
 *
 * If neither produces a usable datetime, falls back to the current
 * time so the column stays NOT NULL.
 */
export const normalizeReceiptDateForStorage = (
    receiptDate: string | null | undefined,
    receiptTime?: string | null | undefined,
): string => {
    if (typeof receiptDate === 'string') {
        const value = receiptDate.trim();
        if (value) {
            const dateOnlyMatch = value.match(DATE_ONLY_RE);
            if (dateOnlyMatch && plausibleYmd(dateOnlyMatch[1], dateOnlyMatch[2], dateOnlyMatch[3])) {
                const time = typeof receiptTime === 'string' ? receiptTime.trim() : '';
                if (time) {
                    const hhmmss = time.match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
                    if (hhmmss) {
                        const ss = hhmmss[3] ?? '00';
                        return `${value} ${hhmmss[1]}:${hhmmss[2]}:${ss}`;
                    }
                }
                // Time is OPTIONAL (some IKI layouts print it only in the bottom fiscal
                // line, which a short frame loses — receipt-278). Midday, not midnight:
                // it is the honest "unknown hour" midpoint and keeps as-of-date price
                // lookups on the purchase DAY regardless of timezone conversions.
                return `${value} 12:00:00`;
            }

            const localDateTimeMatch = value.match(LOCAL_DATETIME_RE);
            if (localDateTimeMatch && plausibleYmd(localDateTimeMatch[1], localDateTimeMatch[2], localDateTimeMatch[3])) {
                const seconds = localDateTimeMatch[6] ?? '00';
                return `${localDateTimeMatch[1]}-${localDateTimeMatch[2]}-${localDateTimeMatch[3]} ${localDateTimeMatch[4]}:${localDateTimeMatch[5]}:${seconds}`;
            }

            const parsed = new Date(value);
            // Same plausibility clamp as above — a "1926" receipt is an OCR artifact,
            // not history; fall through to now() rather than store nonsense.
            if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2000 && parsed.getFullYear() <= 2100) {
                return formatSqlDateTime(parsed);
            }
        }
    }

    return formatSqlDateTime(new Date());
};
