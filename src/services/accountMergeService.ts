import pool from '../config/db.js';
import { notifyTelegram } from '../scrapers/shared/telegramAlert.js';

/**
 * Merges the fresh-install UUID into a recovered UUID atomically.
 *
 * Called by the account-recovery flow after a successful 3-receipt match.
 * Re-points every userId-bearing row that the fresh device wrote, sums
 * the points column, and deletes the fresh User row — all inside one
 * MySQL transaction so a partial merge can't leave the database in a
 * half-recovered state.
 *
 * Why a service and not a model: this is the only place in the codebase
 * that has to know the *complete* set of tables tied to User.id. A future
 * schema addition that adds a new userId column must be reflected here
 * or the merge silently loses data. Treat the merge stages below as the
 * canonical list — grep for `mergeFreshIntoRecovered` before adding a
 * new userId FK anywhere.
 *
 * On any throw inside the transaction, ROLLBACK runs and a Telegram
 * alert fires with the snapshot + stage + last-8-chars of both UUIDs.
 * The original error is re-thrown so the calling controller can return
 * a 'merge-rollback' failure to the client.
 */

export interface MergeSnapshot {
    receipts: number;
    baskets: number;
    shoppingLists: number;
    votes: number;
    interactions: number;
    productScores: number;
    equivalences: number;
    points: number;
}

export class MergeRollbackError extends Error {
    constructor(
        public stage: string,
        public snapshot: MergeSnapshot,
        public freshId: string,
        public recoveredId: string,
        public cause: Error,
    ) {
        super(`Merge rollback at stage="${stage}": ${cause.message}`);
        this.name = 'MergeRollbackError';
    }
}

/**
 * Returns the snapshot regardless of whether any merge happened. If
 * everything is zero the caller can skip the merge entirely.
 */
async function snapshotFreshCounts(conn: any, freshId: string): Promise<MergeSnapshot> {
    const [[receipts]]: any        = await conn.query('SELECT COUNT(*) AS n FROM Receipt WHERE userId = ?', [freshId]);
    const [[baskets]]: any         = await conn.query('SELECT COUNT(*) AS n FROM Basket WHERE userId = ?', [freshId]);
    const [[shoppingLists]]: any   = await conn.query('SELECT COUNT(*) AS n FROM ShoppingList WHERE userId = ?', [freshId]);
    const [[votes]]: any           = await conn.query('SELECT COUNT(*) AS n FROM StoreProductMatchVote WHERE userId = ?', [freshId]);
    const [[interactions]]: any    = await conn.query('SELECT COUNT(*) AS n FROM ProductInteraction WHERE userId = ?', [freshId]);
    const [[productScores]]: any   = await conn.query('SELECT COUNT(*) AS n FROM UserProductScore WHERE userId = ?', [freshId]);
    const [[equivalences]]: any    = await conn.query('SELECT COUNT(*) AS n FROM UserStoreProductEquivalence WHERE userId = ?', [freshId]);
    const [[pointsRow]]: any       = await conn.query('SELECT points FROM User WHERE id = ?', [freshId]);
    return {
        receipts:       Number(receipts.n),
        baskets:        Number(baskets.n),
        shoppingLists:  Number(shoppingLists.n),
        votes:          Number(votes.n),
        interactions:   Number(interactions.n),
        productScores:  Number(productScores.n),
        equivalences:   Number(equivalences.n),
        points:         Number(pointsRow?.points ?? 0),
    };
}

function hasAnyActivity(s: MergeSnapshot): boolean {
    return s.receipts > 0 || s.baskets > 0 || s.shoppingLists > 0 ||
           s.votes > 0 || s.interactions > 0 || s.productScores > 0 ||
           s.equivalences > 0 || s.points > 0;
}

/**
 * Public entry point. Returns the snapshot so the caller can use the counts
 * for analytics; throws `MergeRollbackError` on failure.
 */
