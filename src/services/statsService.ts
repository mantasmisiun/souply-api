import pool from '../config/db.js';
import type { Locale } from '../middleware/locale.js';
import { fetchUserPersonalRescues } from './receiptHydrationService.js';

const CHAIN_COLORS: Record<string, string> = {
    'Rimi':   '#E31E2D',
    'Lidl':   '#0095D9',
    'IKI':    '#FFD100',
    'Norf':   '#4CAF50',
    'Maxima': '#003DA5',
};

// Chain names in the DB can have suffixes ("Maxima LT UAB") — do a case-insensitive
// partial match so any variant resolves to the correct brand color.
function getChainColor(chainName: string): string {
    if (CHAIN_COLORS[chainName]) return CHAIN_COLORS[chainName];
    const upper = chainName.toUpperCase();
    for (const [key, color] of Object.entries(CHAIN_COLORS)) {
        if (upper.includes(key.toUpperCase())) return color;
    }
    return '#888888';
}

const CATEGORY_COLORS = [
    '#6366F1', // indigo
    '#F59E0B', // amber
    '#10B981', // emerald
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#8B5CF6', // violet
    '#F97316', // orange
    '#3B82F6', // blue
    '#84CC16', // lime
    '#14B8A6', // teal
];

const LT_MONTHS = ['sau', 'vas', 'kov', 'bal', 'geg', 'bir', 'lie', 'rgp', 'rgs', 'spa', 'lap', 'grd'];

// ---------------------------------------------------------------------------
// Pure helpers — exported so they can be unit-tested without a DB connection
// ---------------------------------------------------------------------------

export interface SavingsItem {
    storeProductId: number;
    price: number;       // unit price from the receipt
    quantity: number;
}

/**
 * Pure computation: given a mapping of storeProductId→productId and
 * productId→average market price, return the total savings for a set of
 * receipt items.  Savings per item = (avgPrice - receiptPrice) * quantity.
 * A positive total means the user paid less than the market average.
 */
export function computeSavingsFromPrices(
    items: SavingsItem[],
    spToProduct: Map<number, number>,
    productAvgPrice: Map<number, number>,
): number {
    let total = 0;
    for (const item of items) {
        if (!item.storeProductId || item.price <= 0) continue;
        const productId = spToProduct.get(item.storeProductId);
        if (productId === undefined) continue;
        const avg = productAvgPrice.get(productId);
        if (!avg || avg <= 0) continue;
        total += (avg - item.price) * (item.quantity || 1);
    }
    return Math.round(total * 100) / 100;
}

// ---------------------------------------------------------------------------
// DB-backed computation — called from receiptSaveService after prices are saved
// ---------------------------------------------------------------------------

/**
 * Receipt-level COMBO/SET-deal discount (e.g. IKI's bare "RINKINYS -1,90") captured by the
 * parser into parsedData.footer.comboDiscount — a POSITIVE magnitude of money off the paid
 * total that belongs to NO single product (which products form the bundle is unknown, so it
 * is never distributed onto lines and never touches reference prices). Consumers ADD it to
 * savings and SUBTRACT it from the visited-store basket total. Defensive: non-finite,
 * non-positive, or absurdly large (> cap) values collapse toward 0/cap.
 */
export const comboDiscountOf = (parsedData: any, cap = Infinity): number => {
    const v = Number(parsedData?.footer?.comboDiscount);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.round(Math.min(v, cap) * 100) / 100;
};

/**
 * Fetches the average latest market price for each matched receipt item,
 * then delegates to the pure computeSavingsFromPrices function.
 * Uses a batch of 3 queries regardless of item count.
 */
