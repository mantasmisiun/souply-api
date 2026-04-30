import pool from '../config/db.js';

export type FailReason =
    | 'ocr_no_text'
    | 'ocr_error'
    | 'chain_unrecognized'
    | 'store_unrecognized';

export interface LogFailureInput {
    userId: string | null;
    failReason: FailReason;
    ocrLineCount?: number | null;
    ocrPreview?: string | null;
    detectedChainName?: string | null;
    extractedStoreAddress?: string | null;
    imageFilePath?: string | null;
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
                   (userId, failReason, ocrLineCount, ocrPreview,
                    detectedChainName, extractedStoreAddress, imageFilePath)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                input.userId ?? null,
                input.failReason,
                input.ocrLineCount ?? null,
                preview,
                input.detectedChainName ?? null,
                input.extractedStoreAddress ?? null,
                input.imageFilePath ?? null,
            ]
        );
        return Number(res?.insertId ?? 0);
    } catch (err: any) {
        if (err?.code === 'ER_NO_SUCH_TABLE') {
            if (!warnedAboutMissingTable) {
                console.warn(
                    '[logFailedReceipt] FailedReceiptLog table missing — ' +
                        'logging failures to console only. Run the migration ' +
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
