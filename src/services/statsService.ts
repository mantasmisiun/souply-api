import pool from '../config/db.js';

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
    '#6366F1', '#EC4899', '#F59E0B', '#10B981',
    '#3B82F6', '#EF4444', '#8B5CF6', '#14B8A6',
    '#F97316', '#84CC16',
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

export const getUserStats = async (userId: string) => {
    const [receipts]: any = await pool.query(
        `SELECT r.receiptDate, r.parsedData, sc.name AS chainName
           FROM Receipt r
           LEFT JOIN Store s ON s.id = r.storeId
           LEFT JOIN StoreChain sc ON sc.id = s.chainId
          WHERE r.userId = ? AND r.processingStatus = 'completed'`,
        [userId],
    );

    const storeMap: Record<string, number> = {};
    const categoryMap: Record<string, number> = {};
    const monthMap: Record<string, number> = {};
    // spId → { productId, [{price, qty}] } — filled during the receipt loop
    // so both category aggregation and savings computation share one SP query.
    const spCategoryMap = new Map<number, string>();
    const spToProductId = new Map<number, number>();
    // spId → [{price, qty}] collected from all receipt items with a matched SP.
    const spPriceList = new Map<number, Array<{ price: number; qty: number }>>();

    if (receipts.length > 0) {
        // Pass 1: collect all unique storeProductIds for the batch SP lookup.
        const allSpIds: number[] = [];
        for (const receipt of receipts) {
            const parsed = typeof receipt.parsedData === 'string'
                ? JSON.parse(receipt.parsedData)
                : receipt.parsedData;
            for (const item of (parsed?.products ?? parsed?.items ?? [])) {
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
                `SELECT sp.id AS spId, sp.productId,
                        CASE
                          WHEN c.parentCategoryId IS NULL  THEN NULL
                          WHEN c2.parentCategoryId IS NULL THEN c.name
                          ELSE c2.name
                        END AS categoryName
                   FROM StoreProduct sp
                   JOIN Product p  ON p.id  = sp.productId
                   JOIN Category c ON c.id  = p.categoryId
                   LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
                  WHERE sp.id IN (?)`,
                [uniqueSpIds],
            );
            for (const row of spRows) {
                spCategoryMap.set(Number(row.spId), row.categoryName);
                spToProductId.set(Number(row.spId), Number(row.productId));
            }
        }

        // Pass 2: aggregate spending + collect (spId, price, qty) for savings.
        for (const receipt of receipts) {
            const parsed = typeof receipt.parsedData === 'string'
                ? JSON.parse(receipt.parsedData)
                : receipt.parsedData;
            const items: any[] = parsed?.products ?? parsed?.items ?? [];
            const chainName: string = receipt.chainName ?? 'Kita';
            const month = receipt.receiptDate
                ? new Date(receipt.receiptDate).toISOString().slice(0, 7)
                : null;

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
                const catName = spId ? spCategoryMap.get(spId) : undefined;
                if (catName) {
                    categoryMap[catName] = (categoryMap[catName] ?? 0) + itemTotal;
                }
                if (month) {
                    monthMap[month] = (monthMap[month] ?? 0) + itemTotal;
                }
                // Accumulate for savings — only matched SPs with a known productId.
                if (spId && unitPrice > 0 && spToProductId.has(spId)) {
                    const list = spPriceList.get(spId) ?? [];
                    list.push({ price: unitPrice, qty });
                    spPriceList.set(spId, list);
                }
            }
        }
    }

    // Dynamic savings: compare each receipt item's price against the live
    // cross-chain market average. Computed from parsedData so historical
    // receipts (savedAmount defaulted to 0) are correctly included.
    // Includes both real receipt prices (isFallback=0) AND scraped catalog
    // prices (isFallback=1, receiptId IS NULL). Excludes within-chain
    // propagated fallbacks (isFallback=1, receiptId IS NOT NULL).
    let totalSavings = 0;
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
                for (const { price, qty } of purchases) {
                    totalSavings += (avg - price) * qty;
                }
            }
        }
    }
    totalSavings = Math.round(totalSavings * 100) / 100;

    const storeBreakdown = Object.entries(storeMap)
        .map(([chainName, total]) => ({
            chainName,
            total: Math.round(total * 100) / 100,
            color: getChainColor(chainName),
        }))
        .sort((a, b) => b.total - a.total);

    const TOP_CATEGORIES = 5;
    const sortedCategories = Object.entries(categoryMap)
        .map(([categoryName, total]) => ({ categoryName, total: Math.round(total * 100) / 100 }))
        .sort((a, b) => b.total - a.total);
    const topCategories = sortedCategories.slice(0, TOP_CATEGORIES);
    const remainderTotal = sortedCategories.slice(TOP_CATEGORIES).reduce((s, c) => s + c.total, 0);
    if (remainderTotal > 0) {
        topCategories.push({ categoryName: 'Kita', total: Math.round(remainderTotal * 100) / 100 });
    }
    const categoryBreakdown = topCategories.map((item, i) => ({
        ...item,
        color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));

    const now = new Date();
    const monthlySpending = Array.from({ length: 6 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
        const key = d.toISOString().slice(0, 7);
        return {
            month: key,
            label: LT_MONTHS[d.getMonth()],
            total: Math.round((monthMap[key] ?? 0) * 100) / 100,
        };
    });

    return { storeBreakdown, categoryBreakdown, monthlySpending, totalSavings };
};
