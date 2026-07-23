import pool from '../config/db.js';
import { normalizeProductName } from '../utils/productNameNormalize.js';
import { localizedProductNameSql } from '../middleware/locale.js';
import { loadCanonicalsForProducts } from './productCanonical.js';

const UNASSIGNED_CATEGORY = 688; // "Nepriskirta" — never counts as a category match
// Filler tokens that must not create a false name match on their own.
const NAME_STOP = new Set(['bon', 'via', 'clever', 'lengvai', 'ekologiskas', 'lietuviski', 'lietuviskas', 'didziosios', 'smulkiavaisiai', 'smulki', 'skonio', 'salt', 'hill']);
/** Significant name tokens (≥4 chars, not a filler) for fuzzy same-item match. */
const nameTokens = (name: string | null): Set<string> => {
    const out = new Set<string>();
    for (const w of normalizeProductName(name ?? '').split(' ')) {
        if (w.length >= 4 && !NAME_STOP.has(w)) out.add(w);
    }
    return out;
};
/** Do a list item and a receipt item refer to the same KIND of product? Exact
 *  product id, else a shared significant name token, else the same real L3. */
const sameKind = (li: any, ri: any): boolean => {
    if (li.productId != null && ri.productId != null && Number(li.productId) === Number(ri.productId)) return true;
    const lt = li._tokens ?? (li._tokens = nameTokens(li.productName ?? li.spName ?? li.customName));
    const rt = ri._tokens ?? (ri._tokens = nameTokens(ri.resolvedName ?? ri.spName ?? ri.name));
    for (const w of rt) if (lt.has(w)) return true;
    const lc = li.l3, rc = ri.l3;
    return lc != null && rc != null && lc !== UNASSIGNED_CATEGORY && Number(lc) === Number(rc);
};

/**
 * Souply 2.0 planning score (spec: Stage 5 / Planavimo balas).
 *
 *   score = round(100 · (0.35·coverage + 0.35·discipline + 0.30·storeChoice))
 *
 *   coverage    = list items with ≥1 same-kind receipt line ÷ list items
 *                 (ANY-MATCH: did you buy the plan?)
 *   discipline  = on-plan receipt spend ÷ total spend (ANY-MATCH, €-weighted:
 *                 a €15 impulse hurts more than a €0.30 snack)
 *   storeChoice = did you shop the cheapest comparable store? Frozen from the
 *                 receipt's ReceiptComparisonSnapshot (paid vs median vs
 *                 cheapest alternative). null when uninformative (no snapshot,
 *                 or all stores ~same) → renormalize over the other two.
 *
 * coverage / discipline are ALWAYS defined (0 when there's no list). When
 * storeChoice is null the score renormalizes over the two available metrics
 * (0.5 / 0.5). An ad-hoc (list-less) trip therefore scores purely on
 * storeChoice (30·storeChoice) — no fixed penalty.
 *
 * AUTO pairs (manual-link UI only, NOT the score): list item and receipt line
 * resolve to the SAME productId (list side: ShoppingListItem.productId or its
 * storeProductId's product; receipt side: ReceiptItem.matchedSpId's product).
 * MANUAL pairs come from TripLineLink (kind='manual'); an auto pair the user
 * disconnected is stored as kind='suppressed' and excluded.
 *
 * scoreExempt trips (historic backfill), and trips with no receipts, return
 * a null score.
 */

