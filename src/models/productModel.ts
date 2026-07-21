import pool from '../config/db.js';
import { nameSimilarity } from '../utils/productNameNormalize.js';
import { buildFuzzyNameClause } from '../utils/fuzzyNameClause.js';
import {
    loadCanonicalsForProducts,
    attachCanonicalFields,
} from '../services/productCanonical.js';
import { attachUnitPriceBadges } from '../services/productBadge.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';
import { localizedProductNameSql, type Locale } from '../middleware/locale.js';
import { productSearchClauses } from '../utils/productSearchMatch.js';

type Connection = typeof pool | any;

/** Similarity cutoff for auto-assigning baseProductId. Matches the cutoff used
 * by the one-shot seeding script (src/scripts/seedBaseProducts.ts). */
const AUTO_BASE_PRODUCT_THRESHOLD = RECOGNITION.resolve.autoBaseProductThreshold;

/**
 * Find the baseProductId a brand-new Product with this name should inherit
 * based on the most similar existing Product in the same category. Returns
 * null when no existing Product clears the similarity threshold — the new
 * Product becomes its own root. Always points at the cluster's root (a
 * Product with baseProductId IS NULL), never at another variant, so we
 * never create multi-level chains.
 */
export const resolveBaseProductId = async (
    name: string,
    categoryId: number,
    conn?: Connection
): Promise<number | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        'SELECT id, baseProductId, name FROM Product WHERE categoryId = ?',
        [categoryId]
    );
    let best: { rootId: number; sim: number } | null = null;
    for (const row of rows) {
        const sim = nameSimilarity(name, row.name);
        if (sim >= AUTO_BASE_PRODUCT_THRESHOLD && (!best || sim > best.sim)) {
            best = { rootId: row.baseProductId ?? row.id, sim };
        }
    }
    return best ? best.rootId : null;
};

export const createProduct = async (
    categoryId: number,
    baseProductId: number | null,
    name: string,
    conn?: Connection
) => {
    const db = conn || pool;
    // Auto-assign baseProductId when the caller doesn't supply one. Keeps the
    // "every Product belongs to a cluster" invariant self-maintaining on every
    // insert path (admin add, future receipt-create-as-new, etc.) without
    // callers needing to know about the clustering logic.
    const effectiveBaseProductId =
        baseProductId ?? (await resolveBaseProductId(name, categoryId, db));
    const [result]: any = await db.query(
        'INSERT INTO Product (categoryId, baseProductId, name) VALUES (?, ?, ?)',
        [categoryId, effectiveBaseProductId, name]
    );
    return result.insertId;
};

// Locale-aware: LT is a no-op (p.name + plain image aggregate); EN resolves the
// shortest English SP translation and leads the images with that SP's photo.
const productWithImagesSelect = (locale: Locale): string => {
    const loc = localizedProductNameSql(locale);
    return `
    p.id, p.categoryId, p.baseProductId, ${loc.nameSql} AS name,
    ${loc.imageUrlsSql} AS imageUrls
`;
};

