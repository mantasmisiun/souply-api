import pool from '../../config/db.js';
import {
    findExactMatchingStoreProduct,
    createStoreProduct,
    updateStoreProductImageUrl,
} from '../../models/storeProductModel.js';
import { createPrice, getPriceByStoreProductAndStore, extendPromoEnd } from '../../models/priceModel.js';
import { createProduct } from '../../models/productModel.js';
import { matchScrapedProduct } from './scraperProductMatch.js';

// Cache chain → store IDs for the lifetime of the process (reset on restart).
// Avoids re-querying Store on every product during a scrape run.
const chainStoreIdsCache = new Map<number, number[]>();
async function getChainStoreIds(chainId: number): Promise<number[]> {
    if (chainStoreIdsCache.has(chainId)) return chainStoreIdsCache.get(chainId)!;
    const [rows]: any = await pool.query('SELECT id FROM Store WHERE chainId = ?', [chainId]);
    const ids = (rows as any[]).map(r => Number(r.id));
    chainStoreIdsCache.set(chainId, ids);
    return ids;
}

export interface PromoProduct {
    chainId: number;
    storeProductName: string;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    /** The chain's OWN category breadcrumb (signal only — never mapped to Category). */
    siteCategory?: string | null;
    /** Chain-native product codes (normalized, no leading zeros) — mapped to the
     *  resolved SP in StoreProductCode for exact receipt↔SP matching. */
    itemCodes?: string[];
    /** True for WEBSITE-sourced names (authoritative): a code-confirmed reused SP
     *  whose stored name differs (leaflet typo) is renamed to this name. */
    nameAuthority?: boolean;
    regularPrice: number;
    promoPrice: number | null;
    /** Window OPEN — a promo/price scraped before it starts. null = active now.
     *  The calc shows the regular `price` until validFrom, then the promo. */
    promoStart?: Date | null;
    promoEnd: Date;
    requiresCoupon?: boolean;
}

export type UpsertResult = 'inserted' | 'skipped' | 'sp_created' | 'product_created';

/**
 * Fan out a promo price to every store in the chain.
 * Uses a single batch query to check existing prices, then bulk-inserts
 * only the stores that actually need a new row.
 */
async function fanOutPrice(
    spId: number,
    chainId: number,
    regularPrice: number,
    promoPrice: number | null,
    promoStart: Date | null,
    promoEnd: Date,
    requiresCoupon: boolean,
): Promise<'inserted' | 'skipped'> {
    const chainStoreIds = await getChainStoreIds(chainId);
    if (!chainStoreIds.length) return 'skipped';

    // Fetch the latest existing Price row for this SP at every chain store
    const [latestRows]: any = await pool.query(
        `SELECT p2.id, p2.storeId, p2.price, p2.promoPrice, p2.validFrom, p2.promoEnd, p2.requiresCoupon
         FROM Price p2
         INNER JOIN (
             SELECT storeId, MAX(id) AS maxId
             FROM Price
             WHERE storeProductId = ? AND storeId IN (?)
             GROUP BY storeId
         ) lp ON lp.maxId = p2.id`,
        [spId, chainStoreIds],
    );
    const latestByStore = new Map<number, any>(
        (latestRows as any[]).map(r => [Number(r.storeId), r]),
    );

    const toInsert: any[][] = [];
    const toExtend: number[] = [];
    const now = new Date();
    const sameTs = (a: Date | null, b: any): boolean => {
        const bt = b ? new Date(b).getTime() : null;
        return (a ? a.getTime() : null) === bt;
    };

    for (const storeId of chainStoreIds) {
        const existing = latestByStore.get(storeId);
        if (existing) {
            const samePrice = Math.abs(parseFloat(existing.price) - regularPrice) < 0.001;
            const existingPromo = existing.promoPrice ? parseFloat(existing.promoPrice) : null;
            const samePromo = existingPromo === promoPrice ||
                (existingPromo !== null && promoPrice !== null &&
                 Math.abs(existingPromo - promoPrice) < 0.001);
            const sameCoupon = (existing.requiresCoupon ?? 0) === Number(requiresCoupon);
            const sameStart = sameTs(promoStart, existing.validFrom);
            if (samePrice && samePromo && sameCoupon && sameStart) {
                // Only the end moved (window extended) → bump promoEnd, no new row.
                if (existing.promoEnd && promoEnd > new Date(existing.promoEnd)) toExtend.push(Number(existing.id));
                continue;
            }
        }
        toInsert.push([
            spId, storeId, null,
            regularPrice, promoPrice, promoStart, promoEnd,
            false, now, true, requiresCoupon,
        ]);
    }

    if (toExtend.length > 0) {
        await pool.query('UPDATE Price SET promoEnd = ? WHERE id IN (?)', [promoEnd, toExtend]);
    }
    if (toInsert.length > 0) {
        await pool.query(
            `INSERT IGNORE INTO Price
             (storeProductId, storeId, receiptId, price, promoPrice, validFrom, promoEnd,
              isFallback, date, priceVerified, requiresCoupon)
             VALUES ?`,
            [toInsert],
        );
        return 'inserted';
    }
    return 'skipped';
}

