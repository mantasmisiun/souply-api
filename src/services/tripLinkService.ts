import type { Connection } from 'mysql2/promise';
import pool from '../config/db.js';
import { createTrip, getTripMemberIds } from '../models/tripModel.js';
import { notifyUser } from './notificationService.js';
import { fishListForLinkedReceipt } from './listScopedMatcher.js';

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
        // Ad-hoc: list-less trip born at stage 5 — "neplanuotas". NOT scoreExempt
        // (that's for historic backfill): an ad-hoc trip flows through the planning
        // score and is judged purely on store choice (planningScoreService).
        tripId = await createTrip(userId, { isAdHoc: true, scoreExempt: false }, conn);
    }
    await db.query(
        'UPDATE Receipt SET tripId = ?, uploaderUserId = COALESCE(uploaderUserId, ?) WHERE id = ? AND tripId IS NULL',
        [tripId, userId, receiptId],
    );
    const [after]: any = await db.query('SELECT tripId FROM Receipt WHERE id = ?', [receiptId]);
    return after[0]?.tripId ?? tripId;
};

/**
 * "Receipt is now visible to the trip" notification — fired on PUBLISH, not on
 * link. Notifies every trip member EXCEPT the uploader, deep-linking to the
 * Kvitai screen (/trip/receipts/:tripId). Title carries the uploader's display
 * name ("<name> įkėlė kvitą"); body is the store name when handy. Fire-and-
 * forget at the call site; each notifyUser writes the inbox row + Expo push.
 */
export const notifyTripReceiptPublished = async (receiptId: number): Promise<void> => {
    const [rows]: any = await pool.query(
        `SELECT r.tripId, COALESCE(r.uploaderUserId, r.userId) AS uploaderId, s.name AS storeName
           FROM Receipt r LEFT JOIN Store s ON s.id = r.storeId
          WHERE r.id = ?`,
        [receiptId],
    );
    const receipt = rows[0];
    if (!receipt || receipt.tripId == null) return;
    const tripId = Number(receipt.tripId);
    const uploaderId: string | null = receipt.uploaderId ?? null;
    let uploaderName: string | null = null;
    if (uploaderId) {
        const [[u]]: any = await pool.query(
            'SELECT COALESCE(displayName, firstName, username) AS label FROM User WHERE id = ?', [uploaderId]);
        uploaderName = (u?.label ?? null) as string | null;
    }
    const title = uploaderName ? `${uploaderName} įkėlė kvitą` : 'Naujas kvitas kelionėje';
    const body = receipt.storeName ? String(receipt.storeName) : 'Apsipirkimo kvitas jau įkeltas.';
    const members = await getTripMemberIds(tripId);
    for (const m of members) {
        if (uploaderId && m === uploaderId) continue;
        await notifyUser(m, 'trip_receipt_in', { title, body, route: `/trip/receipts/${tripId}` });
    }
};

/**
 * Re-point a receipt at ITS LIST's trip (the upload → link flow: the bare
 * OCR create minted an ad-hoc trip; the link endpoint moves the receipt to
 * the list's trip and garbage-collects the now-empty ad-hoc one).
 */
export const relinkReceiptToListTrip = async (receiptId: number, listId: number): Promise<void> => {
    const [receipts]: any = await pool.query(
        'SELECT tripId, userId, mandatorySwipesRequired, mandatorySwipesCompleted FROM Receipt WHERE id = ?', [receiptId]);
    const receipt = receipts[0];
    if (!receipt) return;
    const [lists]: any = await pool.query('SELECT id, tripId, basketId, userId FROM ShoppingList WHERE id = ?', [listId]);
    const list = lists[0];
    if (!list) return;
    // List-narrowing: the receipt now carries this list's shoppingListId (set by
    // linkReceiptToList just before every call to this fn), so the list's products can
    // BOOST the receipt's still-unlinked lines. Fire-and-forget + fail-open: it must
    // never block or break linking, and runs regardless of the trip-state early-returns
    // below. Additive only — never auto-links, never filters existing candidates.
    void fishListForLinkedReceipt(receiptId, listId).catch(() => {});
    const listTrip = list.tripId ?? await ensureTripForList(list.id, list.userId ?? receipt.userId, list.basketId);
    const oldTrip = receipt.tripId;
    if (oldTrip === listTrip) return;
    await pool.query('UPDATE Receipt SET tripId = ? WHERE id = ?', [listTrip, receiptId]);
    // NO-QUEUE case only: a receipt with mandatorySwipesRequired = 0 is PUBLISHED
    // the moment it lands on the trip, so notify members here. Receipts that still
    // have a mandatory queue stay pending — their notification fires on swipe
    // completion (see markSwipesDone), so we never double-notify.
    const req = Number(receipt.mandatorySwipesRequired ?? 0);
    const comp = Number(receipt.mandatorySwipesCompleted ?? 0);
    if (req === 0 || comp >= req) {
        void notifyTripReceiptPublished(receiptId).catch(() => {});
    }
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
