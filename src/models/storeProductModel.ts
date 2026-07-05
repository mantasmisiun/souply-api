import pool from '../config/db.js';
import { resolveEffectiveProductId } from '../services/storeProductMergeService.js';
import { getPersonalComponentForProduct } from './userEquivalenceModel.js';
import { buildFuzzyNameClause } from '../utils/fuzzyNameClause.js';
import { fetchAliasesByChainGrouped } from './storeProductAliasModel.js';
import type { Locale } from '../middleware/locale.js';

type Connection = typeof pool | any;

/**
 * Find an existing StoreProduct in the same chain with an exactly matching
 * name + amount + unit (case-insensitive on name). Used by the receipt-save
 * dedup pre-pass so we don't create parallel SP rows for the same SKU when
 * mobile's fuzzy matcher missed a trivial match (e.g., after a transient API
 * error). Stricter than fuzzy matching on purpose — the fuzzy path is
 * already the mobile /api/store-products/match endpoint.
 */
export const findExactMatchingStoreProduct = async (
    chainId: number,
    name: string,
    amount: number | null,
    unit: string | null,
    conn?: Connection
): Promise<number | null> => {
    const db = conn || pool;
    // Catalog-first: when several same-chain SPs share this exact name, prefer a
    // CATALOG row (has an imageUrl — scraped products carry one) over a garbled
    // RECEIPT-MINTED ORPHAN (imageUrl NULL). Without this, a prior receipt's OCR
    // orphan ("LIETUVISKI POMTDORA") could capture future receipts by exact-name
    // dedup even though a clean catalog SP exists. (User: match catalog first,
    // fall back to orphan only if that fails.)
    const [rows]: any = await db.query(
        `SELECT id FROM StoreProduct
          WHERE chainId = ?
            AND LOWER(storeProductName) = LOWER(?)
            AND (amount IS NULL OR ? IS NULL OR amount = ?)
            AND (unit   IS NULL OR ? IS NULL OR unit   = ?)
          ORDER BY (imageUrl IS NOT NULL) DESC, id ASC
          LIMIT 1`,
        [chainId, name, amount, amount, unit, unit]
    );
    return rows[0]?.id ?? null;
};

/**
 * Minimal display fields (name + image) for one StoreProduct. Used by receipt
 * save to re-sync a line's shown name/image to whatever SP the resolver actually
 * linked, so display can never diverge from the link (e.g. after a dedup swap).
 */
export const getStoreProductDisplayById = async (
    spId: number,
    conn?: Connection,
): Promise<{ name: string | null; imageUrl: string | null } | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        'SELECT storeProductName, imageUrl FROM StoreProduct WHERE id = ? LIMIT 1',
        [spId],
    );
    if (!rows[0]) return null;
    return { name: rows[0].storeProductName ?? null, imageUrl: rows[0].imageUrl ?? null };
};

/**
 * Proposal display fetch for the S2-unlinked Card-B path: name/image for the card
 * face + chainId so the queue builder can refuse to propose a cross-chain SP
 * (voting identical must link same-chain only — the chain-price invariant).
 */
export const getSpProposalDisplayById = async (
    spId: number,
    conn?: Connection,
): Promise<{ name: string | null; imageUrl: string | null; chainId: number } | null> => {
    const db = conn || pool;
    const [rows]: any = await db.query(
        'SELECT storeProductName, imageUrl, chainId FROM StoreProduct WHERE id = ? LIMIT 1',
        [spId],
    );
    if (!rows[0]) return null;
    return { name: rows[0].storeProductName ?? null, imageUrl: rows[0].imageUrl ?? null, chainId: Number(rows[0].chainId) };
};

export const createStoreProduct = async (
    productId: number,
    chainId: number,
    storeProductName: string,
    brandName: string | null,
    isWeighable: boolean = false,
    amount: number | null = null,
    unit: string | null = null,
    imageUrl: string | null = null,
    conn?: Connection
    ) => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'INSERT INTO StoreProduct (productId, chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [productId, chainId, storeProductName, brandName, isWeighable, amount, unit, imageUrl]
    );
    return result.insertId;
};

