import pool from '../config/db.js';
import { getUnassignedCategoryId } from '../services/receiptLineResolver.js';
import { createProduct } from './productModel.js';
import { createStoreProduct, findExactMatchingStoreProduct } from './storeProductModel.js';
import { logAdminAction } from '../services/adminActionLog.js';

export interface SourceReceiptInfo {
    priceId: number;
    receiptId: number;
    lineIdx: number;
    storeProductId: number;
    storeId: number;
    chainId: number;
    price: number;
    promoPrice: number | null;
    amount: number | null;
    unit: string | null;
    date: string;
    /** Raw OCR text for this line as stored in parsedData.products[lineIdx].name */
    ocrName: string | null;
}

/** Find the most recent receipt-sourced Price for any SP of this product,
 *  and locate its index inside parsedData.products. Returns null when the
 *  product has no receipt history (scraper-only product, nothing to split). */
export async function getProductSourceReceipt(productId: number): Promise<SourceReceiptInfo | null> {
    const [rows]: any = await pool.query(
        `SELECT p.id AS priceId, p.receiptId, p.storeProductId, p.storeId,
                p.price, p.promoPrice, p.date,
                sp.chainId, sp.amount, sp.unit
         FROM Price p
         JOIN StoreProduct sp ON sp.id = p.storeProductId
         WHERE sp.productId = ?
           AND p.receiptId IS NOT NULL
         ORDER BY p.id DESC
         LIMIT 1`,
        [productId],
    );
    if (!rows[0]) return null;
    const row = rows[0];

    const [receiptRows]: any = await pool.query(
        `SELECT parsedData FROM Receipt WHERE id = ? LIMIT 1`,
        [row.receiptId],
    );
    if (!receiptRows[0]?.parsedData) return null;
    const pd = typeof receiptRows[0].parsedData === 'string'
        ? JSON.parse(receiptRows[0].parsedData)
        : receiptRows[0].parsedData;

    const products: any[] = pd?.products ?? [];
    const lineIdx = products.findIndex(
        p => Number(p.storeProductId) === Number(row.storeProductId),
    );
    if (lineIdx === -1) return null;

    return {
        priceId:        Number(row.priceId),
        receiptId:      Number(row.receiptId),
        lineIdx,
        storeProductId: Number(row.storeProductId),
        storeId:        Number(row.storeId),
        chainId:        Number(row.chainId),
        price:          Number(row.price),
        promoPrice:     row.promoPrice != null ? Number(row.promoPrice) : null,
        amount:         row.amount     != null ? Number(row.amount)     : null,
        unit:           row.unit ?? null,
        date:           row.date,
        ocrName:        typeof products[lineIdx]?.name === 'string' ? products[lineIdx].name : null,
    };
}

interface SplitItem {
    name: string;
    price: number;
    promoPrice: number | null;
    amount: number | null;
    unit: string | null;
}

export interface SplitResult {
    newProductId: number;
    newIsNew: boolean;
}

/**
 * Apply the split:
 *   top    → new Product + SP + Price (goes through the matching pipeline)
 *   bottom → overwrites the existing Product / SP / Price that caused the merge
 *
 * Runs in a single transaction. parsedData on the receipt is updated so the
 * user sees two corrected lines instead of the one merged line.
 */
