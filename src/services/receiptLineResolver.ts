import pool from '../config/db.js';
import { createProduct } from '../models/productModel.js';
import {
    createStoreProduct,
    findExactMatchingStoreProduct,
} from '../models/storeProductModel.js';

type Connection = typeof pool | any;

/** Cached id of the hidden Nepriskirta category used as a catch-all when a new
 * Product is created for a line with no confident category signal. Looked up
 * once at startup (or first use) and reused. */
let unassignedCategoryIdCache: number | null = null;

export const getUnassignedCategoryId = async (conn?: Connection): Promise<number> => {
    if (unassignedCategoryIdCache !== null) return unassignedCategoryIdCache;
    const db = conn || pool;
    const [rows]: any = await db.query(
        `SELECT id FROM Category WHERE name = 'Nepriskirta' AND isHidden = 1 LIMIT 1`
    );
    if (rows.length === 0) {
        throw new Error(
            'Nepriskirta (unassigned) category not seeded — run the category migration first'
        );
    }
    unassignedCategoryIdCache = rows[0].id;
    return unassignedCategoryIdCache!;
};

export interface ReceiptLineInput {
    storeProductId: number | null;
    name: string;
    brandName: string | null;
    amount: number | null;
    unit: string | null;
    isWeighable: boolean;
    imageUrl: string | null;
    /**
     * Top alt-match from the matcher, if present. Used as a fallback source of
     * categoryId when creating a new Product. Confidence can be anything —
     * we're only borrowing the candidate's Product.categoryId, not claiming
     * the match is correct.
     */
    altMatchProductId: number | null;
}

export interface ResolveResult {
    storeProductId: number;
    /** 'reused' = dedup found an existing SP. 'created' = we wrote a new
     *  Product + StoreProduct (caller should still write Price). */
    source: 'reused' | 'created';
}

/**
 * Resolve a receipt line to a concrete `storeProductId`. If the line already
 * has one (mobile's matcher assigned it), returns it verbatim. Otherwise
 * tries exact-match dedup against existing StoreProducts in the same chain,
 * and falls back to creating a fresh Product + StoreProduct.
 *
 * Caller is responsible for writing the Price row after this returns.
 */
export const resolveReceiptLineStoreProduct = async (
    chainId: number,
    line: ReceiptLineInput,
    conn?: Connection
): Promise<ResolveResult> => {
    if (line.storeProductId) {
        return { storeProductId: line.storeProductId, source: 'reused' };
    }
    if (!line.name || !line.name.trim()) {
        throw new Error('Cannot resolve receipt line without a name');
    }

    const db = conn || pool;

    // 1. Dedup: same chain + exact name + matching amount/unit.
    const existing = await findExactMatchingStoreProduct(
        chainId,
        line.name,
        line.amount,
        line.unit,
        db
    );
    if (existing) {
        return { storeProductId: existing, source: 'reused' };
    }

    // 2. Resolve category: inherit from top alt-match's Product when we have
    // one (more accurate than dumping into Nepriskirta), else fall back to
    // the unassigned bucket.
    let categoryId: number | null = null;
    if (line.altMatchProductId) {
        const [rows]: any = await db.query(
            'SELECT categoryId FROM Product WHERE id = ? LIMIT 1',
            [line.altMatchProductId]
        );
        if (rows.length > 0) categoryId = rows[0].categoryId;
    }
    if (categoryId === null) {
        categoryId = await getUnassignedCategoryId(db);
    }

    // 3. Create Product (auto-resolves baseProductId via resolveBaseProductId).
    const productId = await createProduct(categoryId, null, line.name, db);

    // 4. Create StoreProduct tied to that Product.
    const storeProductId = await createStoreProduct(
        productId,
        chainId,
        line.name,
        line.brandName,
        !!line.isWeighable,
        line.amount,
        line.unit,
        line.imageUrl,
        db
    );

    return { storeProductId, source: 'created' };
};
