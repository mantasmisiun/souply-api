import type { Connection } from 'mysql2/promise';
import pool from '../config/db.js';
import { createTrip, getTripMemberIds } from '../models/tripModel.js';
import { notifyUser } from './notificationService.js';

/**
 * Souply 2.0 Phase 4 — trip minting at PERSIST time. The backfill
 * (scripts/backfillTrips.ts) covered historical rows once; these helpers
 * keep every NEW basket / standalone list / ad-hoc receipt inside a trip
 * from the moment it exists. All idempotent: a row that already carries a
 * tripId is returned as-is, so double calls (retries, races) are safe.
 *
 * Linkage rules (spec):
 *   basket            → its own trip (the trip IS the shopping journey)
 *   list w/ basket    → inherits the basket's trip (a split's rows share it)
 *   standalone list   → its own trip
 *   receipt w/ list   → inherits the list's trip
 *   receipt w/o list  → AD-HOC list-less trip born at stage 5, scoreExempt
 *                       ("neplanuotas" — a single upload barely moves the
 *                       planning score; it never contributes to the dot
 *                       because stage 5 doesn't).
 */

export const ensureTripForBasket = async (
    basketId: number,
    userId: string,
    conn?: Connection,
): Promise<number> => {
    const db = (conn ?? pool) as any;
    const [rows]: any = await db.query('SELECT tripId FROM Basket WHERE id = ?', [basketId]);
    const existing = rows[0]?.tripId;
    if (existing != null) return existing;
    const tripId = await createTrip(userId, {}, conn);
    await db.query('UPDATE Basket SET tripId = ? WHERE id = ? AND tripId IS NULL', [tripId, basketId]);
    // Idempotency under a race: someone else linked first → use theirs.
    const [after]: any = await db.query('SELECT tripId FROM Basket WHERE id = ?', [basketId]);
    return after[0]?.tripId ?? tripId;
};

export const ensureTripForList = async (
    listId: number,
    userId: string,
    basketId: number | null | undefined,
    conn?: Connection,
): Promise<number> => {
    const db = (conn ?? pool) as any;
    const [rows]: any = await db.query('SELECT tripId FROM ShoppingList WHERE id = ?', [listId]);
    const existing = rows[0]?.tripId;
    if (existing != null) return existing;
    const tripId = basketId != null
        ? await ensureTripForBasket(basketId, userId, conn)
        : await createTrip(userId, {}, conn);
    await db.query('UPDATE ShoppingList SET tripId = ? WHERE id = ? AND tripId IS NULL', [tripId, listId]);
    const [after]: any = await db.query('SELECT tripId FROM ShoppingList WHERE id = ?', [listId]);
    return after[0]?.tripId ?? tripId;
};

export const ensureTripForReceipt = async (
    receiptId: number,
    userId: string,
    shoppingListId: number | null | undefined,
    conn?: Connection,
): Promise<number> => {
    const db = (conn ?? pool) as any;
    const [rows]: any = await db.query('SELECT tripId FROM Receipt WHERE id = ?', [receiptId]);
    const existing = rows[0]?.tripId;
    if (existing != null) return existing;

    let tripId: number | null = null;
    if (shoppingListId != null) {
        const [lists]: any = await db.query('SELECT id, tripId, basketId, userId FROM ShoppingList WHERE id = ?', [shoppingListId]);
        const list = lists[0];
        if (list) {
            // The list's OWNER anchors the trip (a member scanning for a shared
            // list attaches to the owner's trip, not a fresh one of their own).
            tripId = list.tripId ?? await ensureTripForList(list.id, list.userId ?? userId, list.basketId, conn);
        }
    }
    if (tripId == null) {
        // Ad-hoc: list-less trip born at stage 5 — "neplanuotas".
        tripId = await createTrip(userId, { isAdHoc: true, scoreExempt: true }, conn);
    }
    await db.query(
        'UPDATE Receipt SET tripId = ?, uploaderUserId = COALESCE(uploaderUserId, ?) WHERE id = ? AND tripId IS NULL',
        [tripId, userId, receiptId],
    );
    const [after]: any = await db.query('SELECT tripId FROM Receipt WHERE id = ?', [receiptId]);
    return after[0]?.tripId ?? tripId;
};

/**
 * Re-point a receipt at ITS LIST's trip (the upload → link flow: the bare
 * OCR create minted an ad-hoc trip; the link endpoint moves the receipt to
 * the list's trip and garbage-collects the now-empty ad-hoc one).
 */
export const relinkReceiptToListTrip = async (receiptId: number, listId: number): Promise<void> => {
    const [receipts]: any = await pool.query('SELECT tripId, userId FROM Receipt WHERE id = ?', [receiptId]);
    const receipt = receipts[0];
    if (!receipt) return;
    const [lists]: any = await pool.query('SELECT id, tripId, basketId, userId FROM ShoppingList WHERE id = ?', [listId]);
    const list = lists[0];
    if (!list) return;
    const listTrip = list.tripId ?? await ensureTripForList(list.id, list.userId ?? receipt.userId, list.basketId);
    const oldTrip = receipt.tripId;
    if (oldTrip === listTrip) return;
    await pool.query('UPDATE Receipt SET tripId = ? WHERE id = ?', [listTrip, receiptId]);
    // Trip members (minus the uploader) hear the slot close — fire-and-forget.
    void (async () => {
        try {
            const members = await getTripMemberIds(listTrip);
            for (const m of members) {
                if (m === receipt.userId) continue;
                await notifyUser(m, 'trip_receipt_in', {
                    title: 'Kvitas įkeltas',
                    body: 'Apsipirkimo kvitas jau įkeltas.',
                    route: `/trip/${listTrip}`,
                });
            }
        } catch {}
    })();
    if (oldTrip != null) {
        // GC the churn ad-hoc trip if nothing else references it.
        const [[t]]: any = await pool.query('SELECT isAdHoc FROM Trip WHERE id = ?', [oldTrip]);
        if (t?.isAdHoc) {
            const [[refs]]: any = await pool.query(
                `SELECT (SELECT COUNT(*) FROM Receipt WHERE tripId = ?)
                      + (SELECT COUNT(*) FROM ShoppingList WHERE tripId = ?)
                      + (SELECT COUNT(*) FROM Basket WHERE tripId = ?) AS n`,
                [oldTrip, oldTrip, oldTrip]);
            if (Number(refs.n) === 0) {
                await pool.query('DELETE FROM TripMember WHERE tripId = ?', [oldTrip]);
                await pool.query('DELETE FROM Trip WHERE id = ?', [oldTrip]);
            }
        }
    }
};