export const searchProduct = async (query: string, locale: Locale = 'lt') => {
    // Match signals come from the ONE shared source (utils/productSearchMatch) so
    // /products/search and the Discounts filter never drift apart. Here we use
    // them for RANKING: name (rank 0) → stemmed name (rank 1) → SP name /
    // translations / aliases (ranks 2–4), each its own query, merged by rank.
    const sc = productSearchClauses(query, { nameCol: 'p.name', idCol: 'p.id' });
    const CAT_GATE = `JOIN Category cat ON cat.id = p.categoryId AND cat.name NOT LIKE 'Nepriskirt%'`;

    // ── Arm 1 (rank 0): full-token name match — today's behavior, highest rank.
    const [exact]: any = await pool.query(
        `${browseSelect(locale)}
         ${CAT_GATE}
         WHERE ${sc.nameFuzzy.sql}
           AND p.mergedIntoId IS NULL
         GROUP BY p.id
         ORDER BY p.globalScore DESC
         LIMIT 50`,
        sc.nameFuzzy.params,
    );

    // ── Arm 2 (rank 1): STEMMED name match — inflection recall ("saldi" →
    // "saldžios", "sojos" → "sojų").
    let stemmed: any[] = [];
    if (sc.nameStem && exact.length < 50) {
        [stemmed] = await pool.query(
            `${browseSelect(locale)}
             ${CAT_GATE}
             WHERE ${sc.nameStem.sql}
               AND p.mergedIntoId IS NULL
             GROUP BY p.id
             ORDER BY p.globalScore DESC
             LIMIT 50`,
            sc.nameStem.params,
        ) as any;
    }

    // Arms 3–5 resolve PRODUCT ids via the shared match module, then hydrate
    // through BROWSE_SELECT. Each arm only runs while earlier arms left room.
    const hydrate = async (ids: number[]): Promise<any[]> => {
        if (ids.length === 0) return [];
        const [rows]: any = await pool.query(
            `${browseSelect(locale)}
             ${CAT_GATE}
             WHERE p.id IN (?)
               AND p.mergedIntoId IS NULL
             GROUP BY p.id
             ORDER BY p.globalScore DESC`,
            [ids],
        );
        return rows;
    };
    const idArm = async (subquery: string, params: any[]): Promise<any[]> => {
        const [idRows]: any = await pool.query(`${subquery} LIMIT 50`, params);
        return hydrate(idRows.map((r: any) => r.productId));
    };

    let found = exact.length + stemmed.length;
    const vocabArms: any[][] = [];
    for (const arm of sc.rankedIdArms) {
        if (found >= 50) { vocabArms.push([]); continue; }
        const rows = await idArm(arm.sql, arm.params);
        vocabArms.push(rows);
        found += rows.length;
    }

    // Merge rank-ordered, dedup by product id, cap 50.
    const seen = new Set<number>();
    const products: any[] = [];
    for (const arm of [exact, stemmed, ...vocabArms]) {
        for (const p of arm) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            products.push(p);
            if (products.length >= 50) break;
        }
        if (products.length >= 50) break;
    }
    if (products.length === 0) return [];
    const categoryIds = [...new Set((products as any[]).map((p: any) => p.categoryId).filter(Boolean))];
    const [catRows]: any = categoryIds.length
        ? await pool.query(`SELECT id, name FROM Category WHERE id IN (?)`, [categoryIds])
        : [[]];
    const catNameMap: Record<number, string> = Object.fromEntries((catRows as any[]).map((r: any) => [r.id, r.name]));
    const productsWithCat = (products as any[]).map((p: any) => ({ ...p, categoryName: catNameMap[p.categoryId] ?? null }));
    const productIds = productsWithCat.map((p: any) => p.id);
    const canonicals = await loadCanonicalsForProducts(productIds);
    return attachUnitPriceBadges(attachCanonicalFields(productsWithCat, canonicals));
};

export const getProductById = async (id: number, locale: Locale = 'lt') => {
    const [products]: any = await pool.query(
        `${browseSelect(locale)} WHERE p.id = ? GROUP BY p.id`,
        [id]
    );
    const product = products[0] || null;
    if (!product) return null;
    const canonicals = await loadCanonicalsForProducts([product.id]);
    return attachCanonicalFields([product], canonicals)[0];
};

export const getProductsByCategory = async (categoryId: number, locale: Locale = 'lt') => {
    const [products]: any = await pool.query(
        `SELECT ${productWithImagesSelect(locale)} FROM Product p WHERE p.categoryId = ?`,
        [categoryId]
    );
    return products;
};

/**
 * Slim product-search payload for admin type-ahead pickers (Flags-tab
 * "this matched product is wrong" flow). Returns only the columns the
 * dropdown renders + needs on commit: id, canonical name, current
 * category id + name. No image arrays, no globalScore — those balloon
 * the response on a typeahead loop. Locale parameter is honoured so
 * the picker speaks the admin's language for category labels.
 */
export const searchProductsForAdmin = async (
    query: string,
    locale: 'lt' | 'en' = 'lt',
    limit: number = 10,
) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const fuzzy = buildFuzzyNameClause(trimmed, 'p.name');
    const [rows]: any = await pool.query(
        `SELECT p.id,
                p.name,
                p.categoryId,
                COALESCE(ct.name, c.name) AS categoryName
           FROM Product p
           LEFT JOIN Category c ON c.id = p.categoryId
           LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
          WHERE ${fuzzy.sql}
          ORDER BY p.globalScore DESC, p.id ASC
          LIMIT ?`,
        [locale, ...fuzzy.params, limit],
    );
    return rows.map((r: any) => ({
        id: Number(r.id),
        name: String(r.name),
        categoryId: r.categoryId !== null ? Number(r.categoryId) : null,
        categoryName: r.categoryName ?? null,
    }));
};

