import pool from '../config/db.js';
import type { RecoveryFields } from '../utils/receiptIntrospect.js';

/** How many failed attempts in a rolling 24h window before lockout. */
export const RATE_LIMIT_MAX_FAILURES = 3;
/** Tolerance on total-sum match (euros). The match ALSO requires an exact
 *  `receiptNo` (a long structured string) + exact `date`, which together
 *  already near-uniquely identify the stored receipt — so the total is only a
 *  "did the user actually OCR this receipt" confirmation, not the identifier.
 *  Kept loose enough to survive a single-digit re-OCR misread in the amount
 *  (e.g. 11.34 vs 11.24 — a 0.10 drift that previously failed recovery at the
 *  old 0.01 window), tight enough that a wildly different total still fails. */
export const TOTAL_MATCH_TOLERANCE_EUR = 0.5;

export type FailureReason =
    | 'no-match'
    | 'insufficient-chains'
    | 'merge-rollback'
    | 'locked';

export interface ReceiptMatchCandidate {
    receiptId: number;
    userId: string | null;
    chainId: number | null;
    storedReceiptNo: string;
    storedReceiptNos: string[];   // every identifier on the stored receipt (for the ambiguity tiebreaker)
    storedDate: string;   // YYYY-MM-DD
    storedTotal: number;
}

/**
 * Match query for a single submitted receipt. Identifies by the STABLE
 * date + total pair (total within tolerance) — NOT receiptNo. The receiptNo
 * can legitimately diverge between two parses of the same physical receipt
 * (the canonical "Kvito Nr.", the shorter "Kvitas" sequence number, or a
 * synthetic date+time+total id — whichever OCR could read that time), so
 * requiring it would break recovery for a receipt re-scanned via a different
 * fallback. The short "Kvitas" number is also NOT globally unique, so it must
 * never be the sole key. date+total identifies the receipt either way; the
 * 3-receipt / 2-chain / same-user floor in tryMatch supplies the security, and
 * an ambiguity guard there rejects a date+total collision across users.
 * storedReceiptNo is still returned for diagnostics. Joins Store for chainId.
 */
export async function findRecoveryCandidates(
    fields: RecoveryFields,
): Promise<ReceiptMatchCandidate[]> {
    const [rows]: any = await pool.query(
        `SELECT r.id          AS receiptId,
                r.userId      AS userId,
                s.chainId     AS chainId,
                r.receiptNoCanonical AS storedReceiptNo,
                r.receiptNos         AS storedReceiptNos,
                DATE_FORMAT(r.receiptDate, '%Y-%m-%d') AS storedDate,
                CAST(JSON_EXTRACT(r.parsedData, '$.footer.total') AS DECIMAL(10,2)) AS storedTotal
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
          WHERE DATE(r.receiptDate) = ?
            AND r.processingStatus = 'completed'
            AND r.parsedData IS NOT NULL
            AND r.userId IS NOT NULL
            AND ABS(
                CAST(JSON_EXTRACT(r.parsedData, '$.footer.total') AS DECIMAL(10,2)) - ?
            ) <= ?`,
        [fields.date, fields.total, TOTAL_MATCH_TOLERANCE_EUR],
    );
    return (rows as any[]).map(r => {
        // storedReceiptNos: the receiptNos COLUMN — a JSON-text array, or null on rows not yet
        // backfilled. The driver returns it as a STRING (the column isn't in db.ts JSON_ARRAY_FIELDS),
        // but decode up to twice to be robust if it's ever registered there (→ already-parsed) or
        // double-encoded. Fall back to the single canonical receiptNo when absent/garbage.
        let storedReceiptNos: string[] = [];
        let v: unknown = r.storedReceiptNos;
        for (let i = 0; i < 2 && typeof v === 'string'; i++) {
            try { v = JSON.parse(v); } catch { v = null; break; }
        }
        if (Array.isArray(v)) storedReceiptNos = v.filter((x) => typeof x === 'string').map(String);
        const storedReceiptNo = String(r.storedReceiptNo);
        if (storedReceiptNos.length === 0 && storedReceiptNo) storedReceiptNos = [storedReceiptNo];
        return {
            receiptId: Number(r.receiptId),
            userId: r.userId ?? null,
            chainId: r.chainId !== null && r.chainId !== undefined ? Number(r.chainId) : null,
            storedReceiptNo,
            storedReceiptNos,
            storedDate: String(r.storedDate),
            storedTotal: Number(r.storedTotal),
        };
    });
}

/**
 * Rolling-window failure count for rate-limiting. Successful attempts and
 * lockout records don't count — only `succeeded=0` rows within the last 24h.
 * That way a valid recovery doesn't burn one of the three attempts.
 */
export async function failedAttemptsInLast24h(
    deviceFingerprint: string,
): Promise<number> {
    const [rows]: any = await pool.query(
        `SELECT COUNT(*) AS n
           FROM AccountRecoveryAttempt
          WHERE deviceFingerprint = ?
            AND succeeded = 0
            AND attemptedAt > NOW() - INTERVAL 24 HOUR`,
        [deviceFingerprint],
    );
    return Number(rows[0]?.n ?? 0);
}

/**
 * Log one attempt. Called on every "user pressed Atkurti" press, regardless
 * of outcome, so the timeline is complete for telemetry and rate-limit
 * counting. `matchedUserId` is non-null only on success (or merge-rollback
 * where we got far enough to identify the user).
 */
export async function logRecoveryAttempt(args: {
    deviceFingerprint: string;
    matchedUserId: string | null;
    succeeded: boolean;
    failureReason: FailureReason | null;
}): Promise<number> {
    const [res]: any = await pool.query(
        `INSERT INTO AccountRecoveryAttempt
            (deviceFingerprint, matchedUserId, succeeded, failureReason)
         VALUES (?, ?, ?, ?)`,
        [args.deviceFingerprint, args.matchedUserId, args.succeeded ? 1 : 0, args.failureReason],
    );
    return Number(res.insertId);
}

/**
 * Flip an existing attempt row to its final outcome. Used by the recovery
 * controller when we logged the attempt up front (to get an attemptId for
 * the merge service's telegram alert) and need to record success or a
 * merge-rollback after the fact.
 */
export async function finaliseRecoveryAttempt(args: {
    attemptId: number;
    succeeded: boolean;
    failureReason: FailureReason | null;
}): Promise<void> {
    await pool.query(
        `UPDATE AccountRecoveryAttempt
            SET succeeded = ?, failureReason = ?
          WHERE id = ?`,
        [args.succeeded ? 1 : 0, args.failureReason, args.attemptId],
    );
}