export const getStoreProductsByProductId = async (productId: number, userId?: string) => {
    // With a userId, expand to the user's personal equivalence component so a
    // product they swiped 'identical'/'similar' shows ALL its equivalent SPs —
    // including ones still parked in the hidden Nepriskirta bucket (the 688
    // "pull"). `getPersonalComponentForProduct` returns [productId] when the
    // user has no equivalences, so the anonymous/no-vote path is unchanged.
    const productIds = userId
        ? await getPersonalComponentForProduct(userId, productId)
        : [productId];
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM StoreProduct
         JOIN StoreChain ON StoreProduct.chainId = StoreChain.id
         WHERE StoreProduct.productId IN (?)
           AND (StoreProduct.provisional = 0 OR StoreProduct.provisionalOwnerUserId = ?)`,
        [productIds, userId ?? '']
    );
    return rows;
};

/**
 * 'base' mode for the product detail view: resolve the given productId to
 * its BaseProduct cluster head, then return all StoreProducts for every
 * cluster member (head + variants). The detail page can then show every
 * variant side-by-side with its own chart, giving the user "all yogurts of
 * this base" at a glance.
 */
export const getStoreProductsForCluster = async (productId: number, userId?: string) => {
    // Follow mergedIntoId chain so a globally merged loser still shows its winner's cluster.
    const effectiveProductId = await resolveEffectiveProductId(productId);

    const [headRows]: any = await pool.query(
        `SELECT COALESCE(baseProductId, id) AS headId
           FROM Product
          WHERE id = ?
          LIMIT 1`,
        [effectiveProductId]
    );
    if (!headRows[0]) return [];
    const headId = Number(headRows[0].headId);

    // Union the user's personal equivalence component into the cluster so SPs
    // they swiped 'identical'/'similar' (incl. hidden-bucket orphans) appear on
    // the detail view. Empty for anonymous / no-equivalence users → [0] keeps
    // the IN (?) clause valid without matching anything.
    const personalIds = userId ? await getPersonalComponentForProduct(userId, productId) : [];

    const [rows]: any = await pool.query(
        `SELECT sp.*, sc.name AS chainName, sc.logoUrl
           FROM StoreProduct sp
           JOIN StoreChain sc ON sc.id = sp.chainId
           JOIN Product p ON p.id = sp.productId
          WHERE ((p.id = ? OR p.baseProductId = ?) AND p.mergedIntoId IS NULL)
             OR p.id IN (?)`,
        [headId, headId, personalIds.length ? personalIds : [0]]
    );
    return rows;
};

export const getStoreProductsByChainId = async (chainId: number) => {
    const [rows]: any = await pool.query(
        `SELECT StoreProduct.*, StoreChain.name AS chainName, StoreChain.logoUrl
         FROM StoreProduct
         JOIN StoreChain ON StoreProduct.chainId = StoreChain.id 
         WHERE StoreProduct.chainId = ?`,
        [chainId]
    );
    return rows;
};

export const getStoreProductByName = async (storeProductName: string) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM StoreProduct WHERE storeProductName LIKE ?',
        [`%${storeProductName}%`]
    );
    return rows;
};

export const getStoreProductByNameAndChain = async (storeProductName: string, chainId: number, conn?: Connection) => {
    const db = conn || pool;
    const matchLength = Math.floor(storeProductName.length * 0.6);
    const searchTerm = storeProductName.substring(0, matchLength);
    const [rows]: any = await db.query(
        `SELECT * FROM StoreProduct 
         WHERE chainId = ? 
         AND storeProductName LIKE ?`,
        [chainId, `%${searchTerm}%`]
    );
    return rows[0] || null;
};

export const getStoreProductByProductAndChain = async (productId: number, chainId: number) => {
    const [rows]: any = await pool.query(
        'SELECT * FROM StoreProduct WHERE productId = ? AND chainId = ?',
        [productId, chainId]
    );
    return rows[0] || null;
};

export const searchStoreProductsByChain = async (name: string, chainId: number) => {
    const fuzzy = buildFuzzyNameClause(name, 'sp.storeProductName');
    const [rows]: any = await pool.query(
        `SELECT sp.*
         FROM StoreProduct sp
         WHERE sp.chainId = ?
         AND ${fuzzy.sql}
         LIMIT 5`,
        [chainId, ...fuzzy.params],
    );
    return rows;
};

/** Swap a StoreProduct's imageUrl. Used by the user-supplied-photo flow in
 *  receipt detail (three-dots menu → Pridėti nuotrauką). */
export const updateStoreProductImageUrl = async (
    id: number,
    imageUrl: string | null
): Promise<void> => {
    await pool.query(
        'UPDATE StoreProduct SET imageUrl = ? WHERE id = ?',
        [imageUrl, id]
    );
};

export const updateStoreProductName = async (id: number, storeProductName: string) => {
    await pool.query(
        'UPDATE StoreProduct SET storeProductName = ? WHERE id = ?',
        [storeProductName, id]
    );
};

/**
 * Catalog self-heal: flip a mislabeled SP to weighable. Idempotent — the
 * `AND isWeighable = 0` guard makes a repeat call a no-op and ensures we only
 * ever correct packaged→weighable, never the reverse. A null amount becomes 1 so
 * a weighable kg row carries the standard "1 kg" reference. Returns true if it flipped.
 */
export const markStoreProductWeighable = async (id: number, conn?: Connection): Promise<boolean> => {
    const db = conn || pool;
    const [result]: any = await db.query(
        'UPDATE StoreProduct SET isWeighable = 1, amount = COALESCE(amount, 1) WHERE id = ? AND isWeighable = 0',
        [id]
    );
    return result.affectedRows > 0;
};

//For verifying price's storeProduct and store belong to the same chain
export const getChainIdByStoreProductId = async (storeProductId: number) => {
    const [rows]: any = await pool.query(
        'SELECT chainId FROM StoreProduct WHERE id = ?',
        [storeProductId]
    );
    return rows[0]?.chainId || null;
};

export const getStoreProductsByChainWithProductData = async (chainId: number, locale: Locale = 'lt') => {
    // c.name joined so MatchCandidate / ProductMatch carry `categoryName`
    // through to the client — used by C3's per-category spending breakdown
    // (avoids the mobile having to mirror the server taxonomy).
    //
    // categoryL2Name applies the same CASE that statsService uses so the
    // receipt-level breakdown and Profilis stats agree on labels:
    //   c is L1 → NULL (excluded from breakdown)
    //   c is L2 → c.name
    //   c is L3 → c2.name (the L2 parent)
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                sp.isWeighable, sp.amount, sp.unit,
                sp.imageUrl, p.categoryId, COALESCE(ct.name, c.name) AS categoryName,
                CASE
                  WHEN c.parentCategoryId IS NULL  THEN NULL
                  WHEN c2.parentCategoryId IS NULL THEN COALESCE(ct.name, c.name)
                  ELSE COALESCE(ct2.name, c2.name)
                END AS categoryL2Name,
                sp.chainId,
                -- isCatalog: a REAL scraped SKU has at least one scraped price
                -- (Price.receiptId IS NULL). A receipt-minted ORPHAN has only
                -- receipt-derived prices. Used as a matcher tiebreak so a garbled
                -- orphan can't out-rank the clean catalog on a near-tie. Indexed
                -- by idx_price_receipt_sp (receiptId, storeProductId).
                EXISTS(SELECT 1 FROM Price pr WHERE pr.storeProductId = sp.id AND pr.receiptId IS NULL) AS isCatalog
         FROM StoreProduct sp
         JOIN Product p ON sp.productId = p.id
         LEFT JOIN Category c  ON p.categoryId = c.id
         LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
         LEFT JOIN CategoryTranslation ct  ON ct.categoryId  = c.id  AND ct.locale  = ?
         LEFT JOIN CategoryTranslation ct2 ON ct2.categoryId = c2.id AND ct2.locale = ?
         WHERE sp.chainId = ?
           AND sp.provisional = 0`,
        [locale, locale, chainId]
    );
    // Attach learned receipt-name aliases (Issue H vocabulary): canonical (extra match
    // targets — match the way THIS chain prints each SP), rejected (suppress a known-
    // wrong combo), similarity (same-category link → L2-scope + L3-boost). Same-chain
    // only — aliases are chain-scoped, so the cross-chain fetcher intentionally omits them.
    const grouped = await fetchAliasesByChainGrouped(chainId);
    return rows.map((r: any) => ({
        ...r,
        isWeighable: !!r.isWeighable,
        isCatalog: !!r.isCatalog,
        amount: r.amount !== null ? parseFloat(r.amount) : null,
        aliases: grouped.canonical.get(Number(r.id)),
        rejectedAliases: grouped.rejected.get(Number(r.id)),
        similarityAliases: grouped.similarity.get(Number(r.id)),
    }));
};