export const getProductByName = async (name: string, locale: Locale = 'lt') => {
    const [rows]: any = await pool.query(
        `SELECT ${productWithImagesSelect(locale)} FROM Product p WHERE p.name = ?`,
        [name]
    );
    return rows[0] || null;
};

export const updateProductCategory = async (storeProductId: number, categoryId: number) => {
    await pool.query(
        `UPDATE Product p
         JOIN StoreProduct sp ON sp.productId = p.id
         SET p.categoryId = ?
         WHERE sp.id = ?`,
        [categoryId, storeProductId]
    );
};

export type BrowseMode = 'base' | 'sku';

/**
 * Amount normalization expression for the browse aggregates.
 *
 * Mass: kg → ×1000 g.
 * Volume: l → ×1000 ml. Under the MVP heuristic "most grocery items are
 * water-based, so 1 kg ≈ 1 l", we display the combined range under the
 * "g" label — e.g. a cluster containing 250 g, 350 ml, 0.75 kg renders
 * as "250 - 750 g".
 *
 * Non-mass/volume units (vnt, NULL, other) return NULL and drop out of
 * MIN/MAX aggregation. If a Product / cluster has only such units, its
 * minAmount/maxAmount come back NULL and the frontend hides the amount
 * line entirely (Case 3).
 */
const AMOUNT_NORMALIZED_EXPR = `
    CASE
        WHEN sp.unit IN ('kg', 'l') THEN sp.amount * 1000
        WHEN sp.unit IN ('g', 'ml') THEN sp.amount
        ELSE NULL
    END
`;

const browseSelect = (locale: Locale): string => {
    const loc = localizedProductNameSql(locale);
    return `
    SELECT p.id, ${loc.nameSql} AS name, p.categoryId, p.globalScore,
        ${loc.imageUrlsSql} AS imageUrls,
        -- chainLogos: one {chainId,logoUrl} per distinct chain the product
        -- is sold in. Written as a correlated subquery inside IN(...) rather
        -- than a correlated DERIVED TABLE because MariaDB (prod engine) does
        -- not support outer-column references inside FROM-subqueries; the
        -- IN(...) form is portable across MySQL 8 and MariaDB 11. StoreChain.id
        -- is unique so no DISTINCT is needed on the outer aggregate.
        (SELECT JSON_ARRAYAGG(JSON_OBJECT('chainId', sc2.id, 'logoUrl', sc2.miniLogoUrl))
         FROM StoreChain sc2
         WHERE sc2.id IN (SELECT sp2.chainId FROM StoreProduct sp2 WHERE sp2.productId = p.id)) AS chainLogos,
        CAST(MIN(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as minAmount,
        CAST(MAX(${AMOUNT_NORMALIZED_EXPR}) AS UNSIGNED) as maxAmount,
        -- Size-line dimension: majority-volume products label ml/l, else g/kg.
        CASE WHEN SUM(CASE WHEN sp.unit IN ('l','ml') THEN 1 ELSE 0 END) >
                    SUM(CASE WHEN sp.unit IN ('kg','g') THEN 1 ELSE 0 END)
               THEN 'ml' ELSE 'g' END as unit,
        MAX(sp.isWeighable) as hasWeighable
     FROM Product p
     LEFT JOIN StoreProduct sp ON sp.productId = p.id
`;
};

/**
 * Fetch globally merged loser products that the user has personally voted
 * 'different' on (for the loser ↔ winner pair). These products are normally
 * hidden by the `mergedIntoId IS NULL` filter but should be restored for
 * users who explicitly rejected the global merge.
 */
async function fetchPersonallyRestoredProducts(
    userId: string,
    categoryFilter: string,
    categoryParams: any[],
    baseFilter: string,
    locale: Locale = 'lt',
): Promise<any[]> {
    const [rows]: any = await pool.query(
        `${browseSelect(locale)}
         WHERE ${categoryFilter}
           AND p.mergedIntoId IS NOT NULL
           AND EXISTS (
               SELECT 1
                 FROM UserStoreProductEquivalence e
                 JOIN StoreProduct spA ON spA.id = e.spIdA
                 JOIN StoreProduct spB ON spB.id = e.spIdB
                WHERE e.userId = ?
                  AND e.verdict = 'different'
                  AND (
                      (spA.productId = p.id AND spB.productId = p.mergedIntoId)
                   OR (spB.productId = p.id AND spA.productId = p.mergedIntoId)
                  )
           )
           ${baseFilter}
         GROUP BY p.id`,
        [...categoryParams, userId],
    );
    return rows;
}

