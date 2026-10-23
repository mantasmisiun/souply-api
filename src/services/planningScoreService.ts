import pool from '../config/db.js';
import { normalizeProductName } from '../utils/productNameNormalize.js';
import { lemmaOf } from '../utils/ltLemmas.js';
import { localizedProductNameSql } from '../middleware/locale.js';
import { loadCanonicalsForProducts } from './productCanonical.js';
import { readCachedTripComparison, readTripBasketComparison } from './tripBasketComparison.js';

const UNASSIGNED_CATEGORY = 688; // "Nepriskirta" — never counts as a category match
// Filler tokens that must not create a false name match on their own.
// Noise tokens that must NOT bind two different products together. 'rieb'
// (riebumas / fat-%) appears in almost every dairy name — "sūrelis 24 % rieb."
// and "grietinė 30 % rieb." share only 'rieb', which greedily mis-paired the
// planned sūrelis to a receipt sour cream. Fat-% is never identifying.
const NAME_STOP = new Set(['bon', 'via', 'clever', 'lengvai', 'ekologiskas', 'lietuviski', 'lietuviskas', 'didziosios', 'smulkiavaisiai', 'smulki', 'skonio', 'salt', 'hill', 'rieb', 'riebumo', 'riebumas', 'riebalu']);
/**
 * Significant name tokens (≥4 chars, not a filler) for fuzzy same-item match.
 *
 * Each token is LEMMATISED first (utils/ltLemmas): Lithuanian declines, and
 * receipts print a different case from the catalogue — a list "Spirito ACTAS"
 * against a receipt "Maistinė ACTO rūgštis" shared no token, so one purchase was
 * counted BOTH as a missed list item and as an extra receipt line. Lemmatising
 * before the length filter matters too: a short inflected form maps up to its
 * longer lemma and survives instead of being dropped.
 */
export const nameTokens = (name: string | null): Set<string> => {
    const out = new Set<string>();
    for (const w of normalizeProductName(name ?? '').split(' ')) {
        if (NAME_STOP.has(w)) continue;
        const lemma = lemmaOf(w);
        if (lemma.length >= 4) out.add(lemma);
    }
    return out;
};
/** Do a list item and a receipt item refer to the same KIND of product? Exact
 *  product id, else a shared significant name token, else the same real L3.
 *  Exported for tests + the `pairing:why` diagnostic, which must reason about the
 *  SAME tiers production uses — a re-implementation would drift. */
export const sameKind = (li: any, ri: any): boolean => {
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
    /** Pack size for the DISPLAY amount. listQty is a PACK COUNT (2 × 250 g),
     *  not kilograms — the client formats "N × packAmount packUnit" via
     *  formatItemAmount so a 2-pack plan never renders as "2 kg". Bought side
     *  uses the receipt line's OWN unit/amount/weighable. */
    listPackAmount: number | null;
    listPackUnit: string | null;
    receiptUnit: string | null;
    receiptAmount: number | null;
    receiptWeighable: boolean;
    /** Price per canonical unit (planned vs bought) + its unit — the Prognozė
     *  row's headline comparison ("€23.96/kg → €19.98/kg"). Bought falls back to
     *  the PLANNED amount when the receipt has no reliable size. null → hide. */
    listUnitPrice: number | null;
    receiptUnitPrice: number | null;
    unitPriceUnit: string;
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
    listItemsDetail: { listItemId: number; name: string; imageUrls: string | (string | null)[] | null; quantity: number; isWeighable: boolean; canonicalStep: number | null; packAmount: number | null; packUnit: string | null; bought: boolean }[];
}