export interface PlanningPair {
    listItemId: number;
    receiptItemId: number;
    source: 'auto' | 'manual';
    productName: string | null;
    /** Planned (list) vs bought (receipt) display names — the fuzzy matcher may
     *  resolve one real item to two different product rows, so the Prognozė sheet
     *  shows the plan name primary + the bought name muted when they differ. */
    listName: string | null;
    receiptName: string | null;
    /** Product image aggregate (list-item side) for the sheet thumbnail. */
    imageUrls: string | (string | null)[] | null;
    /** Weighable → the amount is a weight (kg); else pieces (vnt). */
    isWeighable: boolean;
    /** Smallest pack in canonical units — packaged qty ÷ step = pack count. */
    canonicalStep: number | null;
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
    /** Store-choice quality (0..1) frozen from the receipt comparison snapshot,
     *  or null when uninformative (no snapshot / all stores ~same). */
    storeChoice: number | null;
    /** €-savings a perfect store-chooser would have kept (max(0, paid−cheapest)),
     *  summed over snapshotted receipts. null when storeChoice is null. */
    storeHeadroomEur: number | null;
    /** € spent on non-list (impulse) receipt lines = totalSpend − onPlanSpend. */
    impulseEur: number;
    /** Whether the trip has any list items (drives per-category tips). */
    hasList: boolean;
    isAdHoc: boolean;
    scoreExempt: boolean;
    listItemCount: number;
    matchedListItemCount: number;
    /** Stats-card counts (see below): impulse = receipt items sharing nothing
     *  with the list; missed = list items sharing nothing with the receipt. */
    impulseCount: number;
    forgottenCount: number;
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
    /** ANY-MATCH impulse receipt-item ids (share nothing with any list item) —
     *  lets the Impulse sheet flag each Kvitai card ✓ planned / ✗ impulse, using
     *  the SAME definition as impulseCount (NOT the 1:1 unmatched list above). */
    impulseReceiptItemIds: number[];
    /** Every list item classified bought (ANY-MATCH some receipt line) or missed,
     *  with render data for the Missed sheet's cards. */
    listItemsDetail: { listItemId: number; name: string; imageUrls: string | (string | null)[] | null; quantity: number; isWeighable: boolean; canonicalStep: number | null; bought: boolean }[];
}

