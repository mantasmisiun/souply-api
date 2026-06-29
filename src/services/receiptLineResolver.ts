import pool from '../config/db.js';
import { createProduct } from '../models/productModel.js';
import {
    createStoreProduct,
    findExactMatchingStoreProduct,
    markStoreProductWeighable,
} from '../models/storeProductModel.js';
import { hasFixedPackForm } from '../utils/productMatcher.js';
import { RECOGNITION } from '../../../shared/recognitionConfig.js';

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
const CROSS_CHAIN_PRICE_LOWER_RATIO = RECOGNITION.resolve.crossChainPriceLowerRatio;   // -40% floor
const CROSS_CHAIN_PRICE_UPPER_RATIO = RECOGNITION.resolve.crossChainPriceUpperRatio;   // +20% ceiling

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
    /**
     * Confidence of that top alt-match (line.altMatches[0].confidence). Gates
     * whether we also CLUSTER the new SP under the alt-match's Product: only at
     * or above `resolve.autoBaseProductThreshold`. Below it (or null/legacy) we
     * borrow the categoryId only and mint a FRESH Product — so a weak match
     * (apples @0.51 onto a potatoes Product) doesn't file apples under potatoes.
     */
    altMatchConfidence?: number | null;
    /**
     * Confidence of the chosen storeProductId match (line.matchConfidence). Gates
     * the weighable self-heal: only a STRONG by-weight match flips a mislabeled
     * packaged SP to weighable.
     */
    matchConfidence?: number | null;
}