export async function applyReceiptSplit(opts: {
    adminId: string;
    productId: number;
    priceId: number;
    top: SplitItem;
    bottom: SplitItem;
}): Promise<SplitResult> {
    const conn = await (pool as any).getConnection();
    try {
        await conn.beginTransaction();

        // Fetch the existing Price row and its SP
        const [[priceRow]]: any = await conn.query(
            `SELECT p.storeProductId, p.storeId, p.receiptId, p.date,
                    sp.productId, sp.chainId
             FROM Price p
             JOIN StoreProduct sp ON sp.id = p.storeProductId
             WHERE p.id = ? LIMIT 1`,
            [opts.priceId],
        );
        if (!priceRow) throw new Error('Price record not found');

        const { storeProductId, storeId, receiptId, date, productId, chainId } = priceRow;

        // ── Update existing (bottom) ───────────────────────────────────
        await conn.query(
            `UPDATE Product SET name = ? WHERE id = ?`,
            [opts.bottom.name, productId],
        );
        await conn.query(
            `UPDATE StoreProduct SET storeProductName = ?, amount = ?, unit = ? WHERE id = ?`,
            [opts.bottom.name, opts.bottom.amount ?? null, opts.bottom.unit ?? null, storeProductId],
        );
        await conn.query(
            `UPDATE Price SET price = ?, promoPrice = ? WHERE id = ?`,
            [opts.bottom.price, opts.bottom.promoPrice ?? null, opts.priceId],
        );

        // ── Create (or reuse) the new (top) catalog SP DIRECTLY ─────────
        // Admin curation is a legitimate SP-creation path (unlike receipt processing, which
        // no longer mints — see the ReceiptItem no-mint policy). Dedup on exact name+size,
        // else create a fresh uncategorised catalog SP.
        let topSpId = await findExactMatchingStoreProduct(Number(chainId), opts.top.name, opts.top.amount, opts.top.unit, conn);
        const topWasCreated = !topSpId;
        if (!topSpId) {
            const catId = await getUnassignedCategoryId(conn);
            const prodId = await createProduct(catId, null, opts.top.name, conn);
            topSpId = await createStoreProduct(prodId, Number(chainId), opts.top.name, null, false, opts.top.amount, opts.top.unit, null, null, conn);
        }

        await conn.query(
            `INSERT INTO Price
                 (storeProductId, storeId, receiptId, price, promoPrice, isFallback, date, priceVerified)
             VALUES (?, ?, ?, ?, ?, 0, ?, 0)
             ON DUPLICATE KEY UPDATE price = VALUES(price), promoPrice = VALUES(promoPrice)`,
            [
                topSpId, storeId, receiptId,
                opts.top.price, opts.top.promoPrice ?? null, date,
            ],
        );

        const [[newSp]]: any = await conn.query(
            `SELECT productId FROM StoreProduct WHERE id = ? LIMIT 1`,
            [topSpId],
        );
        const newProductId = Number(newSp.productId);

        // ── Update parsedData — replace merged item with two items ─────
        const [[receiptRow]]: any = await conn.query(
            `SELECT parsedData FROM Receipt WHERE id = ? LIMIT 1`,
            [receiptId],
        );
        if (receiptRow?.parsedData) {
            const pd = typeof receiptRow.parsedData === 'string'
                ? JSON.parse(receiptRow.parsedData)
                : receiptRow.parsedData;
            const products: any[] = pd?.products ?? [];
            const idx = products.findIndex(
                p => Number(p.storeProductId) === Number(storeProductId),
            );
            if (idx !== -1) {
                const orig = products[idx];
                const topLine    = { ...orig, name: opts.top.name,    price: opts.top.price,    promoPrice: opts.top.promoPrice    ?? null, amount: opts.top.amount    ?? null, unit: opts.top.unit    ?? null, storeProductId: topSpId };
                const bottomLine = { ...orig, name: opts.bottom.name, price: opts.bottom.price, promoPrice: opts.bottom.promoPrice ?? null, amount: opts.bottom.amount ?? null, unit: opts.bottom.unit ?? null, storeProductId: Number(storeProductId) };
                products.splice(idx, 1, topLine, bottomLine);
                await conn.query(
                    `UPDATE Receipt SET parsedData = ? WHERE id = ?`,
                    [JSON.stringify(pd), receiptId],
                );
            }
        }

        await logAdminAction({
            adminUserId: opts.adminId,
            action: 'uncategorised_split',
            targetType: 'Product',
            targetId: Number(productId),
            valueBefore: { mergedName: opts.bottom.name },
            valueAfter: { topName: opts.top.name, bottomName: opts.bottom.name, newProductId },
        });

        await conn.commit();
        return { newProductId, newIsNew: topWasCreated };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}
