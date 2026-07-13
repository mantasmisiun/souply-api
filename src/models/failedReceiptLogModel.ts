import pool from '../config/db.js';
import { resolveEnv } from '../scrapers/shared/telegramAlert.js';

export type FailReason =
    | 'ocr_no_text'
    | 'ocr_error'
    | 'chain_unrecognized'
    | 'store_unrecognized'
    | 'parse_failed'
    | 'mask_failed'
    // The client bail flow has always SENT these two, but the enum rejected them —
    // every no-products / doubled-scan bail 400'd silently and left no log row.
    // Requires sql/failed_receipt_log_reasons.sql on each environment.
    | 'no_products'
    | 'doubled_scan';

export interface LogFailureInput {
    userId: string | null;
    failReason: FailReason;
    ocrLineCount?: number | null;
    ocrPreview?: string | null;
    detectedChainName?: string | null;
    extractedStoreAddress?: string | null;
    imageFilePath?: string | null;
    /** Path of the (already card-masked) image in the failedReceipts bucket. */
    failedBucketPath?: string | null;
    /** The list row the upload was meant for (so an admin fix can re-link). */
    shoppingListId?: number | null;
    /** OCR/parsed payload captured at fail time, for later admin correction. */
    parsedData?: string | null;
}

/**
 * One-time guard: once the FailedReceiptLog table is reported as
 * missing, downgrade subsequent failures to a single console line
 * each so the dev console doesn't drown in stack traces.
 */
let warnedAboutMissingTable = false;

/**
 * Append a FailedReceiptLog row. Fire-and-forget from the client's
 * perspective (used on the bail path when the Analize flow decides
 * a receipt can't proceed). Truncates ocrPreview to 500 chars —
 * enough to tell whether the OCR produced garbage or plausible
 * text.
 *
 * Resilient to a missing table: dev / staging databases that
 * haven't run the FailedReceiptLog migration would otherwise crash
 * the bail path with a 500, masking the real failure (e.g.
 * store_unrecognized) from the mobile client. When MySQL reports
 * `ER_NO_SUCH_TABLE` we log the failure to console instead and
 * return 0. Any other error still bubbles up so genuine DB issues
 * are not silenced.
 */
export const logFailedReceipt = async (
    input: LogFailureInput
): Promise<number> => {
    const preview =
        typeof input.ocrPreview === 'string'
            ? input.ocrPreview.slice(0, 500)
            : null;
    try {
        const [res]: any = await pool.query(
            `INSERT INTO FailedReceiptLog
                   (userId, failReason, environment, ocrLineCount, ocrPreview,
                    detectedChainName, extractedStoreAddress, imageFilePath,
                    failedBucketPath, shoppingListId, parsedData)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.userId ?? null,
                input.failReason,
                resolveEnv(),
                input.ocrLineCount ?? null,
                preview,
                input.detectedChainName ?? null,
                input.extractedStoreAddress ?? null,
                input.imageFilePath ?? null,
                input.failedBucketPath ?? null,
                input.shoppingListId ?? null,
                input.parsedData ?? null,
            ]
        );
        return Number(res?.insertId ?? 0);
    } catch (err: any) {
        // Missing table (no base migration) OR missing column (no v2 migration
        // for environment/failedBucketPath/shoppingListId/parsedData) — both
        // mean this DB hasn't been migrated. Degrade to a console line instead
        // of 500-ing the client's bail path; the failure detail isn't lost.
        if (err?.code === 'ER_NO_SUCH_TABLE' || err?.code === 'ER_BAD_FIELD_ERROR') {
            if (!warnedAboutMissingTable) {
                console.warn(
                    '[logFailedReceipt] FailedReceiptLog table/columns missing — ' +
                        'logging failures to console only. Run the migration(s) ' +
                        'on this database to enable persistent failure logs.',
                );
                warnedAboutMissingTable = true;
            }
            console.warn('[logFailedReceipt]', {
                userId: input.userId,
                failReason: input.failReason,
                ocrLineCount: input.ocrLineCount ?? null,
                detectedChainName: input.detectedChainName ?? null,
                extractedStoreAddress: input.extractedStoreAddress ?? null,
            });
            return 0;
        }
        throw err;
    }
};

export interface FailedReceiptRow {
    id: number;
    userId: string | null;
    failReason: FailReason;
    environment: string;
    ocrLineCount: number | null;
    ocrPreview: string | null;
    detectedChainName: string | null;
    extractedStoreAddress: string | null;
    failedBucketPath: string | null;
    shoppingListId: number | null;
    parsedData: string | null;
    status: string;
    createdAt: string;
}

/** Admin queue: failures for this environment (default the unresolved ones). */
export const getFailedReceipts = async (
    environment: string,
    status: 'new' | 'resolved' = 'new',
    limit = 100,
): Promise<FailedReceiptRow[]> => {
    const [rows]: any = await pool.query(
        `SELECT id, userId, failReason, environment, ocrLineCount, ocrPreview,
                detectedChainName, extractedStoreAddress, failedBucketPath,
                shoppingListId, parsedData, status, createdAt
           FROM FailedReceiptLog
          WHERE environment = ? AND status = ?
          ORDER BY createdAt DESC
          LIMIT ?`,
        [environment, status, limit],
    );
    return rows as FailedReceiptRow[];
};

/** Count of unresolved failures for this env (admin badge). Resilient to an
 *  un-migrated DB (no environment/status columns) → 0. */
export const countNewFailedReceipts = async (environment: string): Promise<number> => {
    try {
        const [rows]: any = await pool.query(
            `SELECT COUNT(*) AS n FROM FailedReceiptLog WHERE environment = ? AND status = 'new'`,
            [environment],
        );
        return Number(rows?.[0]?.n ?? 0);
    } catch (e: any) {
        if (e?.code === 'ER_NO_SUCH_TABLE' || e?.code === 'ER_BAD_FIELD_ERROR') return 0;
        throw e;
    }
};

/** Mark a failed receipt resolved (admin dismissed it or promoted it to a Receipt). */
export const markFailedReceiptResolved = async (id: number): Promise<void> => {
    await pool.query(
        `UPDATE FailedReceiptLog SET status = 'resolved', resolvedAt = NOW() WHERE id = ?`,
        [id],
    );
};