export async function mergeFreshIntoRecovered(
    freshId: string,
    recoveredId: string,
    attemptId: number,
): Promise<MergeSnapshot> {
    if (freshId === recoveredId) {
        throw new Error(`mergeFreshIntoRecovered called with identical ids ${freshId}`);
    }

    const conn = await pool.getConnection();
    let stage = 'begin';
    let snapshot: MergeSnapshot | null = null;

    try {
        await conn.beginTransaction();

        stage = 'snapshot';
        snapshot = await snapshotFreshCounts(conn, freshId);

        // Fast path: nothing on the fresh side. Just delete the fresh User row.
        // No merge SQL, no Telegram noise — this is the common "user installed
        // and immediately tapped Atkurti" case.
        if (!hasAnyActivity(snapshot)) {
            stage = 'delete_fresh_user_fast_path';
            await conn.query('DELETE FROM User WHERE id = ?', [freshId]);
            await conn.commit();
            return snapshot;
        }

        // ── Group 1 — pure re-point ───────────────────────────────────────
        // No per-user uniqueness constraints, so a single UPDATE per table
        // is correct. Receipt's global (receiptNo, storeId, receiptDate)
        // unique key means fresh and recovered can never share a physical
        // receipt — the original INSERT would have been rejected — so we
        // don't need collision handling here either.
        stage = 're_point_basket';
        await conn.query('UPDATE Basket SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        stage = 're_point_shopping_list';
        await conn.query('UPDATE ShoppingList SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        stage = 're_point_receipt_line_issue';
        await conn.query('UPDATE ReceiptLineIssue SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        stage = 're_point_admin_review_flag';
        await conn.query('UPDATE AdminReviewFlag SET flaggedBy = ? WHERE flaggedBy = ?', [recoveredId, freshId]);

        stage = 're_point_failed_receipt_log';
        await conn.query('UPDATE FailedReceiptLog SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        stage = 're_point_product_interaction';
        await conn.query('UPDATE ProductInteraction SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        stage = 're_point_receipt';
        await conn.query('UPDATE Receipt SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        // ── Group 2 — collision-prone aggregates ──────────────────────────
        // Each table is handled in three sub-steps so the merge rule is
        // explicit per table:
        //   A. overwrite/sum recovered's row using fresh's row when both exist
        //   B. delete the fresh-side row that just got merged
        //   C. re-point any remaining (non-colliding) fresh rows to recovered

        // UserProductScore — PK (userId, productId), SUM on collision
        stage = 'merge_user_product_score';
        await conn.query(
            `UPDATE UserProductScore recv
                JOIN UserProductScore fr
                  ON fr.userId = ? AND fr.productId = recv.productId
                SET recv.score = recv.score + fr.score,
                    recv.interactionCount = recv.interactionCount + fr.interactionCount,
                    recv.updatedAt = NOW()
              WHERE recv.userId = ?`,
            [freshId, recoveredId],
        );
        await conn.query(
            `DELETE fr FROM UserProductScore fr
               JOIN UserProductScore recv
                 ON recv.userId = ? AND recv.productId = fr.productId
              WHERE fr.userId = ?`,
            [recoveredId, freshId],
        );
        await conn.query('UPDATE UserProductScore SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        // StoreProductMatchVote — unique (userId, spIdA, spIdB), newer updatedAt wins.
        // Column is `vote` (not `verdict`); table has no needsReverification.
        stage = 'merge_store_product_match_vote';
        await conn.query(
            `UPDATE StoreProductMatchVote recv
                JOIN StoreProductMatchVote fr
                  ON fr.userId = ?
                 AND fr.spIdA = recv.spIdA AND fr.spIdB = recv.spIdB
                 AND fr.updatedAt > recv.updatedAt
                SET recv.vote = fr.vote,
                    recv.dwellMs = fr.dwellMs,
                    recv.receiptId = fr.receiptId,
                    recv.updatedAt = fr.updatedAt
              WHERE recv.userId = ?`,
            [freshId, recoveredId],
        );
        await conn.query(
            `DELETE fr FROM StoreProductMatchVote fr
               JOIN StoreProductMatchVote recv
                 ON recv.userId = ?
                AND recv.spIdA = fr.spIdA AND recv.spIdB = fr.spIdB
              WHERE fr.userId = ?`,
            [recoveredId, freshId],
        );
        await conn.query('UPDATE StoreProductMatchVote SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        // UserStoreProductEquivalence — unique (userId, spIdA, spIdB), same rule
        stage = 'merge_user_store_product_equivalence';
        await conn.query(
            `UPDATE UserStoreProductEquivalence recv
                JOIN UserStoreProductEquivalence fr
                  ON fr.userId = ?
                 AND fr.spIdA = recv.spIdA AND fr.spIdB = recv.spIdB
                 AND fr.updatedAt > recv.updatedAt
                SET recv.verdict = fr.verdict,
                    recv.updatedAt = fr.updatedAt,
                    recv.needsReverification = fr.needsReverification
              WHERE recv.userId = ?`,
            [freshId, recoveredId],
        );
        await conn.query(
            `DELETE fr FROM UserStoreProductEquivalence fr
               JOIN UserStoreProductEquivalence recv
                 ON recv.userId = ?
                AND recv.spIdA = fr.spIdA AND recv.spIdB = fr.spIdB
              WHERE fr.userId = ?`,
            [recoveredId, freshId],
        );
        await conn.query('UPDATE UserStoreProductEquivalence SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        // ShoppingListMember — unique (listId, userId), prefer owner role on conflict
        stage = 'merge_shopping_list_member';
        await conn.query(
            `UPDATE ShoppingListMember recv
                JOIN ShoppingListMember fr
                  ON fr.userId = ? AND fr.listId = recv.listId AND fr.role = 'owner'
                SET recv.role = 'owner'
              WHERE recv.userId = ? AND recv.role = 'member'`,
            [freshId, recoveredId],
        );
        await conn.query(
            `DELETE fr FROM ShoppingListMember fr
               JOIN ShoppingListMember recv
                 ON recv.userId = ? AND recv.listId = fr.listId
              WHERE fr.userId = ?`,
            [recoveredId, freshId],
        );
        await conn.query('UPDATE ShoppingListMember SET userId = ? WHERE userId = ?', [recoveredId, freshId]);

        // ── Points sum ─────────────────────────────────────────────────────
        // Level is derived client-side from points (constants/levels.ts), so
        // summing here is enough — no separate level field to recompute.
        stage = 'sum_points';
        await conn.query(
            'UPDATE User SET points = points + ? WHERE id = ?',
            [snapshot.points, recoveredId],
        );

        // ── Delete fresh row ───────────────────────────────────────────────
        // FK cascades clean up anything left (Basket/ShoppingList CASCADE,
        // Receipt/Vote SET NULL — but we've already re-pointed those, so
        // nothing should actually cascade).
        stage = 'delete_fresh_user';
        await conn.query('DELETE FROM User WHERE id = ?', [freshId]);

        await conn.commit();
        return snapshot;
    } catch (err: any) {
        try { await conn.rollback(); } catch { /* nothing more to do */ }
        // Log the raw SQL error so the cause is visible in the server log
        // even after the MergeRollbackError wraps it (the wrap only carries
        // .message into the Telegram alert; full stack stays here).
        console.error(`[accountMerge] stage=${stage} failed:`, err);
        const wrapped = new MergeRollbackError(
            stage,
            snapshot ?? { receipts: -1, baskets: -1, shoppingLists: -1, votes: -1, interactions: -1, productScores: -1, equivalences: -1, points: -1 },
            freshId,
            recoveredId,
            err,
        );
        // Fire and forget; never let alerting failure mask the real error.
        sendRollbackAlert(wrapped, attemptId).catch(e =>
            console.error('[accountMerge] telegram alert failed:', e),
        );
        throw wrapped;
    } finally {
        conn.release();
    }
}

/**
 * Telegram payload for merge rollbacks. Goes through the shared
 * `notifyTelegram` helper so the `[DEV]` prefix is auto-applied on
 * non-prod backends.
 *
 * UUIDs are truncated to last 8 chars — enough to grep logs + AccountRecoveryAttempt
 * rows with, not enough to be useful as a recovery key for an attacker who
 * intercepts the channel.
 */
async function sendRollbackAlert(err: MergeRollbackError, attemptId: number): Promise<void> {
    const shortFresh = err.freshId.slice(-8);
    const shortRecovered = err.recoveredId.slice(-8);
    const s = err.snapshot;
    await notifyTelegram(
        `🚨 <b>Account merge rolled back</b>\n` +
        `Attempt: <code>${attemptId}</code>\n` +
        `Stage: <code>${err.stage}</code>\n` +
        `Error: <code>${escapeHtml(err.cause.message).slice(0, 300)}</code>\n` +
        `Fresh → Recovered: <code>…${shortFresh}</code> → <code>…${shortRecovered}</code>\n` +
        `\n` +
        `<b>Fresh-side snapshot</b>\n` +
        `📦 Receipts: ${s.receipts}\n` +
        `🧺 Baskets: ${s.baskets}\n` +
        `📝 Lists: ${s.shoppingLists}\n` +
        `🗳 Votes: ${s.votes}\n` +
        `👆 Interactions: ${s.interactions}\n` +
        `📊 Product scores: ${s.productScores}\n` +
        `🔗 Equivalences: ${s.equivalences}\n` +
        `⭐ Points: ${s.points}`,
    );
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, ch =>
        ch === '&' ? '&amp;' :
        ch === '<' ? '&lt;' :
        ch === '>' ? '&gt;' :
        ch === '"' ? '&quot;' : '&#39;'
    );
}
