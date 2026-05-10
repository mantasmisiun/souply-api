import pool from '../../config/db.js';
import {
    findExactMatchingStoreProduct,
    createStoreProduct,
    updateStoreProductImageUrl,
} from '../../models/storeProductModel.js';
import { createPrice, getPriceByStoreProductAndStore, extendPromoEnd } from '../../models/priceModel.js';
import { createProduct } from '../../models/productModel.js';
import {
    fuzzyMatchProduct,
    fuzzyMatchSp,
    addProductToIndex,
    addSpToIndex,
    normalizeName,
} from './productMatcher.js';

const NEPRISKIRTA_ID = 688;

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
    regularPrice: number;
    promoPrice: number | null;
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
    promoEnd: Date,
    requiresCoupon: boolean,
): Promise<'inserted' | 'skipped'> {
    const chainStoreIds = await getChainStoreIds(chainId);
    if (!chainStoreIds.length) return 'skipped';

    // Fetch the latest existing Price row for this SP at every chain store
    const [latestRows]: any = await pool.query(
        `SELECT p2.id, p2.storeId, p2.price, p2.promoPrice, p2.promoEnd, p2.requiresCoupon
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

    for (const storeId of chainStoreIds) {
        const existing = latestByStore.get(storeId);
        if (existing?.promoEnd && new Date(existing.promoEnd) >= new Date()) {
            const samePrice = Math.abs(parseFloat(existing.price) - regularPrice) < 0.001;
            const existingPromo = existing.promoPrice ? parseFloat(existing.promoPrice) : null;
            const samePromo = existingPromo === promoPrice ||
                (existingPromo !== null && promoPrice !== null &&
                 Math.abs(existingPromo - promoPrice) < 0.001);
            const sameCoupon = (existing.requiresCoupon ?? 0) === Number(requiresCoupon);
            if (samePrice && samePromo && sameCoupon) {
                if (promoEnd > new Date(existing.promoEnd)) toExtend.push(Number(existing.id));
                continue;
            }
        }
        toInsert.push([
            spId, storeId, null,
            regularPrice, promoPrice, promoEnd,
            false, now, true, requiresCoupon,
        ]);
    }

    if (toExtend.length > 0) {
        await pool.query('UPDATE Price SET promoEnd = ? WHERE id IN (?)', [promoEnd, toExtend]);
    }
    if (toInsert.length > 0) {
        await pool.query(
            `INSERT IGNORE INTO Price
             (storeProductId, storeId, receiptId, price, promoPrice, promoEnd,
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
    promoPrice: number,
    promoEnd: Date,
    requiresCoupon = false,
): Promise<'inserted' | 'skipped'> {
    if (imageUrl) {
        const [rows]: any = await pool.query('SELECT imageUrl FROM StoreProduct WHERE id = ?', [spId]);
        if (!rows[0]?.imageUrl) await updateStoreProductImageUrl(spId, imageUrl);
    }
    return fanOutPrice(spId, chainId, regularPrice, promoPrice, promoEnd, requiresCoupon);
}

export async function upsertPromo(p: PromoProduct): Promise<UpsertResult> {
    // ── 1. Find StoreProduct within chain ────────────────────────────────────
    let spId: number | null = await findExactMatchingStoreProduct(
        p.chainId, p.storeProductName, p.amount, p.unit,
    );

    if (!spId) {
        const fuzzyMatch = await fuzzyMatchSp(p.chainId, p.storeProductName, p.amount, p.unit);
        if (fuzzyMatch) spId = fuzzyMatch.id;
    }

    let result: UpsertResult = 'inserted';

    if (spId) {
        if (p.imageUrl) {
            const [rows]: any = await pool.query('SELECT imageUrl FROM StoreProduct WHERE id = ?', [spId]);
            if (!rows[0]?.imageUrl) await updateStoreProductImageUrl(spId, p.imageUrl);
        }
    } else {
        // ── 2. No SP match — find or create Product ──────────────────────────
        const productMatch = await fuzzyMatchProduct(p.storeProductName);
        let productId: number;

        if (productMatch) {
            productId = productMatch.id;
            result = 'sp_created';
        } else {
            productId = await createProduct(NEPRISKIRTA_ID, null, p.storeProductName);
            addProductToIndex({
                id: productId,
                categoryId: NEPRISKIRTA_ID,
                normName: normalizeName(p.storeProductName),
            });
            result = 'product_created';
        }

        // ── 3. Create StoreProduct under resolved Product ────────────────────
        spId = await createStoreProduct(
            productId, p.chainId, p.storeProductName,
            null, p.isWeighable, p.amount, p.unit, p.imageUrl,
        );
        addSpToIndex(p.chainId, {
            id: spId as number,
            productId,
            normName: normalizeName(p.storeProductName),
            amount: p.amount,
            unit: p.unit,
        });
    }

    if (!spId) throw new Error(`Failed to resolve storeProductId for "${p.storeProductName}"`);

    // ── 4. Fan out price to all chain stores ─────────────────────────────────
    const fanResult = await fanOutPrice(
        spId, p.chainId,
        p.regularPrice, p.promoPrice, p.promoEnd,
        p.requiresCoupon ?? false,
    );
    if (fanResult === 'skipped' && result === 'inserted') result = 'skipped';

    return result;
}
