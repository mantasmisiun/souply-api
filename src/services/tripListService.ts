import pool from '../config/db.js';
import { itemPreviewSql } from '../models/basketModel.js';
import type { Locale } from '../middleware/locale.js';
import { deriveTripStage, type TripSlotFacts, type TripStage } from './tripStageService.js';

/**
 * Souply 2.0 Phase 4 — the Apsipirkimai tab's trip list, batched (no
 * per-trip N+1: five IN-list queries total regardless of trip count).
 * Stage is DERIVED here per trip from the same facts contract as
 * tripStageService.getTripStageFacts, just assembled in bulk.
 */

export interface TripSlotSummary {
    listId: number;
    storeId: number;
    storeName: string | null;
    chainName: string | null;
    chainId: number | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    listStatus: 'active' | 'completed';
    hasReceipt: boolean;
    receiptSkipped: boolean;
    /** Checked/total items for the stage-3 progress pills ("2/10"). */
    checkedCount: number;
    itemCount: number;
}

export interface TripSummary {
    id: number;
    name: string | null;
    isAdHoc: boolean;
    scoreExempt: boolean;
    archivedAt: string | null;
    createdAt: string;
    stage: TripStage;
    memberCount: number;
    /** Best-known shopping date (receipt date > list creation > trip creation)
     *  — the calendar-dot anchor per the spec. */
    anchorDate: string;
    basket: {
        id: number; status: string; itemCount: number;
        /** Newest-first item-name preview (max 5) — card subtitle rows. */
        itemPreview: string[];
    } | null;
    slots: TripSlotSummary[];
    receiptCount: number;
}

export const listTripsForUser = async (userId: string, locale: Locale = 'lt', limit = 100): Promise<TripSummary[]> => {
    const [trips]: any = await pool.query(
        `SELECT t.* FROM Trip t
          JOIN TripMember tm ON tm.tripId = t.id
         WHERE tm.userId = ?
         ORDER BY (t.archivedAt IS NULL) DESC, t.updatedAt DESC
         LIMIT ?`,
        [userId, limit],
    );
    if (trips.length === 0) return [];
    const ids = trips.map((t: any) => t.id);

    const [members]: any = await pool.query(
        'SELECT tripId, COUNT(*) AS n FROM TripMember WHERE tripId IN (?) GROUP BY tripId', [ids]);
    const memberCountByTrip = new Map<number, number>(members.map((m: any) => [m.tripId, Number(m.n)]));

    const [baskets]: any = await pool.query(
        `SELECT b.tripId, b.id, b.status, b.hasBeenCalculated,
                (SELECT COUNT(*) FROM BasketItem bi WHERE bi.basketId = b.id) AS itemCount,
                ${itemPreviewSql(locale, 'b.id')} AS itemPreview
           FROM Basket b WHERE b.tripId IN (?)`,
        [ids]);
    const basketByTrip = new Map<number, any>(baskets.map((b: any) => [b.tripId, b]));

    const [lists]: any = await pool.query(
        `SELECT sl.tripId, sl.id, sl.storeId, sl.status, sl.receiptSkippedAt, sl.createdAt,
                s.name AS storeName, s.address, s.latitude, s.longitude, s.chainId,
                sc.name AS chainName,
                (SELECT COUNT(*) FROM ShoppingListItem sli WHERE sli.listId = sl.id) AS itemCount,
                (SELECT COUNT(*) FROM ShoppingListItem sli WHERE sli.listId = sl.id AND sli.isChecked = 1) AS checkedCount,
                (SELECT COUNT(*) FROM Receipt r WHERE r.shoppingListId = sl.id) AS receiptCount
           FROM ShoppingList sl
           LEFT JOIN Store s ON s.id = sl.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE sl.tripId IN (?)`,
        [ids]);
    const listsByTrip = new Map<number, any[]>();
    for (const l of lists) {
        const arr = listsByTrip.get(l.tripId) ?? [];
        arr.push(l);
        listsByTrip.set(l.tripId, arr);
    }

    const [receipts]: any = await pool.query(
        `SELECT tripId, COUNT(*) AS n, MAX(receiptDate) AS lastDate
           FROM Receipt WHERE tripId IN (?) GROUP BY tripId`,
        [ids]);
    const receiptAggByTrip = new Map<number, any>(receipts.map((r: any) => [r.tripId, r]));

    return trips.map((t: any): TripSummary => {
        const basket = basketByTrip.get(t.id) ?? null;
        const tripLists = listsByTrip.get(t.id) ?? [];
        const receiptAgg = receiptAggByTrip.get(t.id);

        const slots: TripSlotSummary[] = tripLists.map((l: any) => ({
            listId: l.id,
            storeId: l.storeId,
            storeName: l.storeName ?? null,
            chainName: l.chainName ?? null,
            chainId: l.chainId ?? null,
            address: l.address ?? null,
            latitude: l.latitude != null ? Number(l.latitude) : null,
            longitude: l.longitude != null ? Number(l.longitude) : null,
            listStatus: l.status === 'completed' ? 'completed' : 'active',
            hasReceipt: Number(l.receiptCount) > 0,
            receiptSkipped: l.receiptSkippedAt != null,
            checkedCount: Number(l.checkedCount) || 0,
            itemCount: Number(l.itemCount) || 0,
        }));

        const stageFactsSlots: TripSlotFacts[] = slots.map(s => ({
            listStatus: s.listStatus,
            hasReceipt: s.hasReceipt,
            receiptSkipped: s.receiptSkipped,
        }));
        const stage = deriveTripStage({
            isAdHoc: !!t.isAdHoc,
            basketCalculated: !!(basket && (basket.hasBeenCalculated || basket.status !== 'draft')),
            slots: stageFactsSlots,
        });

        const anchorDate: string = receiptAgg?.lastDate
            ?? tripLists.reduce((max: string | null, l: any) => (max == null || l.createdAt > max ? l.createdAt : max), null)
            ?? t.createdAt;

        return {
            id: t.id,
            name: t.name ?? null,
            isAdHoc: !!t.isAdHoc,
            scoreExempt: !!t.scoreExempt,
            archivedAt: t.archivedAt ?? null,
            createdAt: t.createdAt,
            stage,
            memberCount: memberCountByTrip.get(t.id) ?? 1,
            anchorDate,
            basket: basket ? {
                id: basket.id, status: basket.status, itemCount: Number(basket.itemCount) || 0,
                itemPreview: typeof basket.itemPreview === 'string' && basket.itemPreview.length > 0
                    ? basket.itemPreview.split('~|~')
                    : [],
            } : null,
            slots,
            receiptCount: Number(receiptAgg?.n) || 0,
        };
    });
};
