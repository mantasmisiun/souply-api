import pool from '../config/db.js';
import { computeReceiptSavings, UNCATEGORISED_CAT } from './statsService.js';
import { tripSavingsDeltas, type TripSavingsDeltas } from './comparisonSnapshotService.js';
import { fetchUserPersonalRescues } from './receiptHydrationService.js';
import type { Locale } from '../middleware/locale.js';

/**
 * Souply 2.0 Phase 5 (first slice) — per-trip stats: spend, category donut,
 * per-chain split and per-member contributions, aggregated STRICTLY from
 * ReceiptItem rows (never the parsedData blob — plan rule). Savings uses the
 * live avg-vs-paid semantic shared with the profile card; the frozen
 * "Sutaupyta / Galėjai sutaupyti" comparable-store deltas land with the
 * persisted-comparison slice later in Phase 5.
 */

export interface TripSpendEntry {
    tripId: number;
    name: string | null;
    anchorDate: string;
    totalSpent: number;
}

/** Local YYYY-MM bucket for a trip's anchor date (matches the monthly-stats and
 *  Shopping-card convention — local calendar month). */
const monthKey = (d: any): string => {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Per-TRIP spend for every non-archived trip the user belongs to whose ANCHOR
 * date falls in the given month (default: current). Feeds the "Kelionės" donut
 * (this trip preselected vs the month's other trips). The trip is the unit —
 * assigned to one month by anchorDate — so receipts spanning weeks/months never
 * split a trip. Same itemTotal math as getTripStats.
 */
export const getMonthlyTripSpend = async (userId: string, month?: string): Promise<TripSpendEntry[]> => {
    const target = month && /^\d{4}-\d{2}$/.test(month) ? month : monthKey(new Date());
    const [trips]: any = await pool.query(
        `SELECT t.id AS tripId, t.name,
                COALESCE(
                  (SELECT MAX(r.receiptDate) FROM Receipt r WHERE r.tripId = t.id AND r.userDeletedAt IS NULL
                     AND (r.mandatorySwipesRequired = 0 OR r.mandatorySwipesCompleted >= r.mandatorySwipesRequired)),
                  (SELECT MAX(sl.createdAt)   FROM ShoppingList sl WHERE sl.tripId = t.id),
                  t.createdAt
                ) AS anchorDate
           FROM Trip t
           JOIN TripMember tm ON tm.tripId = t.id
          WHERE tm.userId = ? AND t.archivedAt IS NULL`,
        [userId],
    );
    const inMonth = (trips as any[]).filter(t => monthKey(t.anchorDate) === target);
    if (inMonth.length === 0) return [];

    const ids = inMonth.map(t => Number(t.tripId));
    const [items]: any = await pool.query(
        `SELECT r.tripId, ri.price, ri.promoPrice, ri.quantity
           FROM ReceiptItem ri JOIN Receipt r ON r.id = ri.receiptId
          WHERE r.tripId IN (?) AND r.userDeletedAt IS NULL
            AND (r.mandatorySwipesRequired = 0 OR r.mandatorySwipesCompleted >= r.mandatorySwipesRequired)`,
        [ids],
    );
    const spendByTrip = new Map<number, number>();
    for (const it of items as any[]) {
        const unit = (it.promoPrice != null && parseFloat(it.promoPrice) > 0)
            ? parseFloat(it.promoPrice) : parseFloat(it.price) || 0;
        const total = unit * (parseFloat(it.quantity) || 1);
        if (total <= 0) continue;
        spendByTrip.set(Number(it.tripId), (spendByTrip.get(Number(it.tripId)) ?? 0) + total);
    }
    return inMonth
        // Finished trips only — a shop with no uploaded (published) receipt has no
        // spend and shouldn't clutter the "Apsipirkimai" donut as a €0 slice.
        .filter(t => spendByTrip.has(Number(t.tripId)))
        .map(t => ({
            tripId: Number(t.tripId),
            name: t.name ?? null,
            anchorDate: String(t.anchorDate),
            totalSpent: Math.round((spendByTrip.get(Number(t.tripId)) ?? 0) * 100) / 100,
        }))
        .sort((a, b) => b.totalSpent - a.totalSpent);
};

export interface TripStats {
    tripId: number;
    /** Frozen comparable-store deltas (null until snapshots exist). */
    savedVsMedian: number | null;
    couldHaveSaved: number | null;
    receiptCount: number;
    totalSpent: number;
    savings: number;
    promoItemCount: number;
    promoSavings: number;
    categoryBreakdown: { categoryName: string; total: number }[];
    chainBreakdown: { chainName: string; total: number }[];
    memberSpend: { userId: string; name: string | null; avatarColor: string | null; total: number; receiptCount: number }[];
}

export const getTripStats = async (
    tripId: number,
    viewerUserId?: string,
    locale: Locale = 'lt',
): Promise<TripStats> => {
    const [receipts]: any = await pool.query(
        `SELECT r.id, r.uploaderUserId, r.userId, sc.name AS chainName
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.tripId = ?
            AND r.userDeletedAt IS NULL
            AND (r.mandatorySwipesRequired = 0 OR r.mandatorySwipesCompleted >= r.mandatorySwipesRequired)`,
        [tripId],
    );
    const empty: TripStats = {
        tripId, receiptCount: 0, totalSpent: 0, savings: 0,
        promoItemCount: 0, promoSavings: 0,
        savedVsMedian: null, couldHaveSaved: null,
        categoryBreakdown: [], chainBreakdown: [], memberSpend: [],
    };
    if (receipts.length === 0) return empty;
    const deltas: TripSavingsDeltas = await tripSavingsDeltas(tripId);
    empty.savedVsMedian = deltas.savedVsMedian;
    empty.couldHaveSaved = deltas.couldHaveSaved;
    const receiptIds = receipts.map((r: any) => Number(r.id));

    const [itemRows]: any = await pool.query(
        `SELECT receiptId, matchedSpId AS storeProductId, price, promoPrice, quantity
           FROM ReceiptItem
          WHERE receiptId IN (?)`,
        [receiptIds],
    );
    if (itemRows.length === 0) return { ...empty, receiptCount: receipts.length };

    // SP → L2 category (same resolution as the profile stats: L2 label,
    // L3 rolls up to its parent, L1 is excluded from the donut).
    const spIds = [...new Set(itemRows.map((r: any) => Number(r.storeProductId)).filter((v: number) => v > 0))];
    const spCategory = new Map<number, string>();
    // For the personal orphan-rescue overlay (mirrors getUserStats): sp → product,
    // and the set of 688 orphan products so a viewer's own 'same' vote re-categorises
    // the item in THEIR trip donut instead of it sitting in Nepriskirta.
    const spToProductId = new Map<number, number>();
    const orphanProductIds = new Set<number>();
    let rescueByProduct: Awaited<ReturnType<typeof fetchUserPersonalRescues>> = new Map();
    if (spIds.length > 0) {
        const [spRows]: any = await pool.query(
            `SELECT sp.id AS spId, sp.productId AS productId, p.categoryId AS rawCategoryId,
                    CASE
                        WHEN c.parentCategoryId IS NULL THEN NULL
                        WHEN c2.parentCategoryId IS NULL THEN c.name
                        ELSE c2.name
                    END AS categoryName
               FROM StoreProduct sp
               JOIN Product p ON p.id = sp.productId
               LEFT JOIN Category c ON c.id = p.categoryId
               LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
              WHERE sp.id IN (?)`,
            [spIds],
        );
        for (const row of spRows) {
            spToProductId.set(Number(row.spId), Number(row.productId));
            if (row.categoryName) spCategory.set(Number(row.spId), String(row.categoryName));
            if (Number(row.rawCategoryId) === 688) orphanProductIds.add(Number(row.productId));
        }
        if (viewerUserId && orphanProductIds.size > 0) {
            rescueByProduct = await fetchUserPersonalRescues(viewerUserId, [...orphanProductIds], locale);
        }
    }

    const receiptById = new Map<number, any>(receipts.map((r: any) => [Number(r.id), r]));
    const round2 = (n: number) => Math.round(n * 100) / 100;

    let totalSpent = 0;
    let promoItemCount = 0;
    let promoSavings = 0;
    const catMap: Record<string, number> = {};
    const chainMap: Record<string, number> = {};
    const memberMap: Record<string, { total: number; receipts: Set<number> }> = {};

    for (const item of itemRows) {
        const regular = parseFloat(item.price) || 0;
        const promo = item.promoPrice != null ? parseFloat(item.promoPrice) : 0;
        const unitPrice = promo > 0 ? promo : regular;
        const qty = parseFloat(item.quantity) || 1;
        const itemTotal = unitPrice * qty;
        if (itemTotal <= 0) continue;
        totalSpent += itemTotal;
        // Discount captured: a promo below the regular price.
        if (promo > 0 && regular > promo) { promoItemCount += 1; promoSavings += (regular - promo) * qty; }

        const receipt = receiptById.get(Number(item.receiptId));
        const chain = receipt?.chainName ?? 'Kita';
        chainMap[chain] = (chainMap[chain] ?? 0) + itemTotal;

        const member = receipt?.uploaderUserId ?? receipt?.userId ?? 'unknown';
        const m = (memberMap[member] ??= { total: 0, receipts: new Set() });
        m.total += itemTotal;
        m.receipts.add(Number(item.receiptId));

        // Items whose SP has no resolved L2 category (uncategorised / unmatched /
        // L1) must NOT be dropped — bucket them under the shared "Nepriskirta"
        // label so the donut's total reconciles with the real spend. First give a
        // 688 orphan the viewer's PERSONAL rescue (their own 'same' vote) so a swipe
        // moves it out of Nepriskirta on reload, keyed by product (all sibling SPs).
        const spId = Number(item.storeProductId);
        let cat = spCategory.get(spId);
        if (!cat && spId) {
            const pid = spToProductId.get(spId);
            const rescued = pid != null ? rescueByProduct.get(pid)?.l2Name : undefined;
            if (rescued) cat = rescued;
        }
        const catFinal = cat || UNCATEGORISED_CAT;
        catMap[catFinal] = (catMap[catFinal] ?? 0) + itemTotal;
    }

    const savings = await computeReceiptSavings(itemRows.map((i: any) => ({
        storeProductId: Number(i.storeProductId) || 0,
        price: (i.promoPrice != null && parseFloat(i.promoPrice) > 0) ? parseFloat(i.promoPrice) : parseFloat(i.price) || 0,
        quantity: parseFloat(i.quantity) || 1,
    })));

    // Member breakdown across EVERY trip member (0 for non-uploaders), with the
    // name + avatar colour for the per-user card. Two queries (no User JOIN) to
    // dodge the CI collation mismatch.
    const [memberRows]: any = await pool.query('SELECT userId FROM TripMember WHERE tripId = ?', [tripId]);
    const memberIds = [...new Set((memberRows as any[]).map(m => m.userId))];
    // Include any uploader who paid but isn't a formal member (edge case).
    for (const uid of Object.keys(memberMap)) if (uid !== 'unknown' && !memberIds.includes(uid)) memberIds.push(uid);
    const userById = new Map<string, { label: string | null; avatarColor: string | null }>();
    if (memberIds.length) {
        const [users]: any = await pool.query(
            'SELECT id, COALESCE(displayName, firstName, username) AS label, avatarColor FROM User WHERE id IN (?)',
            [memberIds]);
        for (const u of users) userById.set(u.id, { label: u.label ?? null, avatarColor: u.avatarColor ?? null });
    }
    const memberSpend = memberIds
        .map(userId => {
            const m = memberMap[userId];
            const u = userById.get(userId);
            return {
                userId,
                name: u?.label ?? null,
                avatarColor: u?.avatarColor ?? null,
                total: round2(m?.total ?? 0),
                receiptCount: m?.receipts.size ?? 0,
            };
        })
        .sort((a, b) => b.total - a.total);

    return {
        tripId,
        savedVsMedian: deltas.savedVsMedian,
        couldHaveSaved: deltas.couldHaveSaved,
        receiptCount: receipts.length,
        totalSpent: round2(totalSpent),
        savings: round2(savings),
        promoItemCount,
        promoSavings: round2(promoSavings),
        categoryBreakdown: Object.entries(catMap)
            .map(([categoryName, total]) => ({ categoryName, total: round2(total) }))
            .sort((a, b) => b.total - a.total),
        chainBreakdown: Object.entries(chainMap)
            .map(([chainName, total]) => ({ chainName, total: round2(total) }))
            .sort((a, b) => b.total - a.total),
        memberSpend,
    };
};
