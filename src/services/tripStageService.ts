/**
 * Souply 2.0 — derived trip stages (spec: shared/SOUPLY_2.0_SPEC.md).
 *
 * Stages are NEVER stored. They derive from per-store slot facts, following
 * the basketTemplateService isAbandoned/isResumable pattern: pure function
 * over write-once-ish facts, so there is no state machine to corrupt and the
 * v1.x Basket.status writers can coexist during the transition.
 *
 *   1  basket forming            (no store search yet)
 *   2  store search done         (basket compared, no lists yet)
 *   3  list(s) created, shopping (any slot's list not completed)
 *   4  all lists completed, some receipt slot open (no receipt, not skipped)
 *   5  every slot filled or skipped  (or an ad-hoc/list-less trip)
 *
 * PER-STORE MINI-CYCLES (decision 2026-07-16): a completed slot's receipt can
 * be uploaded while another slot is still shoppable — so stage 3 vs 4 is a
 * trip-level summary only; slot-level UI must consult the slots directly.
 */

export interface TripSlotFacts {
    /** ShoppingList.status for this (trip, store) slot. */
    listStatus: 'active' | 'completed';
    /** A receipt is attached to this trip with this slot's storeId. */
    hasReceipt: boolean;
    /** "Nepirkau čia" — slot explicitly closed without a receipt. */
    receiptSkipped: boolean;
    /** Every item on this slot's list was bought SOMEWHERE on this trip (see
     *  slotCoverage). Products are what "done" means; the store slot is the
     *  plan — buying the IKI list at Maxima fulfils it just as well. */
    itemsCovered?: boolean;
}

export interface TripStageFacts {
    isAdHoc: boolean;
    /** Basket exists and has been calculated (store search ran). */
    basketCalculated: boolean;
    /** One entry per (trip, store) slot; empty = no lists yet. */
    slots: TripSlotFacts[];
    /** Receipts attached to the trip beyond the planned slots ("papildomas"). */
    extraReceiptCount?: number;
}

export type TripStage = 1 | 2 | 3 | 4 | 5;

/** A slot is CLOSED when its receipt arrived, its items were bought anywhere on
 *  this trip, or the user skipped it. */
export const slotClosed = (s: TripSlotFacts): boolean =>
    s.hasReceipt || s.receiptSkipped || s.itemsCovered === true;

export function deriveTripStage(f: TripStageFacts): TripStage {
    // Ad-hoc trips are born terminal: receipts without a plan.
    if (f.isAdHoc) return 5;

    if (f.slots.length === 0) {
        // No lists yet: forming vs searched is the basket's calc flag.
        return f.basketCalculated ? 2 : 1;
    }

    const allListsCompleted = f.slots.every((s) => s.listStatus === 'completed');
    if (!allListsCompleted) return 3;

    const allSlotsClosed = f.slots.every(slotClosed);
    return allSlotsClosed ? 5 : 4;
}

/** Trips in stages 1–4 and not archived drive the tab's notification dot. */
export function contributesToDot(stage: TripStage, archivedAt: Date | string | null): boolean {
    return archivedAt == null && stage < 5;
}

/**
 * Auto-archive thresholds (hours of inactivity) by stage:
 * forming/searched trips go quickly (48 h), planned trips linger (7 d).
 * Stage 5 never auto-archives — it's history, not a nag.
 */
export function autoArchiveAfterHours(stage: TripStage): number | null {
    if (stage <= 2) return 48;
    if (stage <= 4) return 7 * 24;
    return null;
}