/**
 * Browse one L3 category.
 *
 * Mode only changes which Products are returned:
 *   'base' — cluster heads only (Product.baseProductId IS NULL). Variants
 *            collapse behind their head; tapping the head opens the detail
 *            screen which shows every variant side-by-side.
 *   'sku'  — every non-merged Product (heads + variants), one row each.
 *
 * Amount ranges reflect the Product's own StoreProducts in both modes
 * (not cluster-wide — keeping the query index-friendly). The detail view
 * in base mode surfaces the full cluster's variants.
 *
 * When userId is provided, globally merged products that the user has
 * personally voted 'different' on are restored to the list.
 */
const BLENDED_ORDER_BY = `
    ORDER BY CASE
        WHEN MAX(ups.interactionCount) > 0
        THEN (LEAST(MAX(ups.interactionCount), 10) / 10.0) * MAX(ups.score)
             + (1 - LEAST(MAX(ups.interactionCount), 10) / 10.0) * p.globalScore
        ELSE p.globalScore
    END DESC
`;

const parseChainLogos = (cl: any): { chainId: number; logoUrl: string | null }[] => {
    if (!cl) return [];
    if (typeof cl === 'string') { try { return JSON.parse(cl) || []; } catch { return []; } }
    return Array.isArray(cl) ? cl : [];
};

/**
 * Union, into each list product's chainLogos, the chains of the products the
 * user personally swiped 'same' with — including off-list / Nepriskirta(688)
 * orphans that aren't in this category. So a personally-merged "Bananai" shows
 * BOTH Maxima + Rimi in the browse list, matching the detail screen. One hop is
 * enough because equivalences are normalised to the root on write.
 */
async function attachPersonalChainLogos(userId: string, products: any[]): Promise<any[]> {
    const productIds = products.map(p => Number(p.id)).filter(Boolean);
    if (productIds.length === 0) return products;
    const [rows]: any = await pool.query(
        `SELECT
             CASE WHEN sp1.productId IN (?) THEN sp1.productId ELSE sp2.productId END AS listProductId,
             sc.id AS chainId, sc.miniLogoUrl AS logoUrl
           FROM UserStoreProductEquivalence e
           JOIN StoreProduct sp1 ON sp1.id = e.spIdA
           JOIN StoreProduct sp2 ON sp2.id = e.spIdB
           JOIN StoreProduct spOther
             ON spOther.productId = (CASE WHEN sp1.productId IN (?) THEN sp2.productId ELSE sp1.productId END)
           JOIN StoreChain sc ON sc.id = spOther.chainId
          WHERE e.userId = ? AND e.verdict = 'same'
            AND (sp1.productId IN (?) OR sp2.productId IN (?))`,
        [productIds, productIds, userId, productIds, productIds],
    );
    if (rows.length === 0) return products;
    const extraByProduct = new Map<number, Map<number, string | null>>();
    for (const r of rows) {
        const pid = Number(r.listProductId);
        if (!extraByProduct.has(pid)) extraByProduct.set(pid, new Map());
        extraByProduct.get(pid)!.set(Number(r.chainId), r.logoUrl ?? null);
    }
    for (const p of products) {
        const extra = extraByProduct.get(Number(p.id));
        if (!extra) continue;
        const byChain = new Map<number, { chainId: number; logoUrl: string | null }>();
        for (const cl of parseChainLogos(p.chainLogos)) byChain.set(cl.chainId, cl);
        for (const [chainId, logoUrl] of extra) if (!byChain.has(chainId)) byChain.set(chainId, { chainId, logoUrl });
        p.chainLogos = Array.from(byChain.values());
    }
    return products;
}