export interface ResolveResult {
    /** null when source is 'skipped_unpriced' — no SP was created (see below). */
    storeProductId: number | null;
    /** 'reused' = dedup found an existing SP. 'created' = we wrote a new
     *  Product + StoreProduct (caller should still write Price).
     *  'bootstrapped' = cross-chain match accepted; we wrote a new SP in
     *  the receipt's chain pointing at the matched Product.
     *  'skipped_unpriced' = the line has no usable price (≤0), so the OCR is
     *  treated as too garbled to trust — we REUSE an existing SP if one matches
     *  but never CREATE a fresh one, so a bad parse can't mint catalog junk. */
    source: 'reused' | 'created' | 'bootstrapped' | 'skipped_unpriced';
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
           AND (amount IS NULL OR ? IS NULL OR amount = ?)
           AND (unit   IS NULL OR ? IS NULL OR unit   = ?)
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
        const amountEq = Math.abs(line.amount - altSp.amount) < RECOGNITION.resolve.amountEpsilonAbs;
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
    conn?: Connection,
    // When false, the resolver may REUSE an existing SP but must NOT CREATE a new
    // one. The caller passes false for a line with no usable price (≤0): a
    // price-less line means the parse couldn't even establish a €/kg or total, so
    // the OCR is too garbled to trust — minting a fresh SP from it just pollutes
    // the catalog (e.g. a weight-calc fragment becomes a product name). See
    // [[project_weighed_item_price_poisoning_guard]] — show it, never write price,
    // and now never create an SP either.
    allowCreate = true,
): Promise<ResolveResult> => {
    const db = conn || pool;
    const skipped: ResolveResult = { storeProductId: null, source: 'skipped_unpriced' };

    // If the caller supplied an SP id (mobile matcher's choice, or a
    // prior resolver run), check whether it belongs to the receipt's
    // chain. Same-chain → use verbatim. Cross-chain → redirect into
    // the bootstrap path: we don't want to attach a Lidl receipt's
    // Price row to a Maxima StoreProduct.
    if (line.storeProductId) {
        const sp = await getSpById(line.storeProductId, db);
        if (sp && sp.chainId === chainId) {
            // If both the SP and the receipt line carry amount data and they
            // differ by more than 30%, the matcher picked the wrong size variant
            // (e.g. 1 L SP for a 1.51 L product). Fall through to dedup/create
            // so a correctly-sized SP is found or created instead.
            const amountMismatch =
                sp.amount !== null &&
                line.amount !== null &&
                Math.abs(sp.amount - line.amount) / Math.max(sp.amount, line.amount) > RECOGNITION.resolve.sameChainAmountMismatch;
            // A by-WEIGHT line must not reuse a PACKAGED SP (or vice-versa) — they're
            // different product forms the name matcher can't tell apart (a loose
            // 0,47 kg paprika vs a 180 g "BON VIA" pack). Reject and fall through so
            // a correctly-formed SP is found or created. (Server safety net; the
            // match endpoint's weighable gate prevents most of these upstream.)
            const weighableMismatch = sp.isWeighable !== line.isWeighable;
            // SELF-HEAL: a by-WEIGHT line that STRONGLY matched a BULK-WEIGHT (kg/l) SP
            // flagged isWeighable=0 is real-world evidence the catalog flag is wrong (a
            // produce row sold by weight). Correct the catalog — flip it weighable and
            // reuse it — instead of minting a garbled orphan. Gated to a WEIGHT-COMPATIBLE
            // SP (NO fixed pack form — the SAME `!hasFixedPackForm` rule the matcher gate
            // uses) so it covers a unit-less catalog SP (e.g. "Raudonosios paprikos BON
            // VIA", sold per kg but with no kg in the name → scraper left unit null) AND a
            // "1 kg" produce row, while a PER-ITEM ("vnt") SP or a fixed package (g/ml/
            // multi-kg bag) is NEVER flipped, even on a strong match.
            if (
                weighableMismatch && !amountMismatch &&
                line.isWeighable === true && sp.isWeighable === false &&
                !hasFixedPackForm(sp.amount, sp.unit) &&
                (line.matchConfidence ?? 0) >= RECOGNITION.resolve.weighableSelfHealMinConfidence
            ) {
                await markStoreProductWeighable(sp.id, db);
                return { storeProductId: line.storeProductId, source: 'reused' };
            }
            if (!amountMismatch && !weighableMismatch) {
                return { storeProductId: line.storeProductId, source: 'reused' };
            }
            // Amount or (uncorrected) weighable mismatch — fall through to dedup/create.
        } else if (sp) {
            // Cross-chain SP — evaluate bootstrap gates. On pass, mint
            // a new SP in the receipt's chain (or reuse if one already
            // exists for this Product+size). On reject, fall through
            // to the standard create-new-Product flow below.
            // Run the price-gate check and the dedup lookup concurrently —
            // both are independent reads and the dedup result is discarded
            // anyway when the gate rejects.
            const [reject, existingInChain] = await Promise.all([
                checkCrossChainBootstrapGates(line, sp, db),
                findSpByChainProductSize(chainId, sp.productId, line.amount, line.unit, db),
            ]);
            if (!reject) {
                if (existingInChain) {
                    return {
                        storeProductId: existingInChain,
                        source: 'reused',
                        crossChainBootstrap: true,
                    };
                }
                if (!allowCreate) return skipped; // price-less line → don't mint
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
            // the caller can surface it in logs/metrics. Pass
            // `skipAltMatchProductReuse` so the fresh-product helper
            // doesn't quietly link the new SP to the rejected cross-
            // chain Product via `line.altMatchProductId` — that would
            // defeat the gate decision at the Product level.
            if (!allowCreate) return skipped; // price-less line → don't create
            if (!line.name || !line.name.trim()) {
                throw new Error('Cannot resolve receipt line without a name');
            }
            const fallback = await createFreshProductAndSp(chainId, line, db, {
                skipAltMatchProductReuse: true,
            });
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

    if (!allowCreate) return skipped; // price-less line → don't create catalog junk
    return await createFreshProductAndSp(chainId, line, db);
};

/**
 * Create a Product (or reuse altMatchProductId's Product) + new SP for
 * `line` in `chainId`. Used as the standard path when there's no SP to
 * reuse, and as the fallback when the cross-chain bootstrap gates fail.
 *
 * `altMatchProductId` reuse is the helper's main quirk: when the matcher
 * surfaced a candidate Product (same-chain dedup clustering), we link
 * the new SP to it so different OCR name variants of the same product
 * collapse onto one `Product` row. Callers entering from a cross-chain
 * gate REJECTION must pass `skipAltMatchProductReuse: true` — otherwise
 * the rejected cross-chain match still leaks into the new SP via the
 * altMatch's productId, defeating the gate at the Product level.
 */
const createFreshProductAndSp = async (
    chainId: number,
    line: ReceiptLineInput,
    db: Connection,
    options: { skipAltMatchProductReuse?: boolean } = {},
): Promise<ResolveResult> => {
    let productId: number | null = null;
    let categoryId: number | null = null;
    if (line.altMatchProductId && !options.skipAltMatchProductReuse) {
        const [rows]: any = await db.query(
            'SELECT id, categoryId FROM Product WHERE id = ? LIMIT 1',
            [line.altMatchProductId]
        );
        if (rows.length > 0) {
            // Borrow the candidate's CATEGORY always (a wrong-but-related match still
            // yields a sane category), but only CLUSTER the new SP under its Product
            // when the match is confident enough. A weak match (apples @0.51 onto a
            // potatoes Product) borrows the category but spawns a FRESH Product, so
            // apples never file under potatoes. null confidence (legacy callers / no
            // altMatches threaded) preserves the prior reuse-always behaviour.
            categoryId = rows[0].categoryId;
            const conf = line.altMatchConfidence;
            if (conf == null || conf >= RECOGNITION.resolve.autoBaseProductThreshold) {
                productId = rows[0].id;
            }
        }
    }
    if (categoryId === null) {
        categoryId = await getUnassignedCategoryId(db);
    }

    const resolvedProductId: number =
        productId ?? (await createProduct(categoryId, null, line.name, db));

    let storeProductId: number;
    try {
        storeProductId = await createStoreProduct(
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
    } catch (e: any) {
        if (e.code === 'ER_DUP_ENTRY') {
            // Race or same-product different-OCR-name: the UNIQUE key on
            // (chainId, productId, amount, unit) already has this combination.
            // Find and reuse the existing SP instead of crashing.
            const existing = await findSpByChainProductSize(
                chainId, resolvedProductId, line.amount, line.unit, db
            );
            if (existing) return { storeProductId: existing, source: 'reused' };
        }
        throw e;
    }

    return { storeProductId, source: 'created' };
};
