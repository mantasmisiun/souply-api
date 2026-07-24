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

export interface TripMemberPreview { initial: string; color: string | null; }

export interface TripSummary {
    id: number;
    /** Trip owner/creator user id — the client uses it to decide who may
     *  moderate (detach any member's receipt). Sourced from Trip.createdByUserId. */
    ownerUserId: string;
    name: string | null;
    isAdHoc: boolean;
    scoreExempt: boolean;
    archivedAt: string | null;
    createdAt: string;
    stage: TripStage;
    memberCount: number;
    /** Member avatar previews (owner first) for the shared-card circles. */
    members: TripMemberPreview[];
    /** Best-known shopping date (receipt date > list creation > trip creation)
     *  — the calendar-dot anchor per the spec. */
    anchorDate: string;
    basket: {
        id: number; status: string; itemCount: number;
        /** User-given basket name (null = untitled, cards show the date). */
        name: string | null;
        /** Newest-first item-name preview (max 5) — card subtitle rows. */
        itemPreview: string[];
    } | null;
    slots: TripSlotSummary[];
    receiptCount: number;
    /** Total parsed lines across the trip's receipts (all ReceiptItem rows). */
    recognisedItemCount: number;
    /** Unique chains involved (planned + receipt), each flagged whether a receipt
     *  for it exists — drives the card's logo strip (full colour vs dimmed). */
    chains: { chainId: number; chainName: string | null; hasReceipt: boolean }[];
}