/**
 * Insert or skip a promo price for an already-resolved StoreProduct.
 * Fans out to every store in the chain so all nearby stores get the promo.
 */
export async function upsertPriceForSpId(
    spId: number,
    chainId: number,
    imageUrl: string | null,
    regularPrice: number,
    promoPrice: number | null,
    promoEnd: Date,
    requiresCoupon = false,
    promoStart: Date | null = null,
): Promise<'inserted' | 'skipped'> {
    if (imageUrl) {
        const [rows]: any = await pool.query('SELECT imageUrl FROM StoreProduct WHERE id = ?', [spId]);
        if (!rows[0]?.imageUrl) await updateStoreProductImageUrl(spId, imageUrl);
    }
    return fanOutPrice(spId, chainId, regularPrice, promoPrice, promoStart, promoEnd, requiresCoupon);
}

export async function upsertPromo(p: PromoProduct): Promise<UpsertResult> {
    // ── 1. Exact SP in chain (fast path) ─────────────────────────────────────
    let spId: number | null = await findExactMatchingStoreProduct(
        p.chainId, p.storeProductName, p.amount, p.unit,
    );
    let reusedSp = spId != null;
    let result: UpsertResult = 'inserted';

    if (!spId) {
        // ── 2. Advanced-matcher resolution: same-chain SP → cross-chain Product
        //    (JOIN ≥0.80, else MINT in the borrowed category ≥0.75) → uncategorised.
        const match = await matchScrapedProduct(
            p.chainId, p.storeProductName, p.amount, p.unit, p.isWeighable,
        );
        if (match.spId != null) {
            spId = match.spId;               // reuse an existing SP in this chain
            reusedSp = true;
        } else {
            let productId: number;
            if (match.productId != null) {
                productId = match.productId;  // JOIN an existing catalog Product
                result = 'sp_created';
            } else {
                productId = await createProduct(match.categoryId, null, p.storeProductName);
                if (match.reviewPending) {
                    await pool.query('UPDATE Product SET categoryReviewPending = 1 WHERE id = ?', [productId]);
                }
                result = 'product_created';
            }
            // ── 3. Create the StoreProduct under the resolved Product ─────────
            spId = await createStoreProduct(
                productId, p.chainId, p.storeProductName,
                null, p.isWeighable, p.amount, p.unit, p.imageUrl, p.siteCategory ?? null,
            );
        }
    }

    if (!spId) throw new Error(`Failed to resolve storeProductId for "${p.storeProductName}"`);

    // Map chain-native codes → this SP. A collision (code already on a DIFFERENT
    // SP) means either the SAME LISTING scraped from two sources (grid + leaflet
    // → physically dedup, current resolution wins) or a PACK CHANGE (re-point the
    // code to the current listing; the old SP keeps its history).
    let codeConfirmed = false;
    if (p.itemCodes?.length) {
        const codes = [...new Set(p.itemCodes.map(c => c.replace(/^0+/, '')).filter(c => /^\d{3,16}$/.test(c)))];
        if (codes.length) {
            const [existing]: any = await pool.query(
                'SELECT code, storeProductId FROM StoreProductCode WHERE chainId = ? AND code IN (?)',
                [p.chainId, codes],
            );
            const byCode = new Map<string, number>((existing as any[]).map(r => [String(r.code), Number(r.storeProductId)]));
            for (const code of codes) {
                const mapped = byCode.get(code);
                if (mapped == null) {
                    await pool.query('INSERT IGNORE INTO StoreProductCode (chainId, code, storeProductId) VALUES (?, ?, ?)',
                        [p.chainId, code, spId]);
                } else if (mapped === spId) {
                    codeConfirmed = true;
                } else {
                    const [amts]: any = await pool.query(
                        'SELECT id, productId, amount FROM StoreProduct WHERE id IN (?, ?)', [spId, mapped]);
                    const cur = (amts as any[]).find(r => Number(r.id) === spId);
                    const oth = (amts as any[]).find(r => Number(r.id) === mapped);
                    const sameAmount = cur && oth
                        && ((cur.amount == null && oth.amount == null)
                            || (cur.amount != null && oth.amount != null && Math.abs(Number(cur.amount) - Number(oth.amount)) < 0.001));
                    if (sameAmount) {
                        // same listing from two sources → physical dedup, current wins
                        const { dedupStoreProduct } = await import('../../services/storeProductDedupService.js');
                        const { promoteMergeByProductIds } = await import('../../services/storeProductMergeService.js');
                        await dedupStoreProduct(spId, mapped);
                        const [left]: any = await pool.query('SELECT COUNT(*) n FROM StoreProduct WHERE productId = ?', [oth.productId]);
                        if (Number(left[0].n) === 0 && Number(oth.productId) !== Number(cur.productId)) {
                            await promoteMergeByProductIds(Number(oth.productId), Number(cur.productId));
                        }
                        codeConfirmed = true;
                    } else {
                        // pack change — the code follows the current listing
                        await pool.query('UPDATE StoreProductCode SET storeProductId = ? WHERE chainId = ? AND code = ?',
                            [spId, p.chainId, code]);
                    }
                }
            }
        }
    }

    // Name self-heal: a WEBSITE-authoritative name on a code-confirmed reused SP
    // replaces a divergent stored name (leaflet typo — "Šilaguogės" → "Šilauogės").
    if (reusedSp && p.nameAuthority && codeConfirmed) {
        await pool.query(
            'UPDATE StoreProduct SET storeProductName = ? WHERE id = ? AND storeProductName <> ?',
            [p.storeProductName, spId, p.storeProductName],
        );
    }

    // Backfill image / siteCategory on a REUSED SP that lacks them.
    if (reusedSp && (p.imageUrl || p.siteCategory)) {
        const [rows]: any = await pool.query('SELECT imageUrl, siteCategory FROM StoreProduct WHERE id = ?', [spId]);
        if (p.imageUrl && !rows[0]?.imageUrl) await updateStoreProductImageUrl(spId, p.imageUrl);
        if (p.siteCategory && !rows[0]?.siteCategory) {
            await pool.query('UPDATE StoreProduct SET siteCategory = ? WHERE id = ?', [p.siteCategory, spId]);
        }
    }

    // ── 4. Fan out price to all chain stores ─────────────────────────────────
    const fanResult = await fanOutPrice(
        spId, p.chainId,
        p.regularPrice, p.promoPrice, p.promoStart ?? null, p.promoEnd,
        p.requiresCoupon ?? false,
    );
    if (fanResult === 'skipped' && result === 'inserted') result = 'skipped';

    return result;
}