/**
 * Cross-chain candidate fetch. Returns one representative StoreProduct
 * per Product (lowest sp.id wins — arbitrary but stable), so the
 * matcher doesn't score the same Product once per chain it's sold in.
 * Used by the match endpoint as a fallback when a chain's own
 * StoreProduct catalog is empty or sparse (e.g. Norfa, which has no
 * scrapable public catalog). The caller reuses the matched Product
 * id when creating a new chain-specific StoreProduct row via the
 * receipt resolver — that's how cross-chain product identity gets
 * established organically.
 */
export const getStoreProductsCrossChainWithProductData = async (excludeChainId: number, locale: Locale = 'lt') => {
    // c.name joined so cross-chain candidates also carry `categoryName`
    // through to the client (see getStoreProductsByChainWithProductData).
    // categoryL2Name resolved with the same CASE as the same-chain
    // fetcher so both code paths emit identical breakdown labels.
    const [rows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.brandName,
                sp.isWeighable, sp.amount, sp.unit,
                sp.imageUrl, p.categoryId, COALESCE(ct.name, c.name) AS categoryName,
                CASE
                  WHEN c.parentCategoryId IS NULL  THEN NULL
                  WHEN c2.parentCategoryId IS NULL THEN COALESCE(ct.name, c.name)
                  ELSE COALESCE(ct2.name, c2.name)
                END AS categoryL2Name,
                sp.chainId
         FROM StoreProduct sp
         JOIN Product p ON sp.productId = p.id
         LEFT JOIN Category c  ON p.categoryId = c.id
         LEFT JOIN Category c2 ON c2.id = c.parentCategoryId
         LEFT JOIN CategoryTranslation ct  ON ct.categoryId  = c.id  AND ct.locale  = ?
         LEFT JOIN CategoryTranslation ct2 ON ct2.categoryId = c2.id AND ct2.locale = ?
         JOIN (
             SELECT productId, MIN(id) AS repId
             FROM StoreProduct
             WHERE chainId <> ? AND provisional = 0
             GROUP BY productId
         ) rep ON rep.repId = sp.id
         WHERE sp.chainId <> ? AND sp.provisional = 0`,
        [locale, locale, excludeChainId, excludeChainId]
    );
    return rows.map((r: any) => ({
        ...r,
        isWeighable: !!r.isWeighable,
        amount: r.amount !== null ? parseFloat(r.amount) : null,
    }));
};

// ── Match-candidate catalog cache ──────────────────────────────────────────────────
// The /store-products/match endpoint is called ONCE PER OCR LINE, and each call re-fetched
// the full ~13k-row chain catalog (13k-row correlated isCatalog subquery + alias attach).
// A 40-line receipt = 40 identical heavy queries against a 10-connection pool, all firing
// within a couple of seconds. This TTL cache collapses them to ONE fetch per (chain, locale)
// per window. The catalog changes on the order of days (scrapes); a short TTL bounds the
// staleness of freshly-learned vocabulary aliases to seconds. Candidates are read-only in
// findBestProductMatches, so the shared array is safe to reuse across requests.
const CATALOG_CACHE_TTL_MS = 30_000;
type CatalogEntry = { at: number; data: any[] };
const sameChainCatalogCache = new Map<string, CatalogEntry>();
const crossChainCatalogCache = new Map<string, CatalogEntry>();

export const getCachedChainCandidates = async (chainId: number, locale: Locale = 'lt'): Promise<any[]> => {
    const key = `${chainId}:${locale}`;
    const hit = sameChainCatalogCache.get(key);
    if (hit && Date.now() - hit.at < CATALOG_CACHE_TTL_MS) return hit.data;
    const data = await getStoreProductsByChainWithProductData(chainId, locale);
    sameChainCatalogCache.set(key, { at: Date.now(), data });
    return data;
};

export const getCachedCrossChainCandidates = async (excludeChainId: number, locale: Locale = 'lt'): Promise<any[]> => {
    const key = `${excludeChainId}:${locale}`;
    const hit = crossChainCatalogCache.get(key);
    if (hit && Date.now() - hit.at < CATALOG_CACHE_TTL_MS) return hit.data;
    const data = await getStoreProductsCrossChainWithProductData(excludeChainId, locale);
    crossChainCatalogCache.set(key, { at: Date.now(), data });
    return data;
};

/** Drop cached catalogs (call after a bulk catalog mutation if immediate freshness matters). */
export const invalidateCatalogCache = (): void => {
    sameChainCatalogCache.clear();
    crossChainCatalogCache.clear();
};

export const searchUnifiedProductsByChain = async (
    chainId: number,
    name: string,
    categoryId?: number | null,
) => {
    const term = name.trim();
    const hasTerm = term.length > 0;
    const hasCategory = Number.isFinite(categoryId) && Number(categoryId) > 0;

    if (!hasTerm && !hasCategory) {
        return { localStoreProducts: [], otherChainProducts: [] };
    }

    const localWhere: string[] = ['sp.chainId = ?'];
    const localParams: any[] = [chainId];

    if (hasTerm) {
        const fuzzy = buildFuzzyNameClause(term, 'sp.storeProductName');
        localWhere.push(`(${fuzzy.sql})`);
        localParams.push(...fuzzy.params);
    }
    if (hasCategory) {
        localWhere.push(`(
            p.categoryId = ?
            OR p.categoryId IN (
                SELECT c.id FROM Category c WHERE c.parentCategoryId = ?
            )
            OR p.categoryId IN (
                SELECT c2.id
                FROM Category c1
                JOIN Category c2 ON c2.parentCategoryId = c1.id
                WHERE c1.parentCategoryId = ?
            )
        )`);
        localParams.push(Number(categoryId), Number(categoryId), Number(categoryId));
    }

    const [localRows]: any = await pool.query(
        `SELECT sp.id, sp.productId, sp.storeProductName, sp.amount, sp.unit,
                sp.imageUrl,
                sc.id AS chainId, sc.name AS chainName, sc.logoUrl AS chainLogoUrl
         FROM StoreProduct sp
         JOIN Product p ON p.id = sp.productId
         JOIN StoreChain sc ON sc.id = sp.chainId
         WHERE ${localWhere.join(' AND ')}
         ORDER BY sp.storeProductName
         LIMIT 40`,
        localParams
    );

    const otherWhere: string[] = [
        `NOT EXISTS (
            SELECT 1 FROM StoreProduct spc
            WHERE spc.productId = p.id AND spc.chainId = ?
        )`,
        `EXISTS (
            SELECT 1 FROM StoreProduct spo
            WHERE spo.productId = p.id AND spo.chainId <> ?
        )`
    ];
    const otherParams: any[] = [chainId, chainId];

    if (hasTerm) {
        const fuzzy = buildFuzzyNameClause(term, 'p.name');
        otherWhere.push(`(${fuzzy.sql})`);
        otherParams.push(...fuzzy.params);
    }
    if (hasCategory) {
        otherWhere.push(`(
            p.categoryId = ?
            OR p.categoryId IN (
                SELECT c.id FROM Category c WHERE c.parentCategoryId = ?
            )
            OR p.categoryId IN (
                SELECT c2.id
                FROM Category c1
                JOIN Category c2 ON c2.parentCategoryId = c1.id
                WHERE c1.parentCategoryId = ?
            )
        )`);
        otherParams.push(Number(categoryId), Number(categoryId), Number(categoryId));
    }

    const [otherRows]: any = await pool.query(
        `SELECT p.id AS productId, p.name AS productName, p.categoryId,
                (SELECT JSON_ARRAYAGG(spi.imageUrl)
                 FROM StoreProduct spi
                 WHERE spi.productId = p.id
                   AND spi.chainId <> ?
                   AND spi.imageUrl IS NOT NULL) AS imageUrls,
                (
                    SELECT sc.logoUrl
                    FROM StoreProduct spx
                    JOIN StoreChain sc ON sc.id = spx.chainId
                    WHERE spx.productId = p.id AND spx.chainId <> ?
                    ORDER BY sc.id
                    LIMIT 1
                ) AS sourceChainLogoUrl
         FROM Product p
         WHERE ${otherWhere.join(' AND ')}
         ORDER BY p.name
         LIMIT 40`,
        [chainId, chainId, ...otherParams]
    );

    return {
        localStoreProducts: localRows.map((r: any) => ({
            ...r,
            amount: r.amount !== null ? Number(r.amount) : null,
        })),
        otherChainProducts: otherRows,
    };
};
