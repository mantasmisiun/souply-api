import pool from '../config/db.js';

/**
 * Souply 2.0 planning score (spec: Stage 5 / Planavimo balas).
 *
 *   score = round(100 · (0.4·coverage + 0.4·discipline + 0.2·precision)) − penalties
 *
 *   coverage   = matched list items ÷ list items          (did you buy the plan?)
 *   discipline = matched receipt spend ÷ total spend      (€-weighted: a €15
 *                impulse hurts more than a €0.30 snack)
 *   precision  = quantity accuracy on matched pairs       (min/max of qty)
 *
 * AUTO pairs: list item and receipt line resolve to the SAME productId
 * (list side: ShoppingListItem.productId or its storeProductId's product;
 * receipt side: ReceiptItem.matchedSpId's product). MANUAL pairs come from
 * TripLineLink (kind='manual', crediting 0.9 of an auto pair); an auto pair
 * the user disconnected is stored as kind='suppressed' and excluded.
 *
 * Penalties: ad-hoc trips score a fixed mild negative (they have no plan to
 * measure — sustained ad-hoc-only behaviour drags the monthly score, a single
 * upload barely moves it). scoreExempt trips (historic backfill) return null.
 */

const MANUAL_CREDIT = 0.9;
export const AD_HOC_SCORE = 25; // fixed mild score for unplanned trips

export interface PlanningPair {
    listItemId: number;
    receiptItemId: number;
    source: 'auto' | 'manual';
    productName: string | null;
    listQty: number;
    receiptQty: number;
    /** Predicted (list) vs actual (receipt) TOTAL for this matched item — feeds
     *  the prediction-accuracy metric. listPrice is null when the list item has
     *  no calculated price. */
    listPrice: number | null;
    receiptPrice: number;
}

export interface PlanningScore {
    tripId: number;
    /** null = not scoreable (scoreExempt, or no lists AND no receipts). */
    score: number | null;
    coverage: number;
    discipline: number;
    precision: number;
    isAdHoc: boolean;
    scoreExempt: boolean;
    listItemCount: number;
    matchedListItemCount: number;
    /** Prediction accuracy basis: summed predicted (list) vs actual (receipt)
     *  totals over matched items THAT HAD a list price. null = no priced matches
     *  (or ad-hoc) → the client hides the prediction card. */
    predictedMatchedTotal: number | null;
    actualMatchedTotal: number | null;
    pairs: PlanningPair[];
    /** Unmatched list items (id + name) — the manual-link UI's left column. */
    unmatchedListItems: { listItemId: number; name: string | null; productId: number | null }[];
    /** Unmatched receipt lines — the manual-link UI's right column. */
    unmatchedReceiptItems: { receiptItemId: number; name: string; productId: number | null }[];
}

