import pool from '../config/db.js';

/**
 * Shared audit-log helper. Every admin write goes through this.
 *
 * Why centralised: future admin tabs (amounts, names, dead-end orphans)
 * will write the same shape of audit row. Having one helper means
 * column changes (e.g. adding `userAgent` later) propagate everywhere.
 *
 * Why `valueBefore` / `valueAfter` as JSON: each tab has different
 * relevant fields. Image tab: { imageUrl }. Amount tab: { amount, unit }.
 * Keeping the audit table schema-agnostic to per-tab payload keeps the
 * audit log usable across all future tabs without ALTERs.
 */

export type AdminAction =
    | 'image_adopt_candidate'      // adopted a cross-chain or BaseProductLink sibling's image
    | 'image_adopt_pending_upload' // approved a user's pending upload
    | 'image_admin_upload'         // admin uploaded a fresh image
    | 'image_remove'               // nulled out the SP's image
    | 'image_skip'                 // queue-only: dismissed the card without action
    | 'image_reject_pending'       // rejected a user's pending upload
    | 'image_revert'               // reversed an earlier image admin or auto action
    | 'amount_set'                 // set/changed amount + unit + isWeighable
    | 'amount_skip'                // dismissed an amount card without action
    | 'amount_revert'              // reversed an earlier amount change
    | 'flag_resolve'               // admin confirmed flag card, applied any field edits
    | 'flag_dismiss'               // admin rejected the user's flags (no change warranted)
    | 'flag_skip'                  // admin skipped the flag card without action
    | 'flag_price_suspect'         // sub-flag: marked the receipt-line price as suspect (parser bug breadcrumb)
    | 'flag_discount_suspect'      // sub-flag: same for the discount
    | 'uncategorised_set'          // assigned a category (+ optional name edit)
    | 'uncategorised_delete'       // deleted a Product (and its SPs by FK cascade)
    | 'uncategorised_skip'         // skipped without action — 90-day filter
    | 'uncategorised_split'         // split a merged receipt line into two products
    | 'product_merge'              // merged 2+ products into one canonical winner
    | 'product_move'               // moved product(s) to a different L3 category
    | 'product_rename'             // renamed a product's canonical name
    | 'sp_delete'                  // force-deleted a SP (and parent Product if last SP)
    | 'sp_edit'                    // edited SP fields (storeProductName, amount, unit, imageUrl…)
    | 'sp_move';                   // moved SP to a different Product

export interface LogActionArgs {
    adminUserId: string;
    action: AdminAction;
    targetType: 'StoreProduct' | 'PendingImageUpload' | 'ImagePropagationLog' | 'ReceiptLineIssue' | 'Product';
    targetId: number;
    valueBefore?: unknown;
    valueAfter?: unknown;
}

export async function logAdminAction(args: LogActionArgs): Promise<number> {
    const [res]: any = await pool.query(
        `INSERT INTO AdminAuditLog
            (adminUserId, action, targetType, targetId, valueBefore, valueAfter)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            args.adminUserId,
            args.action,
            args.targetType,
            args.targetId,
            args.valueBefore !== undefined ? JSON.stringify(args.valueBefore) : null,
            args.valueAfter !== undefined ? JSON.stringify(args.valueAfter) : null,
        ],
    );
    return Number(res.insertId);
}

/** Mark an existing audit row as reversed. Used by the revert flow. */
export async function markAuditReversed(auditId: number): Promise<void> {
    await pool.query(
        `UPDATE AdminAuditLog SET reversedAt = NOW() WHERE id = ?`, [auditId],
    );
}
