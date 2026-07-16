/**
 * Souply 2.0 Phase 1a — backfill existing Baskets / ShoppingLists / Receipts
 * into Trip aggregates. IDEMPOTENT: every pass only touches rows with
 * tripId IS NULL, so re-runs are safe and partial failures resume cleanly.
 *
 * Rules (decisions 2026-07-16, shared/SOUPLY_2.0_SPEC.md):
 *   1. One Trip per Basket (trip inherits userId + createdAt; archived when
 *      the basket is terminal so old drafts don't flood the dot).
 *   2. Standalone lists (no basket) → one Trip each.
 *   3. Orphan receipts (no list link) → one AD-HOC Trip per receipt,
 *      scoreExempt=1 (historic uploads never count against planning score),
 *      born archived (history, not a nag).
 *   4. Every receipt gets uploaderUserId = its userId.
 *
 * Run: npm run backfill:trips   (dev → staging → prod, after trip_foundation.sql)
 */
import '../config/env.js';
import pool from '../config/db.js';
import { createTrip } from '../models/tripModel.js';

const run = async () => {
    let created = 0;

    // ── 1. Baskets → trips ────────────────────────────────────────────────
    const [baskets]: any = await pool.query(
        `SELECT id, userId, name, status, createdAt FROM Basket WHERE tripId IS NULL`);
    for (const b of baskets) {
        const terminal = b.status === 'completed';
        const tripId = await createTrip(b.userId, {
            name: b.name ?? null,
            createdAt: b.createdAt,
            archivedAt: terminal ? b.createdAt : null,
        });
        await pool.query('UPDATE Basket SET tripId = ? WHERE id = ?', [tripId, b.id]);
        // The basket's split lists join the same trip…
        await pool.query('UPDATE ShoppingList SET tripId = ? WHERE basketId = ? AND tripId IS NULL', [tripId, b.id]);
        // …and every receipt linked to those lists.
        await pool.query(
            `UPDATE Receipt r JOIN ShoppingList sl ON r.shoppingListId = sl.id
             SET r.tripId = ? WHERE sl.basketId = ? AND r.tripId IS NULL`,
            [tripId, b.id],
        );
        created++;
    }

    // ── 2. Standalone lists (claimed/shared or legacy) → one trip each ───
    const [lists]: any = await pool.query(
        `SELECT id, userId, createdAt, status FROM ShoppingList WHERE tripId IS NULL`);
    for (const l of lists) {
        const tripId = await createTrip(l.userId, {
            createdAt: l.createdAt,
            archivedAt: l.status === 'completed' ? l.createdAt : null,
        });
        await pool.query('UPDATE ShoppingList SET tripId = ? WHERE id = ?', [tripId, l.id]);
        await pool.query(
            'UPDATE Receipt SET tripId = ? WHERE shoppingListId = ? AND tripId IS NULL',
            [tripId, l.id],
        );
        created++;
    }

    // ── 3. Orphan receipts → ad-hoc trips (born archived, score-exempt) ──
    // Receipt has NO createdAt column (prod schema) — receiptDate is the only
    // timestamp; fall back to NOW() via null when even that is missing.
    const [orphans]: any = await pool.query(
        `SELECT id, userId, receiptDate FROM Receipt WHERE tripId IS NULL`);
    for (const r of orphans) {
        const anchor = r.receiptDate ?? null;
        const tripId = await createTrip(r.userId, {
            isAdHoc: true,
            scoreExempt: true,
            createdAt: anchor,
            archivedAt: anchor,
        });
        await pool.query('UPDATE Receipt SET tripId = ? WHERE id = ?', [tripId, r.id]);
        created++;
    }

    // ── 4. uploaderUserId = historical uploader ──────────────────────────
    const [upd]: any = await pool.query(
        'UPDATE Receipt SET uploaderUserId = userId WHERE uploaderUserId IS NULL');

    console.log(`[backfillTrips] trips created: ${created} (baskets=${baskets.length}, lists=${lists.length}, orphanReceipts=${orphans.length}); uploaderUserId set on ${upd.affectedRows} receipts`);
    process.exit(0);
};

run().catch((e) => { console.error('[backfillTrips] FAILED:', e); process.exit(1); });