export const getProductsByCategoryWithAmounts = async (
    categoryId: number,
    mode: BrowseMode = 'base',
    userId?: string,
    locale: Locale = 'lt',
) => {
    const baseFilter = mode === 'base' ? 'AND p.baseProductId IS NULL' : '';

    let products: any[];
    if (userId) {
        [products] = await pool.query(
            `${browseSelect(locale)}
             LEFT JOIN UserProductScore ups ON ups.userId = ? AND ups.productId = p.id
             WHERE p.categoryId = ?
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ${BLENDED_ORDER_BY}`,
            [userId, categoryId],
        ) as any;
    } else {
        [products] = await pool.query(
            `${browseSelect(locale)}
             WHERE p.categoryId = ?
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ORDER BY p.globalScore DESC`,
            [categoryId],
        ) as any;
    }

    if (userId) {
        const restored = await fetchPersonallyRestoredProducts(
            userId,
            'p.categoryId = ?',
            [categoryId],
            baseFilter,
            locale,
        );
        products.push(...restored);
    }

    // Attach canonical-unit fields (used by the client AmountPickerModal +
    // basket +/- buttons to know the right step size + display unit).
    const productIds = products.map(p => Number(p.id));
    const canonicals = await loadCanonicalsForProducts(productIds);
    const withCanon = await attachUnitPriceBadges(attachCanonicalFields(products, canonicals));
    return userId ? await attachPersonalChainLogos(userId, withCanon) : withCanon;
};

const DISCOUNT_AMOUNT_EXPR = `
    CASE
        WHEN sp.unit IN ('kg', 'l') THEN sp.amount * 1000
        WHEN sp.unit IN ('g', 'ml') THEN sp.amount
        ELSE NULL
    END
`;

/**
 * Cross-store "real discount" (Discounts badge v2).
 *
 * Per product: each chain participates with its cheapest latest EFFECTIVE unit
 * price (active promo if present, else the latest regular). With ≥2 comparable
 * chains, realDiscountPct = round((avg − min) / avg × 100) over the chains'
 * unit prices and cheapestChainId = the chain holding the minimum — the badge
 * then says "cheapest at <chain>, X% below the market average" instead of the
 * gameable own-store promo percent (an inflated regular price buys a big badge).
 *
 * Comparability: kg/l/g/ml normalize onto the same 1000-base the summary's
 * minAmount uses (kg ≈ l — the app's canonical transitional rule); any other
 * unit compares only against the SAME unit string, per amount (amount 1 when
 * absent). Mixed bases, missing amounts on mass/volume rows, or a single
 * participating chain → NULLs (the badge falls back to bestDiscountPct).
 *
 * A computed pct that rounds to 0 DELISTS the row: every chain sells at the
 * same effective unit price, so the promo buys nothing real. Deliberate
 * consequence embraced by design: the cheapest chain may hold NO promo — a
 * fake promo elsewhere then advertises the honest store.
 */