export const computePlanningScore = async (tripId: number): Promise<PlanningScore> => {
    const [[trip]]: any = await pool.query('SELECT isAdHoc, scoreExempt FROM Trip WHERE id = ?', [tripId]);
    const base: PlanningScore = {
        tripId, score: null, coverage: 0, discipline: 0, precision: 0,
        isAdHoc: !!trip?.isAdHoc, scoreExempt: !!trip?.scoreExempt,
        listItemCount: 0, matchedListItemCount: 0,
        predictedMatchedTotal: null, actualMatchedTotal: null,
        pairs: [], unmatchedListItems: [], unmatchedReceiptItems: [],
    };
    if (!trip || trip.scoreExempt) return base;
    if (trip.isAdHoc) return { ...base, score: AD_HOC_SCORE };

    // List items across the trip's lists, with resolved productId + name.
    const [listItems]: any = await pool.query(
        `SELECT sli.id, sli.quantity, sli.customName, sli.price,
                COALESCE(sli.productId, sp.productId) AS productId,
                p.name AS productName
           FROM ShoppingListItem sli
           JOIN ShoppingList sl ON sl.id = sli.listId
           LEFT JOIN StoreProduct sp ON sp.id = sli.storeProductId
           LEFT JOIN Product p ON p.id = COALESCE(sli.productId, sp.productId)
          WHERE sl.tripId = ?`,
        [tripId],
    );
    // Receipt lines with resolved productId + spend.
    const [receiptItems]: any = await pool.query(
        `SELECT ri.id, ri.name, ri.price, ri.promoPrice, ri.quantity,
                sp.productId AS productId
           FROM ReceiptItem ri
           JOIN Receipt r ON r.id = ri.receiptId
           LEFT JOIN StoreProduct sp ON sp.id = ri.matchedSpId
          WHERE r.tripId = ?`,
        [tripId],
    );
    base.listItemCount = listItems.length;
    if (listItems.length === 0 && receiptItems.length === 0) return base;

    // Manual corrections.
    const [links]: any = await pool.query(
        "SELECT listItemId, receiptItemId, kind FROM TripLineLink WHERE tripId = ?", [tripId]);
    const suppressed = new Set(links.filter((l: any) => l.kind === 'suppressed')
        .map((l: any) => `${l.listItemId}:${l.receiptItemId}`));
    const manual = links.filter((l: any) => l.kind === 'manual');

    const spend = (ri: any) => {
        const unit = (ri.promoPrice != null && parseFloat(ri.promoPrice) > 0)
            ? parseFloat(ri.promoPrice) : parseFloat(ri.price) || 0;
        return unit * (parseFloat(ri.quantity) || 1);
    };
    const totalSpend = receiptItems.reduce((s: number, ri: any) => s + spend(ri), 0);

    // AUTO pairing: greedy by productId, one receipt line per list item.
    const usedReceipt = new Set<number>();
    const usedList = new Set<number>();
    const pairs: PlanningPair[] = [];

    // Manual pairs claim their lines FIRST (they're explicit user intent).
    const listById = new Map<number, any>(listItems.map((l: any) => [Number(l.id), l]));
    const receiptById = new Map<number, any>(receiptItems.map((r: any) => [Number(r.id), r]));
    for (const m of manual) {
        const li = listById.get(Number(m.listItemId));
        const ri = receiptById.get(Number(m.receiptItemId));
        if (!li || !ri || usedList.has(li.id) || usedReceipt.has(ri.id)) continue;
        usedList.add(li.id); usedReceipt.add(ri.id);
        pairs.push({
            listItemId: li.id, receiptItemId: ri.id, source: 'manual',
            productName: li.productName ?? li.customName ?? ri.name,
            listQty: parseFloat(li.quantity) || 1, receiptQty: parseFloat(ri.quantity) || 1,
            listPrice: li.price != null ? parseFloat(li.price) : null, receiptPrice: spend(ri),
        });
    }
    for (const li of listItems) {
        if (usedList.has(li.id) || li.productId == null) continue;
        const ri = receiptItems.find((r: any) =>
            !usedReceipt.has(r.id) && r.productId != null && Number(r.productId) === Number(li.productId)
            && !suppressed.has(`${li.id}:${r.id}`));
        if (!ri) continue;
        usedList.add(li.id); usedReceipt.add(ri.id);
        pairs.push({
            listItemId: li.id, receiptItemId: ri.id, source: 'auto',
            productName: li.productName ?? li.customName ?? ri.name,
            listQty: parseFloat(li.quantity) || 1, receiptQty: parseFloat(ri.quantity) || 1,
            listPrice: li.price != null ? parseFloat(li.price) : null, receiptPrice: spend(ri),
        });
    }

    const credit = (p: PlanningPair) => (p.source === 'manual' ? MANUAL_CREDIT : 1);
    const matchedCredit = pairs.reduce((s, p) => s + credit(p), 0);
    const coverage = listItems.length > 0 ? Math.min(1, matchedCredit / listItems.length) : 0;

    const matchedSpend = pairs.reduce((s, p) => {
        const ri = receiptById.get(p.receiptItemId);
        return s + (ri ? spend(ri) * credit(p) : 0);
    }, 0);
    const discipline = totalSpend > 0 ? Math.min(1, matchedSpend / totalSpend) : 0;

    const precision = pairs.length > 0
        ? pairs.reduce((s, p) => {
            const lo = Math.min(p.listQty, p.receiptQty), hi = Math.max(p.listQty, p.receiptQty);
            return s + (hi > 0 ? lo / hi : 1);
        }, 0) / pairs.length
        : 0;

    base.matchedListItemCount = pairs.length;
    base.pairs = pairs;
    // Prediction accuracy: predicted (list) vs actual (receipt) over matched
    // items that carried a list price. null when none (e.g. list never priced).
    const priced = pairs.filter(p => p.listPrice != null && p.listPrice > 0);
    if (priced.length > 0) {
        base.predictedMatchedTotal = Math.round(priced.reduce((s, p) => s + (p.listPrice ?? 0), 0) * 100) / 100;
        base.actualMatchedTotal = Math.round(priced.reduce((s, p) => s + p.receiptPrice, 0) * 100) / 100;
    }
    base.unmatchedListItems = listItems
        .filter((l: any) => !usedList.has(l.id))
        .map((l: any) => ({ listItemId: l.id, name: l.productName ?? l.customName ?? null, productId: l.productId ?? null }));
    base.unmatchedReceiptItems = receiptItems
        .filter((r: any) => !usedReceipt.has(r.id))
        .map((r: any) => ({ receiptItemId: r.id, name: String(r.name), productId: r.productId ?? null }));
    base.coverage = Math.round(coverage * 100) / 100;
    base.discipline = Math.round(discipline * 100) / 100;
    base.precision = Math.round(precision * 100) / 100;
    // Receipts not in yet → nothing to judge; score stays null until stage 5-ish.
    base.score = receiptItems.length > 0
        ? Math.max(0, Math.round(100 * (0.4 * coverage + 0.4 * discipline + 0.2 * precision)))
        : null;
    return base;
};

