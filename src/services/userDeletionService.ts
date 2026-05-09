import pool from '../config/db.js';
import { applyAggregateDelta, getMatchAggregate } from '../models/storeProductMatchModel.js';
import { reevaluateMerge } from './swipeVoteService.js';
import { deleteReceiptImage } from './storageService.js';

export type DeletionMode = 'anonymize' | 'purge';

export interface DeletionResult {
    deleted: boolean;
    votesHandled: number;
    mergesRevaluated: number;
}

/**
 * Strip PII from parsedData for all receipts owned by a user, then persist
 * the sanitized JSON back. The fields removed are:
 *   footer.rawText  — contains partial card numbers, loyalty card, payment RRN
 *   header.rawText  — contains cashier identifier
 *   products[].rawLines — raw OCR lines (redundant; structured fields are kept)
 *
 * Everything else (prices, dates, store info, product matches) is retained
 * for the global price database.
 */
async function sanitizeReceiptParsedData(userId: string): Promise<void> {
    const [rows]: any = await pool.query(
        `SELECT id, parsedData FROM Receipt WHERE userId = ? AND parsedData IS NOT NULL`,
        [userId],
    );
    for (const row of rows) {
        try {
            const d = typeof row.parsedData === 'string'
                ? JSON.parse(row.parsedData)
                : structuredClone(row.parsedData);

            if (d?.footer) delete d.footer.rawText;
            if (d?.header) delete d.header.rawText;
            if (Array.isArray(d?.products)) {
                for (const p of d.products) delete p.rawLines;
            }

            await pool.query(
                `UPDATE Receipt SET parsedData = ? WHERE id = ?`,
                [JSON.stringify(d), row.id],
            );
        } catch (err) {
            console.error(`[userDeletion] parsedData sanitization failed for receipt ${row.id}:`, err);
        }
    }
}

/**
 * Delete all MinIO receipt images belonging to a user, then null out the
 * filePath column so there are no dead URLs left in the DB.
 * MinIO errors are logged but do not abort the operation — a stranded object
 * is a lesser problem than blocking account deletion.
 */
async function deleteUserReceiptImages(userId: string): Promise<void> {
    const [rows]: any = await pool.query(
        `SELECT id, filePath FROM Receipt WHERE userId = ? AND filePath IS NOT NULL`,
        [userId],
    );
    const ids: number[] = [];
    for (const row of rows) {
        try {
            await deleteReceiptImage(row.filePath);
            ids.push(row.id);
        } catch (err) {
            console.error(`[userDeletion] MinIO delete failed for receipt ${row.id}:`, err);
        }
    }
    if (ids.length > 0) {
        await pool.query(`UPDATE Receipt SET filePath = NULL WHERE id IN (?)`, [ids]);
    }
}

/**
 * Delete a user account in one of two modes:
 *
 * anonymize — severs identity without touching vote signal.
 *   StoreProductMatchVote.userId → NULL  (vote remains, aggregate stays correct)
 *   Receipt.userId               → NULL  (price history stays)
 *   AdminReviewFlag.flaggedBy    → NULL  (flag stays for audit)
 *   Basket / ShoppingList        → CASCADE-deleted by FK rule
 *   UserStoreProductEquivalence  → CASCADE-deleted by FK rule
 *   The single DELETE FROM User triggers all FK rules automatically.
 *
 * purge — bad-actor removal. Reverses every vote's aggregate impact,
 *   re-evaluates affected merge thresholds, then deletes the vote rows
 *   explicitly before removing the user row. Receipts/prices are anonymized
 *   (not deleted) — purging fake price data requires a separate admin action.
 */
export const deleteUser = async (
    targetUserId: string,
    mode: DeletionMode,
): Promise<DeletionResult> => {
    const [existing]: any = await pool.query(
        `SELECT id FROM User WHERE id = ? LIMIT 1`, [targetUserId],
    );
    if (existing.length === 0) {
        return { deleted: false, votesHandled: 0, mergesRevaluated: 0 };
    }

    if (mode === 'anonymize') {
        await sanitizeReceiptParsedData(targetUserId);
        await deleteUserReceiptImages(targetUserId);
        await pool.query(`DELETE FROM User WHERE id = ?`, [targetUserId]);
        return { deleted: true, votesHandled: 0, mergesRevaluated: 0 };
    }

    // Both steps run outside the transaction — MinIO/JSON writes are not
    // transactional; doing them first keeps the DB lock window short.
    await sanitizeReceiptParsedData(targetUserId);
    await deleteUserReceiptImages(targetUserId);

    // purge: reverse every vote's aggregate contribution, re-evaluate merges.
    const connection = await (pool as any).getConnection();
    try {
        await connection.beginTransaction();

        const [votes]: any = await connection.query(
            `SELECT spIdA, spIdB, vote FROM StoreProductMatchVote WHERE userId = ?`,
            [targetUserId],
        );

        const pairsToRevaluate = new Map<string, { spIdA: number; spIdB: number }>();
        for (const v of votes) {
            await applyAggregateDelta(v.spIdA, v.spIdB, v.vote, -1, connection);
            pairsToRevaluate.set(`${v.spIdA}-${v.spIdB}`, { spIdA: v.spIdA, spIdB: v.spIdB });
        }

        let mergesRevaluated = 0;
        for (const { spIdA, spIdB } of pairsToRevaluate.values()) {
            const agg = await getMatchAggregate(spIdA, spIdB, connection);
            await reevaluateMerge(spIdA, spIdB, agg, connection);
            mergesRevaluated++;
        }

        // Explicit delete so purged votes don't linger as anonymous rows.
        await connection.query(
            `DELETE FROM StoreProductMatchVote WHERE userId = ?`, [targetUserId],
        );

        // DELETE FROM User triggers remaining FK rules:
        // Receipt / AdminReviewFlag → SET NULL, Basket / ShoppingList → CASCADE.
        await connection.query(`DELETE FROM User WHERE id = ?`, [targetUserId]);

        await connection.commit();
        return { deleted: true, votesHandled: votes.length, mergesRevaluated };
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
};
