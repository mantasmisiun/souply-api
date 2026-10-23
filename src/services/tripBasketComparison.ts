import pool from '../config/db.js';
import { calculateBasketForStores } from './basketCalculationService.js';
import { getClosestStores } from '../models/storeModel.js';

/**
 * "WHAT IF I'D BOUGHT EVERYTHING IN ONE SHOP?" — the trip-level Sutaupyta.
 *
 * The per-receipt comparison (receiptComparisonService) answers a narrower
 * question: for THIS receipt's items, what would other chains have charged. On a
 * split trip that can never say whether splitting was worth it, because no
 * comparison ever holds the whole basket.
 *
 * This one does: every receipt line of the trip is unioned into ONE virtual
 * basket, and that basket is priced at each nearby candidate store — including
 * the stores actually visited, because "all of it at IKI alone" is exactly the
 * comparison a two-store trip needs.
 *
 * MISSING ITEMS CARRY THE PAID PRICE (product decision). A store that can't price
 * an item is not marked partial and not reordered — the item is assumed to cost
 * what it cost you. Bars stay directly comparable, and the worst case is a
 * candidate looking neither better nor worse than reality on that line.
 */

export interface TripSpendSegment {
    storeId: number;
    storeName: string | null;
    chainId: number | null;
    chainName: string | null;
    chainLogoUrl: string | null;
    /** What you actually paid at this store on this trip. */
    total: number;
}

export interface TripCandidateStore {
    storeId: number;
    storeName: string;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    distanceKm: number;
    /** Whole-basket total if everything had been bought here. */
    total: number;
    /** How many lines this store couldn't price (carried at your paid price). */
    carriedItems: number;
    /** True when this candidate is one of the stores you actually visited. */
    visited: boolean;
}

