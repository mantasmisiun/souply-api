const KASA_SUFFIX_RE = /\s*Kasa\s*\d+\b.*$/i;
const KVITO_NR_RE = /Kvito\s+Nr\./i;
const BANK_KVITO_NR_RE = /Banko\s+Kvito\s+Nr\./i;
const KVITO_NR_PREFIX_RE = /^.*?Kvito\s+Nr\.\s*/i;
const KVITO_NUMERIS_RE = /Kvito\s+numeris\s+([A-Za-z0-9\/-]+)/i;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

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

export const normalizeReceiptDateForStorage = (receiptDate: string | null | undefined): string => {
    if (typeof receiptDate === 'string') {
        const value = receiptDate.trim();
        if (value) {
            const dateOnlyMatch = value.match(DATE_ONLY_RE);
            if (dateOnlyMatch) {
                return `${value} 00:00:00`;
            }

            const localDateTimeMatch = value.match(LOCAL_DATETIME_RE);
            if (localDateTimeMatch) {
                const seconds = localDateTimeMatch[4] ?? '00';
                return `${localDateTimeMatch[1]} ${localDateTimeMatch[2]}:${localDateTimeMatch[3]}:${seconds}`;
            }

            const parsed = new Date(value);
            if (!Number.isNaN(parsed.getTime())) {
                return formatSqlDateTime(parsed);
            }
        }
    }

    return formatSqlDateTime(new Date());
};