async function attachRealDiscounts(enriched: any[], productIds: number[]): Promise<any[]> {
    if (productIds.length === 0) return enriched;
    const [sps]: any = await pool.query(
        `SELECT id, productId, chainId, unit, amount FROM StoreProduct
          WHERE productId IN (?) AND provisional = 0`,
        [productIds],
    );
    if (!sps.length) return enriched;
    const spIds = sps.map((r: any) => Number(r.id));

    // Latest price row per SP (regular fallback) + latest ACTIVE promo per SP —
    // the same MAX(id) convention the summary's promo join uses.
    const [latestAny]: any = await pool.query(
        `SELECT pr.storeProductId, pr.price
           FROM Price pr
           JOIN (SELECT storeProductId, MAX(id) AS maxId FROM Price
                  WHERE storeProductId IN (?) GROUP BY storeProductId) m ON m.maxId = pr.id`,
        [spIds],
    );
    const [latestPromo]: any = await pool.query(
        `SELECT pr.storeProductId, pr.promoPrice
           FROM Price pr
           JOIN (SELECT storeProductId, MAX(id) AS maxId FROM Price
                  WHERE storeProductId IN (?) AND promoPrice IS NOT NULL AND promoEnd > NOW()
                    AND (validFrom IS NULL OR validFrom <= NOW())
                  GROUP BY storeProductId) m ON m.maxId = pr.id
          WHERE pr.promoPrice > 0 AND pr.promoPrice < pr.price`,
        [spIds],
    );
    const regBySp = new Map<number, number>();
    for (const r of latestAny) regBySp.set(Number(r.storeProductId), Number(r.price));
    const promoBySp = new Map<number, number>();
    for (const r of latestPromo) promoBySp.set(Number(r.storeProductId), Number(r.promoPrice));

    // Unit basis: { kind, qty } — prices compare only within one kind. Scraped
    // unit/amount pairs carry TYPOS the math must not trust blindly (real dev-data
    // hits: "ml, 0.330" = litres mislabelled ml → an 800× skew and a 100% badge):
    // no product is under 1 g/ml or over 100 kg/l, so amounts outside physical
    // bounds are unit slips — repaired onto the intended magnitude. Count units
    // keep a null-amount marker so a pack-size-known offer is never compared
    // against a pack-size-unknown one (8-pack vs "1").
    const basisOf = (unit: string | null, amount: number | null): { kind: string; qty: number } | null => {
        const u = (unit ?? '').trim().toLowerCase();
        const a = amount != null && Number(amount) > 0 ? Number(amount) : null;
        if (u === 'kg' || u === 'l') {
            if (a == null) return null;
            return { kind: 'base1000', qty: a > 100 ? a : a * 1000 };
        }
        if (u === 'g' || u === 'ml') {
            if (a == null) return null;
            return { kind: 'base1000', qty: a < 1 ? a * 1000 : a };
        }
        if (!u) return null;
        // Count units REQUIRE a scraped amount too: a NULL amount can hide a multipack
        // (8-pack batteries read as "1"), so the offer sits out until it gains one —
        // same rule as mass/volume (receipt of user decision: čiobreliai/trešnės cases).
        return a != null ? { kind: `u:${u}`, qty: a } : null;
    };

    // productId → chainId → cheapest effective unit price (kind-tagged). pricedChains
    // additionally counts every chain that HAS a live price, participating or not —
    // the delist-at-0% rule below only trusts a COMPLETE comparison.
    const perProduct = new Map<number, Map<number, { kind: string; unitPrice: number }>>();
    const pricedChains = new Map<number, Set<number>>();
    const mixedKind = new Set<number>();
    for (const sp of sps) {
        const spId = Number(sp.id);
        const eff = promoBySp.get(spId) ?? regBySp.get(spId);
        if (eff == null || !(eff > 0)) continue;
        const pid = Number(sp.productId);
        const chainId = Number(sp.chainId);
        let priced = pricedChains.get(pid);
        if (!priced) { priced = new Set(); pricedChains.set(pid, priced); }
        priced.add(chainId);
        const basis = basisOf(sp.unit, sp.amount);
        if (!basis) continue;
        const unitPrice = eff / basis.qty;
        let chains = perProduct.get(pid);
        if (!chains) { chains = new Map(); perProduct.set(pid, chains); }
        const prev = chains.get(chainId);
        if (prev && prev.kind !== basis.kind) { mixedKind.add(pid); continue; }
        if (!prev || unitPrice < prev.unitPrice) chains.set(chainId, { kind: basis.kind, unitPrice });
    }

    const out: any[] = [];
    for (const r of enriched) {
        const pid = Number(r.id);
        const chains = perProduct.get(pid);
        let realDiscountPct: number | null = null;
        let cheapestChainId: number | null = null;
        if (chains && chains.size >= 2 && !mixedKind.has(pid)) {
            const entries = [...chains.entries()];
            const kinds = new Set(entries.map(([, v]) => v.kind));
            if (kinds.size === 1) {
                let min = Infinity, max = 0, minChain = -1, sum = 0;
                for (const [chainId, v] of entries) {
                    sum += v.unitPrice;
                    if (v.unitPrice > max) max = v.unitPrice;
                    if (v.unitPrice < min || (v.unitPrice === min && chainId < minChain)) {
                        min = v.unitPrice; minChain = chainId;
                    }
                }
                // SANITY RATIO: the same grocery product never legitimately costs 5×
                // more per unit at another chain — a wider spread is residual dirty
                // data (mislabelled amount the bounds repair couldn't catch). Fall
                // back to the classic badge rather than advertise a fantasy number.
                if (max <= min * 5) {
                    const avg = sum / entries.length;
                    const pct = Math.round(((avg - min) / avg) * 100);
                    // 0% = every chain equal, the promo buys nothing → delist — but ONLY
                    // when every priced chain actually took part. If a chain sat out
                    // (no amount/unit yet), the tie is computed on partial information
                    // and the product keeps the classic 🔥 badge instead of vanishing
                    // (the excluded chain may hold the page-qualifying promo).
                    const complete = (pricedChains.get(pid)?.size ?? 0) === entries.length;
                    if (pct <= 0) {
                        if (complete) continue;       // trusted tie → delist
                    } else {
                        realDiscountPct = pct;
                        cheapestChainId = minChain;
                    }
                }
            }
        }
        out.push({ ...r, realDiscountPct, cheapestChainId });
    }
    return out;
}