export interface TripBasketComparison {
    /** Your real spend, split by CHAIN — the segmented bar. Two receipts from
     *  the same chain are one shop: you went back for what you forgot. */
    segments: TripSpendSegment[];
    /** Σ segments — the bar's width in money. */
    paidTotal: number;
    /** One bar per nearby store: the whole basket bought there alone. */
    candidates: TripCandidateStore[];
    /** Cheapest single-store total, or null when there are no candidates. */
    bestSingleTotal: number | null;
    /** paidTotal − bestSingleTotal. Positive ⇒ splitting cost you that much. */
    splitDelta: number | null;
    /** Lines that carry no product identity: counted in YOUR total, invisible to
     *  every candidate (nothing to price), so the deltas disclose them. */
    unmatchedLineCount: number;
    unmatchedLineTotal: number;
    itemCount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const EMPTY: TripBasketComparison = {
    segments: [], paidTotal: 0, candidates: [], bestSingleTotal: null, splitDelta: null,
    unmatchedLineCount: 0, unmatchedLineTotal: 0, itemCount: 0,
};

/** Trip receipt lines, folded into one basket keyed by product. */
interface UnionLine {
    productId: number;
    quantity: number;
    name: string;
    /** What the user paid for this line in total (carry price for a store that
     *  can't price the product). */
    paid: number;
}

/**
 * Freeze a trip's comparison. Prices drift; a shopped trip's verdict must not.
 * Called when the trip's receipts change (attach / detach / reparse); reads come
 * from the snapshot, falling back to a live computation when none exists yet.
 */
export const snapshotTripComparison = async (tripId: number): Promise<TripBasketComparison> => {
    const cmp = await getTripBasketComparison(tripId);
    await pool.query(
        `INSERT INTO TripComparisonSnapshot
            (tripId, paidTotal, bestSingleTotal, bestStoreId, candidateCount, unmatchedLines, payload, computedAt)
         VALUES (?,?,?,?,?,?,?, NOW())
         ON DUPLICATE KEY UPDATE paidTotal=VALUES(paidTotal), bestSingleTotal=VALUES(bestSingleTotal),
                                 bestStoreId=VALUES(bestStoreId), candidateCount=VALUES(candidateCount),
                                 unmatchedLines=VALUES(unmatchedLines), payload=VALUES(payload), computedAt=NOW()`,
        [tripId, cmp.paidTotal, cmp.bestSingleTotal, cmp.candidates[0]?.storeId ?? null,
         cmp.candidates.length, cmp.unmatchedLineCount, JSON.stringify(cmp)],
    );
    return cmp;
};

/** Drop the frozen verdict — the trip's receipts changed, so it no longer
 *  describes this shopping. The next read recomputes and re-freezes. */
export const invalidateTripComparison = async (tripId: number): Promise<void> => {
    await pool.query('DELETE FROM TripComparisonSnapshot WHERE tripId = ?', [tripId]);
};

/** The frozen comparison, or null. Never computes — for callers (bulk scoring)
 *  that must not price a basket per trip. */
export const readCachedTripComparison = async (tripId: number): Promise<TripBasketComparison | null> => {
    const [[row]]: any = await pool.query(
        'SELECT payload FROM TripComparisonSnapshot WHERE tripId = ?', [tripId]);
    if (!row?.payload) return null;
    try { return JSON.parse(row.payload) as TripBasketComparison; } catch { return null; }
};

/** Frozen comparison when we have one, otherwise compute (and freeze) it now. */
export const readTripBasketComparison = async (tripId: number): Promise<TripBasketComparison> => {
    const [[row]]: any = await pool.query(
        'SELECT payload FROM TripComparisonSnapshot WHERE tripId = ?', [tripId]);
    if (row?.payload) {
        try { return JSON.parse(row.payload) as TripBasketComparison; } catch { /* recompute */ }
    }
    return snapshotTripComparison(tripId);
};

export const getTripBasketComparison = async (tripId: number): Promise<TripBasketComparison> => {
    // ── 1. What did you actually buy, and where? ────────────────────────────
    const [lines]: any = await pool.query(
        `SELECT ri.name, ri.quantity, ri.price, ri.promoPrice,
                sp.productId, p.name AS productName,
                r.storeId, s.name AS storeName, s.chainId, sc.name AS chainName, sc.logoUrl AS chainLogoUrl
           FROM ReceiptItem ri
           JOIN Receipt r ON r.id = ri.receiptId
           LEFT JOIN StoreProduct sp ON sp.id = ri.matchedSpId
           LEFT JOIN Product p ON p.id = sp.productId
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.tripId = ? AND r.userDeletedAt IS NULL`,
        [tripId],
    );
    if (!lines.length) return { ...EMPTY };

    const segments = new Map<number, TripSpendSegment>();
    const union = new Map<number, UnionLine>();
    let paidTotal = 0;
    let unmatchedLineCount = 0;
    let unmatchedLineTotal = 0;

    for (const l of lines) {
        // A promo price is what was actually charged.
        const unit = Number(l.promoPrice) > 0 ? Number(l.promoPrice) : Number(l.price) || 0;
        const qty = Number(l.quantity) || 1;
        const lineTotal = round2(unit * qty);
        paidTotal = round2(paidTotal + lineTotal);

        const storeId = Number(l.storeId) || 0;
        const chainId = l.chainId != null ? Number(l.chainId) : null;
        // Keyed by CHAIN: two receipts from the same chain (a second trip back
        // for the forgotten milk, or a different branch) are ONE shop, not two.
        const segKey = chainId ?? -storeId;
        const seg = segments.get(segKey);
        if (seg) seg.total = round2(seg.total + lineTotal);
        else segments.set(segKey, {
            storeId,
            storeName: l.storeName ?? null,
            chainId,
            chainName: l.chainName ?? null,
            chainLogoUrl: l.chainLogoUrl ?? null,
            total: lineTotal,
        });

        const productId = l.productId != null ? Number(l.productId) : null;
        if (productId == null) {
            // No product identity → nothing to price elsewhere. It still counts
            // in YOUR total; the response discloses how much is in this bucket.
            unmatchedLineCount++;
            unmatchedLineTotal = round2(unmatchedLineTotal + lineTotal);
            continue;
        }
        const existing = union.get(productId);
        if (existing) {
            existing.quantity = round2(existing.quantity + qty);
            existing.paid = round2(existing.paid + lineTotal);
        } else {
            union.set(productId, {
                productId, quantity: qty, paid: lineTotal,
                name: l.productName ?? l.name ?? '',
            });
        }
    }

    const items = [...union.values()];
    // Per chain: what you ACTUALLY paid there for each product — both the total
    // (so a bar can reproduce the receipt to the cent) and the quantity it
    // covers (so any extra units bought elsewhere can be priced at the same
    // rate). Two lines of the same product on one receipt fold together, which
    // is why this tracks totals rather than a single unit price.
    interface PaidHere { qty: number; total: number }
    const paidByChain = new Map<number, Map<number, PaidHere>>();
    for (const l of lines) {
        const chainId = l.chainId != null ? Number(l.chainId) : null;
        const productId = l.productId != null ? Number(l.productId) : null;
        if (chainId == null || productId == null) continue;
        const unit = Number(l.promoPrice) > 0 ? Number(l.promoPrice) : Number(l.price) || 0;
        const qty = Number(l.quantity) || 1;
        if (!paidByChain.has(chainId)) paidByChain.set(chainId, new Map());
        const m = paidByChain.get(chainId)!;
        const prev = m.get(productId);
        if (prev) { prev.qty = round2(prev.qty + qty); prev.total = round2(prev.total + unit * qty); }
        else m.set(productId, { qty, total: round2(unit * qty) });
    }
    if (items.length === 0) {
        return {
            ...EMPTY,
            segments: [...segments.values()].sort((a, b) => b.total - a.total),
            paidTotal, unmatchedLineCount, unmatchedLineTotal,
        };
    }

    // ── 2. Where could you have bought it instead? ──────────────────────────
    // Anchored on a store you actually visited (the trip happened around there),
    // and the visited stores themselves are candidates — "all of it at IKI alone"
    // is the comparison a split trip is really asking for.
    const [[anchor]]: any = await pool.query(
        `SELECT s.latitude, s.longitude
           FROM Receipt r JOIN Store s ON s.id = r.storeId
          WHERE r.tripId = ? AND s.latitude IS NOT NULL
          ORDER BY r.id ASC LIMIT 1`,
        [tripId],
    );
    if (!anchor) {
        return {
            ...EMPTY,
            segments: [...segments.values()].sort((a, b) => b.total - a.total),
            paidTotal, unmatchedLineCount, unmatchedLineTotal, itemCount: items.length,
        };
    }
    const lat = Number(anchor.latitude);
    const lng = Number(anchor.longitude);

    // Nearest store per chain, plus every store visited (they may not be the
    // nearest of their chain, but they're the ones you actually chose).
    const nearby = await getClosestStores(lat, lng, 25);
    const perChain = new Map<number, any>();
    for (const s of nearby) {
        const chainId = Number((s as any).chainId);
        if (!perChain.has(chainId)) perChain.set(chainId, s);
    }
    const storeIds = new Set<number>([...perChain.values()].map(s => Number(s.id)));
    for (const seg of segments.keys()) if (seg > 0) storeIds.add(seg);

    const priced = await calculateBasketForStores(0, {
        items: items.map(i => ({ productId: i.productId, quantity: i.quantity, name: i.name })),
        storeIds: [...storeIds],
        lat, lng,
    });

    // ── 3. Carry the paid price for anything a store can't sell you ─────────
    const paidByProduct = new Map<number, number>(items.map(i => [i.productId, i.paid]));
    let candidates: TripCandidateStore[] = priced.map(store => {
        const byProduct = new Map<number, typeof store.items[number]>(
            store.items.map(it => [Number(it.productId), it]));
        const paidHere = paidByChain.get(store.chainId);
        let carried = 0;
        let total = 0;

        for (const item of items) {
            // 1. YOU BOUGHT THIS HERE → the till price is the truth for this
            //    store. Catalogue prices ignore the promo you actually got, which
            //    is why "IKI alone" read €25.04 against an €18.69 IKI receipt —
            //    the same basket, at the same shop, on the same day.
            const here = paidHere?.get(item.productId);
            if (here && here.qty > 0) {
                // What you paid here, plus any units bought elsewhere priced at
                // the same rate — so a single-store trip's own bar reproduces the
                // receipt exactly, to the cent.
                const extraQty = Math.max(0, round2(item.quantity - here.qty));
                const rate = here.total / here.qty;
                total = round2(total + here.total + extraQty * rate);
                continue;
            }
            // 2. The catalogue can price it (exact, cluster, or cross-chain average).
            const priced = byProduct.get(item.productId);
            if (priced && !priced.isMissing && priced.totalPrice != null) {
                total = round2(total + Number(priced.totalPrice));
                continue;
            }
            // 3. Nothing can price it → assume it costs what you paid.
            carried++;
            total = round2(total + (paidByProduct.get(item.productId) ?? 0));
        }

        return {
            storeId: store.storeId,
            storeName: store.storeName,
            chainId: store.chainId,
            chainName: store.chainName,
            chainLogoUrl: store.chainLogoUrl,
            distanceKm: round2(Number(store.distance) || 0),
            // + the unmatched receipt lines: they were part of this shop and no
            // store can price them, so every bar carries them equally.
            total: round2(total + unmatchedLineTotal),
            carriedItems: carried,
            visited: segments.has(store.chainId),
        };
    });

    // ONE bar per chain. The nearest store of a chain and the store you actually
    // visited are often different branches, which produced two identical IKI bars
    // — noise. The visited branch wins its chain (it's the one you chose);
    // otherwise the cheapest stands for the chain.
    const byChain = new Map<number, TripCandidateStore>();
    for (const c of candidates.sort((a, b) => a.total - b.total)) {
        const held = byChain.get(c.chainId);
        if (!held || (c.visited && !held.visited)) byChain.set(c.chainId, c);
    }
    candidates = [...byChain.values()];

    // Cheapest first — this ordering is about the ANSWER (which store wins), not
    // about coverage: a carried item is priced, so no bar is second-class.
    candidates.sort((a, b) => a.total - b.total);
    const bestSingleTotal = candidates.length ? candidates[0].total : null;

    return {
        segments: [...segments.values()].sort((a, b) => b.total - a.total),
        paidTotal,
        candidates,
        bestSingleTotal,
        splitDelta: bestSingleTotal != null ? round2(paidTotal - bestSingleTotal) : null,
        unmatchedLineCount,
        unmatchedLineTotal,
        itemCount: items.length,
    };
};
