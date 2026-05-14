/**
 * Pulls the three fields used by the account-recovery match key out of a
 * stored or freshly-parsed `parsedData` blob:
 *   - receiptNo
 *   - date  (YYYY-MM-DD)
 *   - total (euros, two decimals)
 *
 * The recovery match (POST /api/users/recover) compares these three values
 * across the user's submitted receipts and the candidates stored under
 * other UUIDs. Items, prices, brand names — none of that is needed for
 * recovery; the match key is intentionally narrow, drawn only from data
 * the user cannot edit after upload (see roadmap doc).
 *
 * Returns null when any of the three fields is missing or malformed —
 * the receipt is then ineligible for recovery, full stop. Better to fail
 * fast at extraction than carry undefined into the match query.
 */

export interface RecoveryFields {
    receiptNo: string;
    date: string;   // YYYY-MM-DD, day precision
    total: number;  // euros, finite, positive
}

export function extractRecoveryFields(parsedData: unknown): RecoveryFields | null {
    if (!parsedData || typeof parsedData !== 'object') return null;
    const footer = (parsedData as any).footer;
    if (!footer || typeof footer !== 'object') return null;

    const receiptNo = typeof footer.receiptNo === 'string' ? footer.receiptNo.trim() : '';
    if (!receiptNo) return null;

    // Date may arrive as ISO datetime ("2025-11-05T19:53:00") or date-only
    // ("2025-11-05"). Normalise to YYYY-MM-DD so DATE() comparisons match.
    const rawDate = typeof footer.date === 'string' ? footer.date.trim() : '';
    const date = normaliseToDay(rawDate);
    if (!date) return null;

    const totalRaw = footer.total;
    const total = typeof totalRaw === 'number'
        ? totalRaw
        : typeof totalRaw === 'string'
            ? parseFloat(totalRaw.replace(',', '.'))
            : NaN;
    if (!Number.isFinite(total) || total <= 0) return null;

    return { receiptNo, date, total };
}

/**
 * "2025-11-05T19:53:00Z" / "2025-11-05 19:53:00" / "2025-11-05" → "2025-11-05".
 * Returns empty string for unrecognised shapes so callers can null-check
 * the parent extraction.
 */
function normaliseToDay(s: string): string {
    if (!s) return '';
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
}