export const computePlanningScore = async (
    tripId: number,
    opts: {
        /** Compute (and freeze) the trip comparison when none is cached. ONLY the
         *  single-trip endpoint does this — the monthly loops would otherwise
         *  price a basket at five stores per trip. */
        allowLiveComparison?: boolean;
    } = {},
): Promise<PlanningScore> => {
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
                sp.amount AS packAmount, sp.unit AS packUnit,
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
    const [rawReceiptItems]: any = await pool.query(
        `SELECT ri.id, ri.name, ri.price, ri.promoPrice, ri.quantity,
                ri.unit AS unit, ri.amount AS amount, ri.isWeighable AS isWeighable,
                sp.productId AS productId,
                p.name AS resolvedName, sp.storeProductName AS spName,
                ${localizedProductNameSql('lt', { productAlias: 'p' }).imageUrlsSql} AS imageUrls,
                p.categoryId AS l3
           FROM ReceiptItem ri
           JOIN Receipt r ON r.id = ri.receiptId
           LEFT JOIN StoreProduct sp ON sp.id = ri.matchedSpId
           LEFT JOIN Product p ON p.id = sp.productId
          WHERE r.tripId = ?`,
        [tripId],
    );
    // ROBUSTNESS: a receipt line with a non-positive effective price is a
    // PARSE FAILURE (a tilted receipt shears the price off its row — see the
    // band-skew issue). Such a line can't be reasoned about (a €0 "purchase"
    // would pair to a plan item and render an impossible 100 % discount), so
    // drop it before any pairing / stats / Prognozė. It stays a raw ReceiptItem
    // for the receipt view + the swipe/heal queue to fix, it just never taints
    // the comparison.
    const effPrice = (ri: any): number => {
        const promo = parseFloat(ri.promoPrice);
        if (Number.isFinite(promo) && promo > 0) return promo;
        const reg = parseFloat(ri.price);
        return Number.isFinite(reg) ? reg : 0;
    };
    const receiptItems = (rawReceiptItems as any[]).filter(ri => effPrice(ri) > 0);
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

    // ── Price per canonical unit (Prognozė headline) ────────────────────────
    const toKg = (amount: number, unit: string | null): number => {
        const u = (unit ?? '').toLowerCase();
        return (u === 'g' || u === 'ml') ? amount / 1000 : amount;
    };
    // Canonical amount: weighable → qty (already kg/l); fluid pack → qty × pack
    // size; count → qty (packs); unknown → null.
    const canonAmount = (qty: number, isWeighable: boolean, family: string | null, packAmount: number | null, packUnit: string | null): number | null => {
        if (isWeighable) return qty > 0 ? qty : null;
        if (family === 'fluid' && packAmount != null && packAmount > 0) return qty * toKg(packAmount, packUnit);
        if (family === 'count') return qty > 0 ? qty : null;
        return null;
    };
    const r2 = (n: number) => Math.round(n * 100) / 100;
    /**
     * ONE unit for the whole row, and BOTH sides expressed in it.
     *
     * The comparison is only meaningful per unit, so it must never mix bases.
     * It used to: a planned product with no canonical family produced a null
     * unit price, the client fell back to the raw line total, and the row read
     * "2,58 € → 2,49 €/kg" — a line price against a per-kilo price.
     *
     * Rules:
     *   · If EITHER side is weighed (or the product is fluid) the row is per
     *     kg / l; otherwise it is per piece (vnt), where the amount is simply
     *     the quantity — so an amount is always derivable.
     *   · A side that cannot express its own size in that unit borrows the
     *     other side's amount. Both figures then stay comparable instead of
     *     one silently degrading to a line total.
     */
    const amountIn = (
        unit: string, qty: number, isWeighable: boolean,
        packAmount: number | null, packUnit: string | null,
    ): number | null => {
        if (unit === 'vnt') return qty > 0 ? qty : null;          // pieces
        if (isWeighable) return qty > 0 ? qty : null;             // weighed → qty IS the weight
        if (packAmount != null && packAmount > 0) return qty * toKg(packAmount, packUnit);
        // A FRACTIONAL quantity on a per-weight row is itself a weight: pack
        // counts are whole numbers, so "0,5" can only mean half a kilo. List rows
        // routinely carry the weight here while their isWeighable flag is unset
        // (it is derived, and a custom/unmatched item has nothing to derive from)
        // — without this, planned 0,5 kg of tomatoes borrowed the receipt's
        // 0,14 kg and priced them at €18,43/kg instead of €5,16/kg.
        if (qty > 0 && !Number.isInteger(qty)) return qty;
        return null;                                              // packed, size unknown
    };
    const unitPriceFields = (li: any, ri: any, listQty: number, receiptQty: number, listPrice: number | null, receiptPrice: number) => {
        const meta = canonById.get(Number(li.productId));
        const family = meta?.family ?? null;
        const packAmount = li.packAmount != null ? parseFloat(li.packAmount) : null;
        const rAmount = ri.amount != null ? parseFloat(ri.amount) : null;

        const perWeight = !!li.isWeighable || !!ri.isWeighable || family === 'fluid';
        const unit = perWeight ? (family === 'fluid' && meta?.unit === 'l' ? 'l' : 'kg') : 'vnt';

        let plannedAmt = amountIn(unit, listQty, !!li.isWeighable, packAmount, li.packUnit ?? null);
        let boughtAmt = amountIn(unit, receiptQty, !!ri.isWeighable, rAmount, ri.unit ?? null);
        // Symmetric borrow — a side with no size of its own uses the other's.
        if (plannedAmt == null) plannedAmt = boughtAmt;
        if (boughtAmt == null) boughtAmt = plannedAmt;

        return {
            unitPriceUnit: unit,
            listUnitPrice: (listPrice != null && plannedAmt != null && plannedAmt > 0) ? r2(listPrice / plannedAmt) : null,
            receiptUnitPrice: (boughtAmt != null && boughtAmt > 0) ? r2(receiptPrice / boughtAmt) : null,
        };
    };

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
            // Prefer the RECEIPT item's image so the thumbnail MATCHES the Kvitas tab (same bought
            // product) — the planned-list product can be a different SP with a stale/other image;
            // fall back to the list image only when the receipt line has no matched product.
            imageUrls: ri.imageUrls ?? li.imageUrls ?? null, isWeighable: !!li.isWeighable, canonicalStep: stepOf(li),
            listQty: parseFloat(li.quantity) || 1, receiptQty: parseFloat(ri.quantity) || 1,
            listPackAmount: li.packAmount != null ? parseFloat(li.packAmount) : null,
            listPackUnit: li.packUnit ?? null,
            receiptUnit: ri.unit ?? null,
            receiptAmount: ri.amount != null ? parseFloat(ri.amount) : null,
            receiptWeighable: !!ri.isWeighable,
            ...unitPriceFields(li, ri, parseFloat(li.quantity) || 1, parseFloat(ri.quantity) || 1, li.price != null ? parseFloat(li.price) : null, spend(ri)),
            listPrice: li.price != null ? parseFloat(li.price) : null, receiptPrice: spend(ri),
        });
    }
    const emitAutoPair = (li: any, ri: any) => {
        usedList.add(li.id); usedReceipt.add(ri.id);
        pairs.push({
            listItemId: li.id, receiptItemId: ri.id, source: 'auto',
            productName: li.productName ?? li.customName ?? ri.name,
            listName: li.productName ?? li.customName ?? li.spName ?? null,
            receiptName: ri.resolvedName ?? ri.spName ?? ri.name,
            // Prefer the RECEIPT item's image so the thumbnail MATCHES the Kvitas tab (same bought
            // product) — the planned-list product can be a different SP with a stale/other image;
            // fall back to the list image only when the receipt line has no matched product.
            imageUrls: ri.imageUrls ?? li.imageUrls ?? null, isWeighable: !!li.isWeighable, canonicalStep: stepOf(li),
            listQty: parseFloat(li.quantity) || 1, receiptQty: parseFloat(ri.quantity) || 1,
            listPackAmount: li.packAmount != null ? parseFloat(li.packAmount) : null,
            listPackUnit: li.packUnit ?? null,
            receiptUnit: ri.unit ?? null,
            receiptAmount: ri.amount != null ? parseFloat(ri.amount) : null,
            receiptWeighable: !!ri.isWeighable,
            ...unitPriceFields(li, ri, parseFloat(li.quantity) || 1, parseFloat(ri.quantity) || 1, li.price != null ? parseFloat(li.price) : null, spend(ri)),
            listPrice: li.price != null ? parseFloat(li.price) : null, receiptPrice: spend(ri),
        });
    };

    /**
     * Run ONE matching tier over everything still unpaired: score every remaining
     * (list, receipt) combination, then assign strongest-first.
     *
     * The old code did a single greedy pass that took the FIRST receipt line
     * satisfying sameKind() — which mixed the tiers together, so a weak
     * same-CATEGORY hit that happened to sit earlier in the receipt beat the
     * exact same-NAME hit further down. Real case: planned "…slyviniai pomidorai"
     * and "…ilgavaisiai agurkai" both sit in l3=3, the receipt listed agurkai
     * first, so the tomatoes claimed the cucumbers and the cucumbers were left
     * with the tomatoes — a clean swap that then rendered a meaningless +156 %.
     * Scoring per tier means a name match can never lose to a category match.
     */
    const runPairTier = (score: (li: any, ri: any) => number | null) => {
        const cands: { li: any; ri: any; s: number }[] = [];
        for (const li of listItems) {
            if (usedList.has(li.id)) continue;
            for (const ri of receiptItems) {
                if (usedReceipt.has(ri.id)) continue;
                if (suppressed.has(`${li.id}:${ri.id}`)) continue;
                const s = score(li, ri);
                if (s != null) cands.push({ li, ri, s });
            }
        }
        cands.sort((a, b) => b.s - a.s);
        for (const c of cands) {
            if (usedList.has(c.li.id) || usedReceipt.has(c.ri.id)) continue;
            emitAutoPair(c.li, c.ri);
        }
    };

    const tokensOf = (li: any, ri: any) => {
        const lt = li._tokens ?? (li._tokens = nameTokens(li.productName ?? li.spName ?? li.customName));
        const rt = ri._tokens ?? (ri._tokens = nameTokens(ri.resolvedName ?? ri.spName ?? ri.name));
        let shared = 0;
        for (const w of rt) if (lt.has(w)) shared++;
        return shared;
    };

    // TIER 1 — the same product. Unambiguous, so it claims its lines first.
    runPairTier((li, ri) =>
        (li.productId != null && ri.productId != null && Number(li.productId) === Number(ri.productId)) ? 1 : null);
    // TIER 2 — shared name words ("…pomidorai" ↔ "Kekiniai pomidorai"). More
    // shared words = a better match, so the strongest wins the line.
    runPairTier((li, ri) => { const n = tokensOf(li, ri); return n > 0 ? n : null; });
    // TIER 3 — last resort: the same L3 category. Only whatever is STILL
    // unpaired, so it can no longer outrank a name match.
    runPairTier((li, ri) => {
        const lc = li.l3, rc = ri.l3;
        return (lc != null && rc != null && lc !== UNASSIGNED_CATEGORY && Number(lc) === Number(rc)) ? 1 : null;
    });

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

    // storeChoice — "could this whole shopping have cost less somewhere else?"
    //
    // Asked at TRIP level (tripBasketComparison): the union of every receipt line
    // priced at each nearby store as a SINGLE shop. The old source was the
    // per-receipt snapshots, which compare each receipt only against alternatives
    // for ITS OWN items — so a split trip could score a perfect store choice
    // while one shop would have been cheaper for everything (trip 191: 100/100
    // next to a Sutaupyta sheet saying Maxima alone was €0.40 less). It also
    // inherited that comparison's flat imputation: when every alternative came
    // back equal to the paid total, "nothing to compare" scored as "you couldn't
    // have done better".
    //
    // Falls back to the per-receipt snapshots when no trip comparison is cached
    // and we aren't allowed to compute one (bulk monthly scoring).
    let P = 0, M = 0, C = 0, snapRows = 0;
    const tripCmp = opts.allowLiveComparison
        ? await readTripBasketComparison(tripId).catch(() => null)
        : await readCachedTripComparison(tripId);
    if (tripCmp && tripCmp.candidates.length > 0 && tripCmp.paidTotal > 0) {
        const totals = tripCmp.candidates.map(c => c.total).sort((a, b) => a - b);
        P = tripCmp.paidTotal;
        C = tripCmp.bestSingleTotal ?? totals[0];
        M = totals[Math.floor((totals.length - 1) / 2)];
        snapRows = 1;
    } else {
        const [snaps]: any = await pool.query(
            `SELECT s.paidTotal, s.medianAltTotal, s.cheapestAltTotal
               FROM ReceiptComparisonSnapshot s
               JOIN Receipt r ON r.id = s.receiptId
              WHERE r.tripId = ? AND r.userDeletedAt IS NULL`,
            [tripId],
        );
        for (const row of snaps) {
            if (row.medianAltTotal == null || row.cheapestAltTotal == null) continue;
            P += Number(row.paidTotal) || 0;
            M += Number(row.medianAltTotal);
            C += Number(row.cheapestAltTotal);
            snapRows++;
        }
    }
    let storeChoice: number | null = null;
    if (snapRows > 0) {
        if ((M - C) >= 0.01) {
            // Normal spread: map paid from median (0.5) down to cheapest (1.0).
            storeChoice = Math.min(1, Math.max(0, 0.5 + 0.5 * (M - P) / (M - C)));
        } else if (C >= 0.01) {
            // NO spread — every comparable store costs ~C (e.g. one product, uniform
            // catalog price). Paying at/below it is a perfect choice (you could not
            // have done better elsewhere); paying above scales down to 0 at 2× the
            // alt price. Previously this was NULLED, which scored a clearly-cheapest
            // ad-hoc trip 0/100 (receipt 116: paid €2,28 vs €4,98 everywhere else).
            storeChoice = Math.min(1, Math.max(0, 1 - Math.max(0, P - C) / C));
        }
        if (storeChoice != null) {
            base.storeChoice = Math.round(storeChoice * 100) / 100;
            base.storeHeadroomEur = Math.round(Math.max(0, P - C) * 100) / 100;
        }
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
        packAmount: li.packAmount != null ? parseFloat(li.packAmount) : null,
        packUnit: li.packUnit ?? null,
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
    // discipline (0.5 / 0.5); otherwise weight 0.35 / 0.35 / 0.30. A list-less
    // (ad-hoc) trip has coverage = discipline = 0, so it scores purely on store
    // choice — max 30 (0.30·storeChoice), the agreed fixed-coefficient cap.
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