export const computePlanningScore = async (tripId: number): Promise<PlanningScore> => {
    const [[trip]]: any = await pool.query('SELECT isAdHoc, scoreExempt FROM Trip WHERE id = ?', [tripId]);
    const base: PlanningScore = {
        tripId, score: null, coverage: 0, discipline: 0,
        storeChoice: null, storeHeadroomEur: null, impulseEur: 0, hasList: false,
        isAdHoc: !!trip?.isAdHoc, scoreExempt: !!trip?.scoreExempt,
        listItemCount: 0, matchedListItemCount: 0,
        impulseCount: 0, forgottenCount: 0,
        predictedMatchedTotal: null, actualMatchedTotal: null,
        pairs: [], unmatchedListItems: [], unmatchedReceiptItems: [],
        impulseReceiptItemIds: [], listItemsDetail: [],
    };
    if (!trip || trip.scoreExempt) return base;

    // List items across the trip's lists, with resolved productId, name + L3
    // category (leaf, or itself if it has children). name/category feed the
    // fuzzy pairing since the list and the receipt often resolve the SAME real
    // item to DIFFERENT product rows (and receipt mints are uncategorised).
    const [listItems]: any = await pool.query(
        // Image resolution mirrors the shopping list: the product's aggregate of
        // ALL its StoreProduct photos (any chain), not the single SP linked to the
        // list item (usually null — items are added by productId, no storeProductId).
        `SELECT sli.id, sli.quantity, sli.customName, sli.price,
                COALESCE(sli.productId, sp.productId) AS productId,
                p.name AS productName, sp.storeProductName AS spName,
                ${localizedProductNameSql('lt', { productAlias: 'p' }).imageUrlsSql} AS imageUrls,
                -- Weighable is a PRODUCT property; sli.isWeighable is NOT NULL
                -- DEFAULT 0 so it can't lead the COALESCE (mirrors the shopping
                -- list): exact SP → any SP of the product (covers null storeProductId
                -- substitutions) → explicit custom flag → 0.
                COALESCE(
                    sp.isWeighable,
                    (SELECT MAX(spi.isWeighable) FROM StoreProduct spi
                      WHERE spi.productId = COALESCE(sli.productId, sp.productId)),
                    NULLIF(sli.isWeighable, 0),
                    0
                ) AS isWeighable,
                p.categoryId AS l3
           FROM ShoppingListItem sli
           JOIN ShoppingList sl ON sl.id = sli.listId
           LEFT JOIN StoreProduct sp ON sp.id = sli.storeProductId
           LEFT JOIN Product p ON p.id = COALESCE(sli.productId, sp.productId)
          WHERE sl.tripId = ?`,
        [tripId],
    );
    // Receipt lines with resolved productId, name + L3 category.
    const [receiptItems]: any = await pool.query(
        `SELECT ri.id, ri.name, ri.price, ri.promoPrice, ri.quantity,
                sp.productId AS productId,
                p.name AS resolvedName, sp.storeProductName AS spName,
                p.categoryId AS l3
           FROM ReceiptItem ri
           JOIN Receipt r ON r.id = ri.receiptId
           LEFT JOIN StoreProduct sp ON sp.id = ri.matchedSpId
           LEFT JOIN Product p ON p.id = sp.productId
          WHERE r.tripId = ?`,
        [tripId],
    );
    base.listItemCount = listItems.length;
    base.hasList = listItems.length > 0;
    if (listItems.length === 0 && receiptItems.length === 0) return base;

    // Canonical step (smallest pack in canonical units) per list-item product —
    // lets the sheets render a packaged item as a pack COUNT (quantity ÷ step)
    // rather than the raw canonical weight ("0,25 kg" → "1 vnt").
    const canonProductIds = [...new Set(
        (listItems as any[]).map(li => Number(li.productId)).filter((n: number) => Number.isFinite(n) && n > 0))];
    const canonById = await loadCanonicalsForProducts(canonProductIds);
    const stepOf = (li: any): number | null => canonById.get(Number(li.productId))?.step ?? null;

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
            listName: li.productName ?? li.customName ?? li.spName ?? null,
            receiptName: ri.resolvedName ?? ri.spName ?? ri.name,
            imageUrls: li.imageUrls ?? null, isWeighable: !!li.isWeighable, canonicalStep: stepOf(li),
            listQty: parseFloat(li.quantity) || 1, receiptQty: parseFloat(ri.quantity) || 1,
            listPrice: li.price != null ? parseFloat(li.price) : null, receiptPrice: spend(ri),
        });
    }
    for (const li of listItems) {
        if (usedList.has(li.id)) continue;
        // Same product id → same name token → same real L3 (not just exact id):
        // the list and receipt routinely resolve one real item to two product
        // rows, and receipt mints are uncategorised.
        const ri = receiptItems.find((r: any) =>
            !usedReceipt.has(r.id) && sameKind(li, r) && !suppressed.has(`${li.id}:${r.id}`));
        if (!ri) continue;
        usedList.add(li.id); usedReceipt.add(ri.id);
        pairs.push({
            listItemId: li.id, receiptItemId: ri.id, source: 'auto',
            productName: li.productName ?? li.customName ?? ri.name,
            listName: li.productName ?? li.customName ?? li.spName ?? null,
            receiptName: ri.resolvedName ?? ri.spName ?? ri.name,
            imageUrls: li.imageUrls ?? null, isWeighable: !!li.isWeighable, canonicalStep: stepOf(li),
            listQty: parseFloat(li.quantity) || 1, receiptQty: parseFloat(ri.quantity) || 1,
            listPrice: li.price != null ? parseFloat(li.price) : null, receiptPrice: spend(ri),
        });
    }

    // coverage / discipline are ANY-MATCH (NOT the greedy 1:1 pairs above, which
    // exist only for the manual-link UI): a list item counts as covered if ANY
    // receipt line is the same kind, and a receipt line is on-plan if it shares
    // a kind with ANY list item. Extra units of a planned kind (2 breads for 1)
    // therefore never read as impulse, and one receipt line can cover several
    // list items — matching how impulseCount/forgottenCount already count.
    const coverage = listItems.length > 0
        ? listItems.filter((li: any) => receiptItems.some((ri: any) => sameKind(li, ri))).length / listItems.length
        : 0;

    const onPlanSpend = receiptItems.reduce((s: number, ri: any) =>
        s + (listItems.some((li: any) => sameKind(li, ri)) ? spend(ri) : 0), 0);
    const discipline = totalSpend > 0 ? onPlanSpend / totalSpend : 0;

    // storeChoice — frozen store-selection quality from the receipt comparison
    // snapshots (paid vs median vs cheapest comparable-store totals).
    const [snaps]: any = await pool.query(
        `SELECT s.paidTotal, s.medianAltTotal, s.cheapestAltTotal
           FROM ReceiptComparisonSnapshot s
           JOIN Receipt r ON r.id = s.receiptId
          WHERE r.tripId = ? AND r.userDeletedAt IS NULL`,
        [tripId],
    );
    let P = 0, M = 0, C = 0, snapRows = 0;
    for (const row of snaps) {
        if (row.medianAltTotal == null || row.cheapestAltTotal == null) continue;
        P += Number(row.paidTotal) || 0;
        M += Number(row.medianAltTotal);
        C += Number(row.cheapestAltTotal);
        snapRows++;
    }
    let storeChoice: number | null = null;
    if (snapRows > 0 && (M - C) >= 0.01) {
        storeChoice = Math.min(1, Math.max(0, 0.5 + 0.5 * (M - P) / (M - C)));
        base.storeChoice = Math.round(storeChoice * 100) / 100;
        base.storeHeadroomEur = Math.round(Math.max(0, P - C) * 100) / 100;
    }

    base.matchedListItemCount = pairs.length;
    base.pairs = pairs;
    // Impulse / missed for the stats cards — NON 1:1: a receipt item is impulse
    // only if it shares NOTHING (product / name token / L3) with ANY list item,
    // so extra units of a planned kind (2 breads for 1) are NOT impulse. Missed
    // is the mirror. (pairs/unmatched* above stay 1:1 for the manual-link UI.)
    base.impulseCount = receiptItems.filter((ri: any) => !listItems.some((li: any) => sameKind(li, ri))).length;
    base.forgottenCount = listItems.filter((li: any) => !receiptItems.some((ri: any) => sameKind(li, ri))).length;
    // Per-item classification for the Impulse / Missed sheets (same ANY-MATCH
    // rule as the counts above, so the sheets reconcile with the cards).
    base.impulseReceiptItemIds = receiptItems
        .filter((ri: any) => !listItems.some((li: any) => sameKind(li, ri)))
        .map((r: any) => Number(r.id));
    base.listItemsDetail = listItems.map((li: any) => ({
        listItemId: Number(li.id),
        name: li.productName ?? li.customName ?? li.spName ?? '',
        imageUrls: li.imageUrls ?? null,
        quantity: parseFloat(li.quantity) || 1,
        isWeighable: !!li.isWeighable,
        canonicalStep: stepOf(li),
        bought: receiptItems.some((ri: any) => sameKind(li, ri)),
    }));
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
    base.impulseEur = Math.round((totalSpend - onPlanSpend) * 100) / 100;
    // Receipts not in yet → nothing to judge; score stays null until stage 5-ish.
    // storeChoice may be uninformative (null) → renormalize over coverage +
    // discipline (0.5 / 0.5); otherwise weight 0.35 / 0.35 / 0.30.
    base.score = receiptItems.length > 0
        ? Math.min(100, Math.max(0, Math.round(100 * (storeChoice == null
            ? (coverage + discipline) / 2
            : 0.35 * coverage + 0.35 * discipline + 0.30 * storeChoice))))
        : null;
    return base;
};