export const computeReceiptSavings = async (
    items: SavingsItem[],
    conn?: any,
): Promise<number> => {
    const db = conn ?? pool;
    const eligible = items.filter(i => i.storeProductId > 0 && i.price > 0);
    if (eligible.length === 0) return 0;

    const spIds = eligible.map(i => i.storeProductId);

    const [spRows]: any = await db.query(
        'SELECT id, productId FROM StoreProduct WHERE id IN (?)',
        [spIds],
    );
    const spToProduct = new Map<number, number>();
    for (const row of spRows) spToProduct.set(Number(row.id), Number(row.productId));

    const productIds = [...new Set(spToProduct.values())];
    if (productIds.length === 0) return 0;

    // For each product, average the most recent price across all StoreProducts.
    // Include both real receipt prices (isFallback=0) and scraped catalog prices
    // (isFallback=1 AND receiptId IS NULL). Scraped prices are direct catalog
    // scrapes from Rimi/IKI/Barbora — they're genuine cross-chain market data.
    // Exclude only within-chain propagated fallbacks (isFallback=1 AND
    // receiptId IS NOT NULL), which are copies of the source store's price and
    // would bias the average toward the uploading chain.
    const [avgRows]: any = await db.query(
        `SELECT sp.productId,
                AVG(p.price) AS avg_price
           FROM Price p
           JOIN (
               SELECT storeProductId, MAX(\`date\`) AS maxDate
                 FROM Price
                WHERE storeProductId IN (
                      SELECT id FROM StoreProduct WHERE productId IN (?)
                )
                  AND (isFallback = 0 OR receiptId IS NULL)
                GROUP BY storeProductId
           ) latest ON latest.storeProductId = p.storeProductId
                    AND latest.maxDate = p.\`date\`
           JOIN StoreProduct sp ON sp.id = p.storeProductId
          WHERE sp.productId IN (?)
            AND (p.isFallback = 0 OR p.receiptId IS NULL)
          GROUP BY sp.productId`,
        [productIds, productIds],
    );
    const productAvgPrice = new Map<number, number>();
    for (const row of avgRows) productAvgPrice.set(Number(row.productId), parseFloat(row.avg_price));

    return computeSavingsFromPrices(eligible, spToProduct, productAvgPrice);
};

// ---------------------------------------------------------------------------
// Stats aggregation for the profile screen
// ---------------------------------------------------------------------------

