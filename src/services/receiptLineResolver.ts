import pool from '../config/db.js';
import { createProduct } from '../models/productModel.js';
import {
    createStoreProduct,
    findExactMatchingStoreProduct,
} from '../models/storeProductModel.js';

type Connection = typeof pool | any;

// Cross-chain bootstrap gates — applied when the matcher surfaces a
// StoreProduct from a DIFFERENT chain than the receipt's (Lidl/Norfa
// receipts against the scraped Maxima/Rimi/IKI catalog). We only
// bootstrap a new SP in the receipt's chain when ALL gates pass,
// otherwise we fall through to creating a new Product entirely.
//
//   PRICE: asymmetric band around the cross-chain SP's latest Price.
//     Lidl/Norfa are structurally ~10-20% cheaper than Maxima/Rimi,
//     so the lower bound is loose while the upper bound stays tight
//     (receipts shouldn't land HIGHER than the reference chain
//     without good reason — that usually signals a wrong match).
//
//   AMOUNT/UNIT (lenient): only enforced when BOTH the receipt line
//     and the cross-chain SP have amount+unit populated. When either
//     side is null we skip the check — receipt parsers (especially
//     Lidl thermal) often fail to extract size from the line text.
const CROSS_CHAIN_PRICE_LOWER_RATIO = 0.6;   // -40% floor
const CROSS_CHAIN_PRICE_UPPER_RATIO = 1.2;   // +20% ceiling

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
    /** Receipt line price — used for the cross-chain bootstrap price gate. */
    price: number | null;
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
     *  Product + StoreProduct (caller should still write Price).
     *  'bootstrapped' = cross-chain match accepted; we wrote a new SP in
     *  the receipt's chain pointing at the matched Product. */
    source: 'reused' | 'created' | 'bootstrapped';
    /** When 'bootstrapped' or 'reused' following a cross-chain redirect,
     *  this flags that the resolver intentionally did NOT use the SP the
     *  caller passed in (it belonged to a different chain) — useful for
     *  logging / metric counters. */
    crossChainBootstrap?: boolean;
    /** Reason the bootstrap gate rejected, if applicable. Falls back to
     *  the standard create-new-Product path when any gate fails. */
    rejectReason?: 'price_out_of_band' | 'amount_mismatch';
}

interface SPLookup {
    id: number;
    productId: number;
    chainId: number;
    amount: number | null;
    unit: string | null;
    imageUrl: string | null;
    brandName: string | null;
    isWeighable: boolean;
    storeProductName: string;
}

/**
 * Find existing SP in `chainId` with matching (productId, amount, unit).
 * Post-dedupe (UNIQUE index on those 4 cols), this returns at most one row.
 * Used by the cross-chain bootstrap so repeated receipts from the same
 * chain+Product+size don't keep minting new SPs.
 */
const findSpByChainProductSize = async (
    chainId: number,
    productId: number,
    amount: number | null,
    unit: string | null,
    db: Connection
): Promise<number | null> => {
    const [rows]: any = await db.query(
        `SELECT id FROM StoreProduct
         WHERE chainId = ? AND productId = ?
           AND ((amount IS NULL AND ? IS NULL) OR amount = ?)
           AND ((unit   IS NULL AND ? IS NULL) OR unit   = ?)
         LIMIT 1`,
        [chainId, productId, amount, amount, unit, unit]
    );
    return rows[0]?.id ?? null;
};