/**
 * % delta of a trip's planning score vs the user's RECENT typical: the median of
 * their scored trips over the last 90 days (most-recent 10, excluding this trip).
 * Median (robust to a one-off bad trip) + a recency window (old scores age out)
 * — so the number reflects how they plan lately. null when the current score is
 * null or there are fewer than 3 priors (too little signal).
 */
export const planningBaselineDelta = async (
    userId: string, excludeTripId: number, currentScore: number | null,
): Promise<number | null> => {
    if (currentScore == null) return null;
    const [trips]: any = await pool.query(
        `SELECT t.id
           FROM Trip t
           JOIN TripMember tm ON tm.tripId = t.id
          WHERE tm.userId = ? AND t.scoreExempt = 0 AND t.id <> ?
            AND EXISTS (SELECT 1 FROM Receipt r
                         WHERE r.tripId = t.id AND r.userDeletedAt IS NULL
                           AND r.receiptDate >= (NOW() - INTERVAL 90 DAY))
          ORDER BY (SELECT MAX(r.receiptDate) FROM Receipt r WHERE r.tripId = t.id) DESC
          LIMIT 10`,
        [userId, excludeTripId],
    );
    const scores: number[] = [];
    for (const tr of trips) {
        const s = await computePlanningScore(Number(tr.id));
        if (s.score != null) scores.push(s.score);
    }
    if (scores.length < 3) return null;
    scores.sort((a, b) => a - b);
    const mid = scores.length % 2
        ? scores[(scores.length - 1) / 2]
        : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2;
    if (mid <= 0) return null;
    return Math.round(((currentScore - mid) / mid) * 100);
};

/**
 * Monthly aggregation for the Profilis card: the mean of scoreable trips'
 * scores in each month (keyed by anchor = latest receipt date, falling back to
 * trip creation). Ad-hoc trips are no longer a fixed value — they flow through
 * the normal computation (list-less, so scored purely on storeChoice) and
 * contribute their real score to the mean like any other trip.
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
            if (t.isAdHoc) adHocCount++;
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