/**
 * Recompute the DiscountedProductSummary table from current Product + Price state.
 * Runs the heavy aggregation query once and writes the result into a flat,
 * pre-joined table so the request-time endpoint becomes a simple indexed read.
 *
 * Called on server boot, after every scraper batch, and daily at 00:30 to
 * drop promos that expired overnight. Idempotent — TRUNCATE + bulk INSERT.
 */
export const refreshDiscountedSummary = async (): Promise<void> => {
    const t0 = Date.now();
    const [rows]: any = await pool.query(
        `SELECT p.id, p.name, p.categoryId,
            c.parentCategoryId AS l2CategoryId,
            imgs.imageUrls,
            chains.chainLogos,
            CAST(MIN(${DISCOUNT_AMOUNT_EXPR}) AS UNSIGNED) AS minAmount,
            CAST(MAX(${DISCOUNT_AMOUNT_EXPR}) AS UNSIGNED) AS maxAmount,
            CASE WHEN SUM(CASE WHEN sp.unit IN ('l','ml') THEN 1 ELSE 0 END) >
                    SUM(CASE WHEN sp.unit IN ('kg','g') THEN 1 ELSE 0 END)
               THEN 'ml' ELSE 'g' END AS unit,
            MAX(sp.isWeighable) AS hasWeighable,
            MAX(ROUND((1 - d.promoPrice / d.price) * 100)) AS bestDiscountPct
         FROM Product p
         LEFT JOIN Category c ON c.id = p.categoryId
         LEFT JOIN StoreProduct sp ON sp.productId = p.id AND sp.provisional = 0
         LEFT JOIN (
             SELECT productId, JSON_ARRAYAGG(imageUrl) AS imageUrls
             FROM StoreProduct
             WHERE imageUrl IS NOT NULL
             GROUP BY productId
         ) imgs ON imgs.productId = p.id
         LEFT JOIN (
             SELECT sp2.productId,
                    JSON_ARRAYAGG(JSON_OBJECT('chainId', sc.id, 'logoUrl', sc.miniLogoUrl)) AS chainLogos
             FROM (SELECT DISTINCT productId, chainId FROM StoreProduct) sp2
             JOIN StoreChain sc ON sc.id = sp2.chainId
             GROUP BY sp2.productId
         ) chains ON chains.productId = p.id
         INNER JOIN (
             SELECT spi2.productId, pr.promoPrice, pr.price
             FROM Price pr
             JOIN StoreProduct spi2 ON spi2.id = pr.storeProductId
             INNER JOIN (
                 SELECT storeProductId, MAX(id) AS maxId
                 FROM Price FORCE INDEX (idx_price_promo_end)
                 WHERE promoEnd > NOW()
                   AND promoPrice IS NOT NULL
                   AND (validFrom IS NULL OR validFrom <= NOW())
                 GROUP BY storeProductId
             ) latest ON latest.maxId = pr.id
             WHERE pr.promoPrice < pr.price
               AND pr.price > 0
         ) d ON d.productId = p.id
         WHERE p.mergedIntoId IS NULL
           AND p.baseProductId IS NULL
         GROUP BY p.id
         HAVING bestDiscountPct > 0
         ORDER BY bestDiscountPct DESC`,
    );

    const productIds = rows.map((r: any) => Number(r.id));
    const canonicals = await loadCanonicalsForProducts(productIds);
    let enriched = attachCanonicalFields(rows, canonicals);
    enriched = await attachRealDiscounts(enriched, productIds);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM DiscountedProductSummary');
        if (enriched.length > 0) {
            const values = enriched.map((r: any) => [
                r.id,
                r.name,
                r.categoryId ?? null,
                r.l2CategoryId ?? null,
                r.imageUrls ? JSON.stringify(r.imageUrls) : null,
                r.chainLogos ? JSON.stringify(r.chainLogos) : null,
                r.minAmount ?? null,
                r.maxAmount ?? null,
                r.unit ?? 'g',
                r.hasWeighable ?? 0,
                r.bestDiscountPct,
                r.realDiscountPct ?? null,
                r.cheapestChainId ?? null,
                r.canonicalUnit,
                r.canonicalStep,
                r.canonicalFamily,
            ]);
            await conn.query(
                `INSERT INTO DiscountedProductSummary
                 (productId, name, categoryId, l2CategoryId, imageUrls, chainLogos,
                  minAmount, maxAmount, unit, hasWeighable, bestDiscountPct,
                  realDiscountPct, cheapestChainId,
                  canonicalUnit, canonicalStep, canonicalFamily)
                 VALUES ?`,
                [values],
            );
        }
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }

    console.log(`[DiscountsSummary] refreshed ${enriched.length} rows in ${Date.now() - t0} ms`);
};