export const listTripsForUser = async (userId: string, locale: Locale = 'lt', limit = 100): Promise<TripSummary[]> => {
    const [trips]: any = await pool.query(
        // Active first, then by ANCHOR date desc: a trip with receipts sorts by
        // its (latest) receipt date — so an uploaded OLD receipt sinks to the
        // bottom (just above the archive) — while a still-planning trip sorts by
        // last edit (updatedAt). Mirrors the anchorDate computed per row below.
        `SELECT t.* FROM Trip t
          JOIN TripMember tm ON tm.tripId = t.id
         WHERE tm.userId = ?
         ORDER BY (t.archivedAt IS NULL) DESC,
                  COALESCE(
                      (SELECT MAX(r.receiptDate) FROM Receipt r
                        WHERE r.tripId = t.id AND r.userDeletedAt IS NULL),
                      t.updatedAt
                  ) DESC
         LIMIT ?`,
        [userId, limit],
    );
    if (trips.length === 0) return [];
    const ids = trips.map((t: any) => t.id);

    // Members with their avatar identity (owner first) — powers the stacked
    // avatar circles on shared cards. Count derives from the same rows.
    // Two queries (not a JOIN) — joining User.id to TripMember.userId trips a
    // MariaDB "illegal mix of collations" on the CI schema. Owner-first ordering
    // is done in JS (comparing role to a literal in SQL has the same issue).
    const [memberRows]: any = await pool.query(
        'SELECT tripId, userId, role FROM TripMember WHERE tripId IN (?) ORDER BY joinedAt', [ids]);
    const memberUserIds = [...new Set(memberRows.map((m: any) => m.userId))];
    const userById = new Map<string, { label: string | null; avatarColor: string | null }>();
    if (memberUserIds.length) {
        const [users]: any = await pool.query(
            'SELECT id, COALESCE(displayName, firstName, username) AS label, avatarColor FROM User WHERE id IN (?)',
            [memberUserIds]);
        for (const u of users) userById.set(u.id, { label: u.label ?? null, avatarColor: u.avatarColor ?? null });
    }
    const memberCountByTrip = new Map<number, number>();
    const rawByTrip = new Map<number, any[]>();
    for (const m of memberRows) {
        memberCountByTrip.set(m.tripId, (memberCountByTrip.get(m.tripId) ?? 0) + 1);
        const arr = rawByTrip.get(m.tripId) ?? [];
        arr.push(m);
        rawByTrip.set(m.tripId, arr);
    }
    const membersByTrip = new Map<number, TripMemberPreview[]>();
    for (const [tripId, arr] of rawByTrip) {
        const ordered = [...arr].sort((a, b) => (b.role === 'owner' ? 1 : 0) - (a.role === 'owner' ? 1 : 0));
        membersByTrip.set(tripId, ordered.map(m => {
            const u = userById.get(m.userId);
            const ch = String(u?.label ?? '').trim().replace(/^@/, '').charAt(0);
            return { initial: ch ? ch.toUpperCase() : '?', color: u?.avatarColor ?? null };
        }));
    }

    const [baskets]: any = await pool.query(
        `SELECT b.tripId, b.id, b.status, b.name, b.hasBeenCalculated,
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
                (SELECT COUNT(*) FROM Receipt r WHERE r.shoppingListId = sl.id AND r.userDeletedAt IS NULL
                    AND (COALESCE(r.uploaderUserId, r.userId) = ?
                         OR r.mandatorySwipesRequired = 0 OR r.mandatorySwipesCompleted >= r.mandatorySwipesRequired)) AS receiptCount
           FROM ShoppingList sl
           LEFT JOIN Store s ON s.id = sl.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE sl.tripId IN (?)`,
        [userId, ids]);
    const listsByTrip = new Map<number, any[]>();
    for (const l of lists) {
        const arr = listsByTrip.get(l.tripId) ?? [];
        arr.push(l);
        listsByTrip.set(l.tripId, arr);
    }

    const [receipts]: any = await pool.query(
        `SELECT r.tripId, COUNT(DISTINCT r.id) AS n, MAX(r.receiptDate) AS lastDate,
                COUNT(ri.id) AS recognisedItemCount
           FROM Receipt r
           LEFT JOIN ReceiptItem ri ON ri.receiptId = r.id
          WHERE r.tripId IN (?) AND r.userDeletedAt IS NULL
             AND (COALESCE(r.uploaderUserId, r.userId) = ?
                  OR r.mandatorySwipesRequired = 0 OR r.mandatorySwipesCompleted >= r.mandatorySwipesRequired)
          GROUP BY r.tripId`,
        [ids, userId]);
    const receiptAggByTrip = new Map<number, any>(receipts.map((r: any) => [r.tripId, r]));

    // Chains the trip's RECEIPTS came from (via each receipt's resolved store) —
    // needed for the card's logo strip on ad-hoc/receipt-only trips, which have no
    // shopping-list slots to read chains from.
    const [rcChains]: any = await pool.query(
        `SELECT DISTINCT r.tripId, s.chainId, sc.name AS chainName
           FROM Receipt r
           JOIN Store s ON s.id = r.storeId
           JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.tripId IN (?) AND r.userDeletedAt IS NULL AND s.chainId IS NOT NULL
            AND (COALESCE(r.uploaderUserId, r.userId) = ?
                 OR r.mandatorySwipesRequired = 0 OR r.mandatorySwipesCompleted >= r.mandatorySwipesRequired)`,
        [ids, userId]);
    const receiptChainsByTrip = new Map<number, { chainId: number; chainName: string | null }[]>();
    for (const rc of rcChains) {
        const arr = receiptChainsByTrip.get(rc.tripId) ?? [];
        arr.push({ chainId: rc.chainId, chainName: rc.chainName ?? null });
        receiptChainsByTrip.set(rc.tripId, arr);
    }

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
            ownerUserId: t.createdByUserId,
            name: t.name ?? null,
            isAdHoc: !!t.isAdHoc,
            scoreExempt: !!t.scoreExempt,
            archivedAt: t.archivedAt ?? null,
            createdAt: t.createdAt,
            stage,
            memberCount: memberCountByTrip.get(t.id) ?? 1,
            members: membersByTrip.get(t.id) ?? [],
            anchorDate,
            basket: basket ? {
                id: basket.id, status: basket.status, itemCount: Number(basket.itemCount) || 0,
                name: basket.name ?? null,
                itemPreview: typeof basket.itemPreview === 'string' && basket.itemPreview.length > 0
                    ? basket.itemPreview.split('~|~')
                    : [],
            } : null,
            slots,
            receiptCount: Number(receiptAgg?.n) || 0,
            // ALL parsed lines across the trip's receipts (what the parser recognised) —
            // drives the receipt-icon badge count on the shopping card.
            recognisedItemCount: Number(receiptAgg?.recognisedItemCount) || 0,
            // Unique chains for the card's logo strip: planned (list) chains + receipt
            // chains, merged; hasReceipt=true when ANY source for that chain has one
            // (full-colour logo) — planned-only chains render dimmed.
            chains: (() => {
                const m = new Map<number, { chainId: number; chainName: string | null; hasReceipt: boolean }>();
                for (const s of slots) {
                    if (s.chainId == null) continue;
                    const ex = m.get(s.chainId);
                    m.set(s.chainId, { chainId: s.chainId, chainName: s.chainName ?? ex?.chainName ?? null, hasReceipt: (ex?.hasReceipt ?? false) || s.hasReceipt });
                }
                for (const rc of receiptChainsByTrip.get(t.id) ?? []) {
                    const ex = m.get(rc.chainId);
                    m.set(rc.chainId, { chainId: rc.chainId, chainName: rc.chainName ?? ex?.chainName ?? null, hasReceipt: true });
                }
                return [...m.values()];
            })(),
        };
    });
};