/** Fetch a StoreProduct row by id — returns null if it's been deleted. */
const getSpById = async (spId: number, db: Connection): Promise<SPLookup | null> => {
    const [rows]: any = await db.query(
        `SELECT id, productId, chainId, amount, unit, imageUrl, brandName,
                isWeighable, storeProductName
         FROM StoreProduct WHERE id = ? LIMIT 1`,
        [spId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
        id: Number(r.id),
        productId: Number(r.productId),
        chainId: Number(r.chainId),
        amount: r.amount === null ? null : Number(r.amount),
        unit: r.unit ?? null,
        imageUrl: r.imageUrl ?? null,
        brandName: r.brandName ?? null,
        isWeighable: !!r.isWeighable,
        storeProductName: r.storeProductName,
    };
};

/** Latest Price.price for an SP, ordered by date then id. null if no rows. */
const getLatestPriceForSp = async (spId: number, db: Connection): Promise<number | null> => {
    const [rows]: any = await db.query(
        `SELECT price FROM Price
         WHERE storeProductId = ?
         ORDER BY date DESC, id DESC
         LIMIT 1`,
        [spId]
    );
    if (rows.length === 0) return null;
    const n = Number(rows[0].price);
    return Number.isFinite(n) ? n : null;
};

/**
 * Evaluate the cross-chain bootstrap gates against a candidate SP from
 * another chain. Returns `null` when all gates pass (caller should
 * bootstrap); otherwise returns the rejection reason so the caller can
 * log it and fall back to the standard create-new-Product path.
 */
const checkCrossChainBootstrapGates = async (
    line: ReceiptLineInput,
    altSp: SPLookup,
    db: Connection
): Promise<null | 'price_out_of_band' | 'amount_mismatch'> => {
    // Price gate — asymmetric band around altSp's latest price.
    // Missing-data cases fail OPEN (bootstrap allowed) because we can
    // either trust the confidence signal or nothing at all. This is
    // the lenient interpretation agreed earlier; flip to fail-closed
    // if false positives become a problem.
    const altPrice = await getLatestPriceForSp(altSp.id, db);
    if (altPrice !== null && altPrice > 0 && line.price !== null && line.price > 0) {
        const ratio = line.price / altPrice;
        if (ratio < CROSS_CHAIN_PRICE_LOWER_RATIO || ratio > CROSS_CHAIN_PRICE_UPPER_RATIO) {
            return 'price_out_of_band';
        }
    }

    // Amount gate (lenient) — only enforced when BOTH sides have values.
    if (line.amount !== null && altSp.amount !== null) {
        const amountEq = Math.abs(line.amount - altSp.amount) < 1e-6;
        const unitEq = (line.unit ?? null) === (altSp.unit ?? null);
        if (!amountEq || !unitEq) return 'amount_mismatch';
    }

    return null;
};

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
    const db = conn || pool;

    // If the caller supplied an SP id (mobile matcher's choice, or a
    // prior resolver run), check whether it belongs to the receipt's
    // chain. Same-chain → use verbatim. Cross-chain → redirect into
    // the bootstrap path: we don't want to attach a Lidl receipt's
    // Price row to a Maxima StoreProduct.
    if (line.storeProductId) {
        const sp = await getSpById(line.storeProductId, db);
        if (sp && sp.chainId === chainId) {
            return { storeProductId: line.storeProductId, source: 'reused' };
        }
        if (sp) {
            // Cross-chain SP — evaluate bootstrap gates. On pass, mint
            // a new SP in the receipt's chain (or reuse if one already
            // exists for this Product+size). On reject, fall through
            // to the standard create-new-Product flow below.
            const reject = await checkCrossChainBootstrapGates(line, sp, db);
            if (!reject) {
                const existingInChain = await findSpByChainProductSize(
                    chainId, sp.productId, line.amount, line.unit, db
                );
                if (existingInChain) {
                    return {
                        storeProductId: existingInChain,
                        source: 'reused',
                        crossChainBootstrap: true,
                    };
                }
                // Mint new SP. Receipt supplies the user-visible fields
                // (name, amount, unit); cross-chain altSp contributes
                // catalog enrichment (brandName, isWeighable, imageUrl).
                const newSpId = await createStoreProduct(
                    sp.productId,
                    chainId,
                    line.name,
                    line.brandName ?? sp.brandName,
                    line.isWeighable || sp.isWeighable,
                    line.amount,
                    line.unit,
                    sp.imageUrl,
                    db
                );
                return {
                    storeProductId: newSpId,
                    source: 'bootstrapped',
                    crossChainBootstrap: true,
                };
            }
            // Fall through on rejection, but remember the reason so
            // the caller can surface it in logs/metrics.
            if (!line.name || !line.name.trim()) {
                throw new Error('Cannot resolve receipt line without a name');
            }
            const fallback = await createFreshProductAndSp(chainId, line, db);
            return { ...fallback, rejectReason: reject };
        }
        // SP id provided but row no longer exists (deleted mid-flow).
        // Fall through as if no SP was supplied.
    }

    if (!line.name || !line.name.trim()) {
        throw new Error('Cannot resolve receipt line without a name');
    }

    // Dedup: same chain + exact name + matching amount/unit.
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

    return await createFreshProductAndSp(chainId, line, db);
};

/**
 * Create a Product (or reuse altMatchProductId's Product) + new SP for
 * `line` in `chainId`. Used as the standard path when there's no SP to
 * reuse, and as the fallback when the cross-chain bootstrap gates fail.
 */
const createFreshProductAndSp = async (
    chainId: number,
    line: ReceiptLineInput,
    db: Connection
): Promise<ResolveResult> => {
    // Resolve category + (optionally) the existing Product to reuse.
    // When the matcher surfaced an alt-match — same chain with a
    // Product that looks like this line, OR a cross-chain fallback
    // result — we borrow its categoryId. productId reuse for cross-
    // chain altMatches happens in the main resolver's bootstrap
    // branch; this helper only reuses Product identity when the
    // altMatch is SAME-chain (dedup clustering).
    let productId: number | null = null;
    let categoryId: number | null = null;
    if (line.altMatchProductId) {
        const [rows]: any = await db.query(
            'SELECT id, categoryId FROM Product WHERE id = ? LIMIT 1',
            [line.altMatchProductId]
        );
        if (rows.length > 0) {
            productId = rows[0].id;
            categoryId = rows[0].categoryId;
        }
    }
    if (categoryId === null) {
        categoryId = await getUnassignedCategoryId(db);
    }

    const resolvedProductId: number =
        productId ?? (await createProduct(categoryId, null, line.name, db));

    const storeProductId = await createStoreProduct(
        resolvedProductId,
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
