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
 * Append a FailedReceiptLog row. Fire-and-forget from the client's
 * perspective (used on the bail path when the Analize flow decides a
 * receipt can't proceed). Truncates ocrPreview to 500 chars — enough
 * to tell whether the OCR produced garbage or plausible text.
 */
export const logFailedReceipt = async (
    input: LogFailureInput
): Promise<number> => {
    const preview =
        typeof input.ocrPreview === 'string'
            ? input.ocrPreview.slice(0, 500)
            : null;
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
};