export const getUserStats = async (userId: string, locale: Locale = 'lt') => {
    const [receipts]: any = await pool.query(
        `SELECT r.id, r.receiptDate, r.parsedData, sc.name AS chainName, sc.miniLogoUrl AS chainMiniLogoUrl
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.userId = ? AND r.processingStatus = 'completed'`,
        [userId],
    );

    const storeMap: Record<string, number> = {};
    const chainMiniLogoMap: Record<string, string | null> = {};
    const categoryMap: Record<string, number> = {};
    const monthMap: Record<string, number> = {};
    // month (`YYYY-MM`) → chainName → spend, for the per-month store breakdown
    // (the profile Stores donut is scoped to a selectable month).
    const storeMonthMap: Record<string, Record<string, number>> = {};
    // month (`YYYY-MM`) → L2 categoryName → spend, for the per-month category
    // breakdown (the profile Categories donut is scoped to a selectable month).
    const categoryMonthMap: Record<string, Record<string, number>> = {};
    // spId → { productId, [{price, qty}] } — filled during the receipt loop
    // so both category aggregation and savings computation share one SP query.
    const spCategoryMap = new Map<number, string>();
    const spToProductId = new Map<number, number>();
    // spId → [{price, qty, month}] collected from all receipt items with a
    // matched SP. `month` (local `YYYY-MM`, null when the receipt has no date)
    // lets savings be bucketed per calendar month for the this-month figure.
    const spPriceList = new Map<number, Array<{ price: number; qty: number; month: string | null; day: number | null }>>();
    // productId → the user's personal orphan rescue (Nepriskirta → real category
    // via their own "same" votes). Empty when there are no matched SPs.
    let rescueByProduct = new Map<number, { categoryId: number | null; leafName: string | null; l2Name: string | null }>();

    // Per-receipt item lists, resolved ONCE for both passes below.
    let perReceiptItems: Array<{ receipt: any; items: any[] }> = [];

    if (receipts.length > 0) {
        // ReceiptItem rows are the item source since the ReceiptItem cutover — the
        // stored blob keeps products: [] so reading parsedData here would silently
        // drop every post-cutover receipt from stats/savings. One batch query;
        // matchedSpId is aliased to the blob's storeProductId shape so the
        // aggregation below is source-agnostic. The blob products/items remain
        // ONLY as the legacy fallback for receipts that predate the migration
        // (no ReceiptItem rows, e.g. an un-backfilled environment).
        const [itemRows]: any = await pool.query(
            `SELECT receiptId, matchedSpId AS storeProductId, price, promoPrice, quantity
               FROM ReceiptItem
              WHERE receiptId IN (?)`,
            [receipts.map((r: any) => Number(r.id))],
        );
        const itemsByReceipt = new Map<number, any[]>();
        for (const row of itemRows) {
            const list = itemsByReceipt.get(Number(row.receiptId)) ?? [];
            list.push(row);
            itemsByReceipt.set(Number(row.receiptId), list);
        }
        perReceiptItems = receipts.map((receipt: any) => {
            const rows = itemsByReceipt.get(Number(receipt.id));
            if (rows && rows.length > 0) return { receipt, items: rows };
            const parsed = typeof receipt.parsedData === 'string'
                ? JSON.parse(receipt.parsedData)
                : receipt.parsedData;
            return { receipt, items: parsed?.products ?? parsed?.items ?? [] };
        });

        // Pass 1: collect all unique storeProductIds for the batch SP lookup.
        const allSpIds: number[] = [];
        for (const { items } of perReceiptItems) {
            for (const item of items) {
                if (item.storeProductId) allSpIds.push(Number(item.storeProductId));
            }
        }

        // One query: sp → productId + L2 category name.
        // Products can be filed at L1, L2, or L3. We always want the L2
        // label so the breakdown uses mid-level buckets ("Šviežia mėsa ir
        // paukštiena") rather than L1 mega-buckets ("Mėsa, žuvis ir
        // kulinarija") or L3 micro-labels ("Marinuota kiauliena ir jautiena").
        //
        // c  = product's direct category (any level)
        // c2 = c's parent (NULL when c is L1)
        //
        // Resolution:
        //   c.parentCategoryId IS NULL  → c is L1 → NULL (excluded from breakdown)
        //   c2.parentCategoryId IS NULL → c is L2 → use c.name ✓
        //   otherwise                  → c is L3  → use c2.name (the L2 parent)
        if (allSpIds.length > 0) {
            const uniqueSpIds = [...new Set(allSpIds)];
            const [spRows]: any = await pool.query(
                `SELECT sp.id AS spId, sp.productId, p.categoryId AS rawCategoryId,
                        CASE
                          WHEN c.parentCategoryId IS NULL  THEN NULL
                          WHEN c2.parentCategoryId IS NULL THEN COALESCE(ct.name, c.name)
                          ELSE COALESCE(ct2.name, c2.name)
                        END AS categoryName
                   FROM StoreProduct sp
                   JOIN Product p  ON p.id  = sp.productId
                   JOIN Category c ON c.id  = p.categoryId
                   LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
                   LEFT JOIN CategoryTranslation ct  ON ct.categoryId  = c.id  AND ct.locale  = ?
                   LEFT JOIN CategoryTranslation ct2 ON ct2.categoryId = c2.id AND ct2.locale = ?
                  WHERE sp.id IN (?)`,
                [locale, locale, uniqueSpIds],
            );
            const orphanProductIds = new Set<number>();
            for (const row of spRows) {
                spCategoryMap.set(Number(row.spId), row.categoryName);
                spToProductId.set(Number(row.spId), Number(row.productId));
                // 688 = hidden Nepriskirta bucket (same constant the resolver +
                // receiptHydrationService use). Only these need a rescue.
                if (Number(row.rawCategoryId) === 688) orphanProductIds.add(Number(row.productId));
            }

            // Apply the user's personal orphan rescues — the SAME source the
            // receipt detail uses (fetchUserPersonalRescues) — but ONLY when an
            // actual Nepriskirta orphan is present, so the common case keeps its
            // 3-query budget. Orphans have no catalog L2 (the CASE returns NULL)
            // and would vanish from the donut; the rescue maps them to the
            // category the user sees on the receipt. Keyed by productId so a vote
            // on one chain's SP rescues every sibling SP.
            if (orphanProductIds.size > 0) {
                rescueByProduct = await fetchUserPersonalRescues(userId, [...orphanProductIds], locale);
            }
        }

        // Pass 2: aggregate spending + collect (spId, price, qty) for savings.
        for (const { receipt, items } of perReceiptItems) {
            const chainName: string = receipt.chainName ?? 'Kita';
            if (!(chainName in chainMiniLogoMap)) {
                chainMiniLogoMap[chainName] = receipt.chainMiniLogoUrl ?? null;
            }
            // Local calendar month — NOT toISOString(), which shifts by the
            // container's UTC offset and can file a late-evening receipt in the
            // previous month. Matches the bucket keys generated below.
            const md = receipt.receiptDate ? new Date(receipt.receiptDate) : null;
            const month = md ? `${md.getFullYear()}-${String(md.getMonth() + 1).padStart(2, '0')}` : null;

            for (const item of items) {
                // Use promoPrice when set — that's what the user actually paid.
                const unitPrice = (item.promoPrice != null && parseFloat(item.promoPrice) > 0)
                    ? parseFloat(item.promoPrice)
                    : parseFloat(item.price) || 0;
                const qty = parseFloat(item.quantity) || 1;
                const itemTotal = unitPrice * qty;
                if (itemTotal <= 0) continue;
                storeMap[chainName] = (storeMap[chainName] ?? 0) + itemTotal;
                const spId = item.storeProductId ? Number(item.storeProductId) : 0;
                let catName = spId ? spCategoryMap.get(spId) : undefined;
                // Orphan (Nepriskirta) lines have no catalog L2 → fall back to
                // the user's personal rescue so they appear under the category
                // shown on the receipt instead of being dropped.
                if (!catName && spId) {
                    const pid = spToProductId.get(spId);
                    const rescued = pid != null ? rescueByProduct.get(pid)?.l2Name : undefined;
                    if (rescued) catName = rescued;
                }
                if (catName) {
                    categoryMap[catName] = (categoryMap[catName] ?? 0) + itemTotal;
                    if (month) {
                        const cm = (categoryMonthMap[month] ??= {});
                        cm[catName] = (cm[catName] ?? 0) + itemTotal;
                    }
                }
                if (month) {
                    monthMap[month] = (monthMap[month] ?? 0) + itemTotal;
                    const sm = (storeMonthMap[month] ??= {});
                    sm[chainName] = (sm[chainName] ?? 0) + itemTotal;
                }
                // Accumulate for savings — only matched SPs with a known productId.
                if (spId && unitPrice > 0 && spToProductId.has(spId)) {
                    const list = spPriceList.get(spId) ?? [];
                    list.push({ price: unitPrice, qty, month, day: md ? md.getDate() : null });
                    spPriceList.set(spId, list);
                }
            }
        }
    }

    // Dynamic savings: compare each receipt item's price against the live
    // cross-chain market average. Computed from the ReceiptItem rows (blob
    // fallback for pre-migration receipts) so historical receipts
    // (savedAmount defaulted to 0) are correctly included.
    // Includes both real receipt prices (isFallback=0) AND scraped catalog
    // prices (isFallback=1, receiptId IS NULL). Excludes within-chain
    // propagated fallbacks (isFallback=1, receiptId IS NOT NULL).
    let totalSavings = 0;
    // Savings bucketed by receipt month (`YYYY-MM`) so the profile card can
    // show the current-month figure and its change vs last month. Same
    // avg-vs-paid formula as the all-time total — only the grouping differs.
    const monthSavingsMap: Record<string, number> = {};
    // MTD baseline: last month's savings only through the SAME day-of-month,
    // so a half-elapsed month isn't compared against a complete one (the chip
    // would otherwise point down all month). The cutoff is clamped to last
    // month's real length — on May 31 vs April (30d) or March 30 vs February
    // (28/29d) the whole shorter month counts, which is the standard
    // month-to-date convention.
    const nowM = new Date();
    const thisMonthKey = `${nowM.getFullYear()}-${String(nowM.getMonth() + 1).padStart(2, '0')}`;
    const lastM = new Date(nowM.getFullYear(), nowM.getMonth() - 1, 1);
    const lastMonthKey = `${lastM.getFullYear()}-${String(lastM.getMonth() + 1).padStart(2, '0')}`;
    // Day 0 of the current month = last day of the previous month (handles
    // 28/29/30/31 automatically, leap years included).
    const daysInLastMonth = new Date(nowM.getFullYear(), nowM.getMonth(), 0).getDate();
    const mtdCutoffDay = Math.min(nowM.getDate(), daysInLastMonth);
    let lastMonthMtdSavings = 0;
    if (spPriceList.size > 0) {
        // spPriceList only contains spIds that are in spToProductId (guarded above).
        const productIds = [...new Set(
            [...spPriceList.keys()].map(spId => spToProductId.get(spId)!).filter(Boolean),
        )];

        if (productIds.length > 0) {
            const [avgRows]: any = await pool.query(
                `SELECT sp.productId, AVG(p.price) AS avg_price
                   FROM Price p
                   JOIN (
                       SELECT storeProductId, MAX(\`date\`) AS maxDate
                         FROM Price
                        WHERE storeProductId IN (
                              SELECT id FROM StoreProduct WHERE productId IN (?)
                        )
                          AND (isFallback = 0 OR receiptId IS NULL)
                        GROUP BY storeProductId
                   ) latest ON latest.storeProductId = p.storeProductId
                            AND latest.maxDate = p.\`date\`
                   JOIN StoreProduct sp ON sp.id = p.storeProductId
                  WHERE sp.productId IN (?)
                    AND (p.isFallback = 0 OR p.receiptId IS NULL)
                  GROUP BY sp.productId`,
                [productIds, productIds],
            );
            const productAvgPrice = new Map<number, number>();
            for (const row of avgRows) {
                productAvgPrice.set(Number(row.productId), parseFloat(row.avg_price));
            }

            for (const [spId, purchases] of spPriceList) {
                const productId = spToProductId.get(spId);
                if (!productId) continue;
                const avg = productAvgPrice.get(productId);
                if (!avg || avg <= 0) continue;
                for (const { price, qty, month, day } of purchases) {
                    const saved = (avg - price) * qty;
                    totalSavings += saved;
                    if (month) {
                        monthSavingsMap[month] = (monthSavingsMap[month] ?? 0) + saved;
                        if (month === lastMonthKey && day != null && day <= mtdCutoffDay) {
                            lastMonthMtdSavings += saved;
                        }
                    }
                }
            }
        }
    }
    totalSavings = Math.round(totalSavings * 100) / 100;

    // This-month savings + change vs the SAME PERIOD last month (keys and the
    // MTD cutoff computed above, before the accumulation loop). Local calendar
    // months, NOT toISOString().
    const savingsThisMonth = Math.round((monthSavingsMap[thisMonthKey] ?? 0) * 100) / 100;
    // The baseline is month-to-date-clamped (day ≤ mtdCutoffDay) so the €-delta
    // chip compares like with like all month long. A percentage change was
    // intentionally dropped: it's unstable for a signed savings metric (sign
    // flips + tiny denominators make e.g. a 14-cent baseline read as "-101%").
    const savingsLastMonth = Math.round(lastMonthMtdSavings * 100) / 100;

    const storeBreakdown = Object.entries(storeMap)
        .map(([chainName, total]) => ({
            chainName,
            total: Math.round(total * 100) / 100,
            color: getChainColor(chainName),
            miniLogoUrl: chainMiniLogoMap[chainName] ?? null,
        }))
        .sort((a, b) => b.total - a.total);

    // Same store breakdown, but bucketed per calendar month so the profile
    // Stores donut can page through months. Each month's slices are sorted
    // desc; the client derives per-store percentages from these totals.
    const storeBreakdownByMonth: Record<string, typeof storeBreakdown> = {};
    for (const [month, chains] of Object.entries(storeMonthMap)) {
        storeBreakdownByMonth[month] = Object.entries(chains)
            .map(([chainName, total]) => ({
                chainName,
                total: Math.round(total * 100) / 100,
                color: getChainColor(chainName),
                miniLogoUrl: chainMiniLogoMap[chainName] ?? null,
            }))
            .sort((a, b) => b.total - a.total);
    }

    const TOP_CATEGORIES = 5;
    const sortedCategories = Object.entries(categoryMap)
        .map(([categoryName, total]) => ({ categoryName, total: Math.round(total * 100) / 100 }))
        .sort((a, b) => b.total - a.total);
    const topCategories = sortedCategories.slice(0, TOP_CATEGORIES);
    const kitaItems = sortedCategories.slice(TOP_CATEGORIES);
    const remainderTotal = kitaItems.reduce((s, c) => s + c.total, 0);
    if (remainderTotal > 0) {
        topCategories.push({ categoryName: 'Kitos', total: Math.round(remainderTotal * 100) / 100 });
    }
    const categoryBreakdown = topCategories.map((item, i) => ({
        ...item,
        color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));
    const kitaBreakdown = kitaItems.map((item, i) => ({
        ...item,
        color: CATEGORY_COLORS[(TOP_CATEGORIES + i) % CATEGORY_COLORS.length],
    }));

    // Full per-month category breakdown (NOT truncated to top-N — the client
    // applies its own top-N/"Kitos" split so it can toggle 5↔10). Sorted desc
    // with a stable color per position; the client derives percentages.
    const categoryBreakdownByMonth: Record<string, Array<{ categoryName: string; total: number; color: string }>> = {};
    for (const [month, cats] of Object.entries(categoryMonthMap)) {
        categoryBreakdownByMonth[month] = Object.entries(cats)
            .map(([categoryName, total]) => ({ categoryName, total: Math.round(total * 100) / 100 }))
            .sort((a, b) => b.total - a.total)
            .map((item, i) => ({ ...item, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }));
    }

    // Full monthly series from the earliest month with data (or 6 months ago,
    // whichever is earlier) up to the current month, zero-filled. The client
    // shows a 6-month window and can page back to see older data. Keys use
    // local calendar components to match the month assignment in Pass 2.
    const now = new Date();
    const fmtKey = (y: number, mZero: number) => `${y}-${String(mZero + 1).padStart(2, '0')}`;
    const currentKey = fmtKey(now.getFullYear(), now.getMonth());
    const sixAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const sixAgoKey = fmtKey(sixAgo.getFullYear(), sixAgo.getMonth());
    const dataKeys = Object.keys(monthMap).sort();
    const earliestKey = dataKeys.length > 0 && dataKeys[0] < sixAgoKey ? dataKeys[0] : sixAgoKey;

    const monthlySpending: { month: string; label: string; total: number }[] = [];
    let [yy, mm] = earliestKey.split('-').map(Number); // mm is 1..12
    // Guard caps the series at 20 years so a corrupt far-past date can't
    // generate a runaway array.
    for (let guard = 0; guard < 240; guard++) {
        const key = `${yy}-${String(mm).padStart(2, '0')}`;
        monthlySpending.push({
            month: key,
            label: LT_MONTHS[mm - 1],
            total: Math.round((monthMap[key] ?? 0) * 100) / 100,
        });
        if (key === currentKey) break;
        mm++;
        if (mm > 12) { mm = 1; yy++; }
    }

    return {
        storeBreakdown, storeBreakdownByMonth, categoryBreakdown, kitaBreakdown,
        categoryBreakdownByMonth, monthlySpending, totalSavings, savingsThisMonth,
        savingsLastMonth,
    };
};