/**
 * Return the latest summary updatedAt as a unix-ms timestamp for ETag generation.
 * Returns 0 when the table is empty.
 */
export const getDiscountsSummaryUpdatedAt = async (): Promise<number> => {
    const [rows]: any = await pool.query(
        `SELECT UNIX_TIMESTAMP(MAX(updatedAt)) * 1000 AS ts FROM DiscountedProductSummary`,
    );
    return Number(rows[0]?.ts ?? 0);
};

export const getDiscountedProducts = async (opts: {
    l2CategoryId?: number;
    search?: string;
    limit?: number;
    offset?: number;
    locale?: Locale;
} = {}) => {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts.l2CategoryId != null) {
        conditions.push('d.l2CategoryId = ?');
        params.push(opts.l2CategoryId);
    }
    if (opts.search) {
        // On par with /products/search: the SAME shared match module (name +
        // stems + SP names + translations + aliases), so English queries and
        // synonyms hit here too — keyed on the summary's productId.
        const sc = productSearchClauses(opts.search, { nameCol: 'd.name', idCol: 'd.productId' });
        conditions.push(sc.matchAny.sql);
        params.push(...sc.matchAny.params);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = opts.limit != null
        ? `LIMIT ${Number(opts.limit)} OFFSET ${Number(opts.offset ?? 0)}`
        : '';

    // LT reads the baked name/imageUrls (zero cost). EN overlays the shortest
    // EN name + donor-first images via the shared resolver, keyed on the
    // summary's productId (its baked `name` is the COALESCE fallback).
    const en = opts.locale === 'en'
        ? localizedProductNameSql('en', { productAlias: 'd', idExpr: 'd.productId', nameExpr: 'd.name' })
        : null;
    const nameCol = en ? `${en.nameSql} AS name` : 'd.name';
    const imageCol = en ? `${en.imageUrlsSql} AS imageUrls` : 'd.imageUrls';

    const [rows]: any = await pool.query(
        `SELECT d.productId AS id, ${nameCol}, d.categoryId, d.l2CategoryId,
                ${imageCol}, d.chainLogos, d.minAmount, d.maxAmount, d.unit, d.hasWeighable,
                d.bestDiscountPct, d.realDiscountPct, d.cheapestChainId,
                d.canonicalUnit, d.canonicalStep, d.canonicalFamily
           FROM DiscountedProductSummary d
           ${where}
           ORDER BY COALESCE(d.realDiscountPct, d.bestDiscountPct) DESC
           ${limitClause}`,
        params,
    );
    return rows;
};

export const getAllProductsByL2WithAmounts = async (
    l2CategoryId: number,
    mode: BrowseMode = 'base',
    userId?: string,
    locale: Locale = 'lt',
) => {
    const baseFilter = mode === 'base' ? 'AND p.baseProductId IS NULL' : '';
    const l2Filter = '(p.categoryId IN (SELECT id FROM Category WHERE parentCategoryId = ?) OR p.categoryId = ?)';
    const l2Params = [l2CategoryId, l2CategoryId];

    let products: any[];
    if (userId) {
        [products] = await pool.query(
            `${browseSelect(locale)}
             LEFT JOIN UserProductScore ups ON ups.userId = ? AND ups.productId = p.id
             WHERE ${l2Filter}
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ${BLENDED_ORDER_BY}`,
            [userId, ...l2Params],
        ) as any;
    } else {
        [products] = await pool.query(
            `${browseSelect(locale)}
             WHERE ${l2Filter}
               AND p.mergedIntoId IS NULL
               ${baseFilter}
             GROUP BY p.id
             ORDER BY p.globalScore DESC`,
            l2Params,
        ) as any;
    }

    if (userId) {
        const restored = await fetchPersonallyRestoredProducts(
            userId,
            l2Filter,
            l2Params,
            baseFilter,
            locale,
        );
        products.push(...restored);
    }

    const productIds = products.map(p => Number(p.id));
    const canonicals = await loadCanonicalsForProducts(productIds);
    const withCanon = await attachUnitPriceBadges(attachCanonicalFields(products, canonicals));
    return userId ? await attachPersonalChainLogos(userId, withCanon) : withCanon;
};