/**
 * Monthly aggregation for the Profilis card: the mean of scoreable planned
 * trips' scores in each month (keyed by anchor = latest receipt date, falling
 * back to trip creation), with each ad-hoc trip contributing its fixed mild
 * score into the same mean (spec: "aggregation of trip scores + ad-hoc
 * negatives" — sustained ad-hoc-only behaviour converges the month to 25).
 */
export const monthlyPlanningScores = async (
    userId: string,
    months = 6,
): Promise<{ month: string; score: number | null; tripCount: number; adHocCount: number }[]> => {
    const [trips]: any = await pool.query(
        `SELECT t.id, t.isAdHoc, t.scoreExempt,
                COALESCE((SELECT MAX(r.receiptDate) FROM Receipt r WHERE r.tripId = t.id), t.createdAt) AS anchor
           FROM Trip t
           JOIN TripMember tm ON tm.tripId = t.id
          WHERE tm.userId = ? AND t.scoreExempt = 0`,
        [userId],
    );
    const now = new Date();
    const keys: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const byMonth = new Map<string, any[]>(keys.map(k => [k, []]));
    for (const t of trips) {
        const a = new Date(t.anchor);
        const k = `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, '0')}`;
        if (byMonth.has(k)) byMonth.get(k)!.push(t);
    }
    const out: { month: string; score: number | null; tripCount: number; adHocCount: number }[] = [];
    for (const k of keys) {
        const monthTrips = byMonth.get(k)!;
        const scores: number[] = [];
        let adHocCount = 0;
        for (const t of monthTrips) {
            if (t.isAdHoc) { scores.push(AD_HOC_SCORE); adHocCount++; continue; }
            const s = await computePlanningScore(Number(t.id));
            if (s.score != null) scores.push(s.score);
        }
        out.push({
            month: k,
            score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
            tripCount: scores.length,
            adHocCount,
        });
    }
    return out;
};
