import pool from '../config/db.js';
import type { Locale } from '../middleware/locale.js';
import { getReceiptItemLines } from './receiptItemModel.js';

type Connection = typeof pool | any;

/**
 * P2 Step B (ReceiptItem migration): the receipt's `products[]` are sourced from the
 * ReceiptItem rows (the source of truth), reassembled into the exact blob shape via the
 * lossless mapping. Falls back to the blob's own products for any receipt not yet
 * backfilled. Preserves `parsedData`'s original type (string stays string, object stays
 * object) so no caller's parse contract changes. Mutates `receipt` in place.
 */
async function attachReceiptItemProducts(receipt: any, id: number): Promise<void> {
    if (!receipt || receipt.parsedData == null) return;
    const wasString = typeof receipt.parsedData === 'string';
    let parsed: any = receipt.parsedData;
    if (wasString) { try { parsed = JSON.parse(parsed); } catch { return; } }
    if (!parsed || typeof parsed !== 'object') return;
    try {
        const lines = await getReceiptItemLines(id);
        if (lines.length === 0) return; // not backfilled → keep the blob's products
        parsed.products = lines;
    } catch { return; } // any row-read failure → keep the blob's products
    receipt.parsedData = wasString ? JSON.stringify(parsed) : parsed;
}

export const createReceipt = async (
    userId: string,
    storeId: number | null,
    filePath: string,
    fileType: string
) => {
    const [result]: any = await pool.query(
        'INSERT INTO Receipt (userId, storeId, filePath, fileType) VALUES (?, ?, ?, ?)',
        [userId, storeId, filePath, fileType]
    );
    return result.insertId;
};

export const getReceiptsByUserId = async (userId: string) => {
    const [rows]: any = await pool.query(
        `SELECT r.*,
                r.receiptNoCanonical AS receiptNo,
                sc.name         AS chainName,
                sc.logoUrl      AS chainLogoUrl,
                sc.miniLogoUrl  AS chainMiniLogoUrl,
                s.name          AS storeName,
                s.address       AS storeAddress
           FROM Receipt r
      LEFT JOIN Store      s  ON s.id        = r.storeId
      LEFT JOIN StoreChain sc ON sc.id       = s.chainId
          WHERE r.userId = ?
            AND r.userDeletedAt IS NULL
          ORDER BY r.id DESC`,
        [userId]
    );
    return rows;
};

/** The owning userId of a receipt (null if it doesn't exist). Cheap — one indexed
 *  lookup, no ReceiptItem join — for the ownership middleware on every :id route. */
export const getReceiptOwnerId = async (id: number): Promise<string | null> => {
    const [rows]: any = await pool.query('SELECT userId FROM Receipt WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? String(rows[0].userId) : null;
};

export const getReceiptById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT r.*, r.receiptNoCanonical AS receiptNo, sc.name as chainName
         FROM Receipt r
         LEFT JOIN Store s ON r.storeId = s.id
         LEFT JOIN StoreChain sc ON s.chainId = sc.id
         WHERE r.id = ?`,
        [id]
    );
    const receipt = rows[0] || null;
    await attachReceiptItemProducts(receipt, id); // products[] from ReceiptItem rows (P2 Step B)
    return receipt;
};

export const updateReceiptDetails = async (
    id: number,
    receiptNos: string[] | null,
    receiptDate: Date | string | null,
    processingStatus: string,
    parsedData?: any,
    conn?: Connection
) => {
    const db = conn || pool;
    // receiptNos is the SOLE identifier store. The canonical scalar id + the UNIQUE dedup key are a
    // STORED GENERATED column (receiptNoCanonical) derived from receiptNos[0], so we only write the
    // array here; the canonical recomputes automatically. Stored as JSON text; null when no id at all.
    await db.query(
        'UPDATE Receipt SET receiptNos = ?, receiptDate = ?, processingStatus = ?, parsedData = COALESCE(?, parsedData) WHERE id = ?',
        [
            receiptNos && receiptNos.length ? JSON.stringify(receiptNos) : null,
            receiptDate,
            processingStatus,
            parsedData ? JSON.stringify(parsedData) : null,
            id,
        ]
    );
};

export const deleteReceipt = async (id: number) => {
    await pool.query('DELETE FROM Receipt WHERE id = ?', [id]);
};

/**
 * User-facing "remove this scan" (pre-swipe): soft-hide the receipt from every
 * user-facing read (userDeletedAt), detach it from its trip/list, and clear the
 * stored image path. Shared Price / ReceiptItem / learning rows are KEPT — this
 * is NOT the dev-only hard purge. The MinIO object itself is removed by the
 * caller (deleteReceiptImage). filePath is a NOT NULL column so it is emptied,
 * not nulled (matches the createReceipt `filePath || ''` convention).
 */
export const userHideReceipt = async (id: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query(
        "UPDATE Receipt SET userDeletedAt = NOW(), tripId = NULL, shoppingListId = NULL, filePath = '' WHERE id = ?",
        [id]
    );
};

/**
 * Un-hide a previously user-hidden receipt — the re-upload path: the user
 * removed a scan pre-swipe (keeping its idempotent prices) and re-photographed
 * the same paper. Clears userDeletedAt so it becomes visible + linkable again.
 */
export const reactivateHiddenReceipt = async (id: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query('UPDATE Receipt SET userDeletedAt = NULL WHERE id = ?', [id]);
};

/**
 * CROSS-USER re-upload of a relinquished (hidden) receipt: a DIFFERENT user
 * re-photographs the same physical paper that its original uploader had hidden
 * (userDeletedAt set, prices KEPT). The global unique key means one row per
 * physical receipt, so instead of 409 we hand the row to the new uploader:
 * clear userDeletedAt and transfer BOTH the owner (userId — drives ownership
 * middleware + the user's history read) and uploaderUserId to them. Prices /
 * ReceiptItem / learning rows are untouched; the caller re-links trip/list and
 * re-stores the image.
 */
export const reassignAndReactivateReceipt = async (id: number, newUserId: string, conn?: Connection) => {
    const db = conn || pool;
    await db.query(
        'UPDATE Receipt SET userDeletedAt = NULL, userId = ?, uploaderUserId = ? WHERE id = ?',
        [newUserId, newUserId, id],
    );
};

export const updateReceiptStore = async (id: number, storeId: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query(
        'UPDATE Receipt SET storeId = ? WHERE id = ?',
        [storeId, id]
    );
};

export const getReceiptByReceiptNoAndUser = async (receiptNo: string, userId: string, excludeReceiptId?: number) => {
    // Dedup by the canonical id, now the generated receiptNoCanonical (= receiptNos[0]); callers
    // still pass the canonical value (footer.receiptNo === receiptNos[0]).
    const [rows]: any = await pool.query(
        `SELECT * FROM Receipt
         WHERE receiptNoCanonical = ?
         AND userId = ?
         AND processingStatus IN ("completed", "failed")
         ${excludeReceiptId ? 'AND id != ?' : ''}`,
        excludeReceiptId ? [receiptNo, userId, excludeReceiptId] : [receiptNo, userId]
    );
    return rows[0] || null;
};

/**
 * A receipt id is DISTINCTIVE enough to witness a duplicate on its own: the full slashed
 * form ("168/645/104148") or any id with ≥6 digits (the VMI "Kvito numeris 104148", the
 * synthetic date-time-total id). Short bare ids are excluded — a 4-digit per-register
 * "Kvitas 3157" recurs across days on the same register and would false-positive.
 */
export const isDistinctiveReceiptNo = (id: string): boolean =>
    id.includes('/') || id.replace(/\D/g, '').length >= 6;

/**
 * Overlap-based same-user duplicate check: a re-scan of the SAME physical receipt is a
 * duplicate when ANY distinctive identifier is shared — the canonical column OR any entry
 * of the stored receiptNos arrays. The paper prints its id in several forms (IKI:
 * "Kvito Nr. 168/645/104148" + VMI "Kvito numeris 104148", plus a segment-corroboration
 * witness when the two disagree); all are stable on the same paper, so one clean read on
 * each side catches the duplicate even when the canonical id OCR-garbled differently in
 * the two scans — the exact case canonical-only matching let through.
 */
export const getReceiptByAnyReceiptNoAndUser = async (
    receiptNos: string[],
    userId: string,
    excludeReceiptId?: number,
) => {
    const ids = [...new Set(receiptNos.filter((v) => typeof v === 'string' && v.trim() && isDistinctiveReceiptNo(v)))];
    if (ids.length === 0) return null;
    // Canonical-column match for any id, plus JSON_CONTAINS against the stored array per id
    // (portable — no JSON_OVERLAPS dependency on older MariaDB).
    const jsonClauses = ids.map(() => 'JSON_CONTAINS(receiptNos, JSON_QUOTE(?))').join(' OR ');
    const [rows]: any = await pool.query(
        `SELECT * FROM Receipt
         WHERE userId = ?
           AND processingStatus IN ("completed", "failed")
           AND (receiptNoCanonical IN (?) OR ${jsonClauses})
           ${excludeReceiptId ? 'AND id != ?' : ''}
         LIMIT 1`,
        excludeReceiptId ? [userId, ids, ...ids, excludeReceiptId] : [userId, ids, ...ids],
    );
    return rows[0] || null;
};

/**
 * CROSS-USER witness overlap: the same physical receipt uploaded from two identities
 * only collides on the DB unique key when both scans captured the IDENTICAL canonical.
 * A garbled canonical on one side (r175 "24/626/17680" vs r191 "24/626/117680") or a
 * synthetic-only capture (r189) shares no key — but the receiptNos witness sets overlap
 * (the deterministic date+time+total synthetic rides in both). Bounded by store + day so
 * the JSON scan only ever touches that store's receipts for that date.
 */
export const getReceiptByAnyReceiptNoStoreDate = async (
    receiptNos: string[],
    storeId: number,
    date: string,
    excludeUserId?: string,
) => {
    const ids = [...new Set(receiptNos.filter((v) => typeof v === 'string' && v.trim() && isDistinctiveReceiptNo(v)))];
    if (ids.length === 0) return null;
    const jsonClauses = ids.map(() => 'JSON_CONTAINS(receiptNos, JSON_QUOTE(?))').join(' OR ');
    const params: any[] = [storeId, date];
    if (excludeUserId) params.push(excludeUserId);
    params.push(ids, ...ids);
    const [rows]: any = await pool.query(
        `SELECT * FROM Receipt
         WHERE storeId = ?
           AND DATE(receiptDate) = ?
           ${excludeUserId ? 'AND userId != ?' : ''}
           AND processingStatus IN ("completed", "failed")
           AND (receiptNoCanonical IN (?) OR ${jsonClauses})
         LIMIT 1`,
        params,
    );
    return rows[0] || null;
};

export const getReceiptItemsWithDetails = async (receiptId: number, locale: Locale = 'lt') => {
    // Read from ReceiptItem (ReceiptItem migration): EVERY line, matched or not — the old
    // INNER JOIN Price dropped unmatched lines, which under the no-mint policy is most of the
    // garbled ones. Catalog details LEFT-JOIN in for matched lines (matchedSpId); the price
    // links via Price.receiptItemId (the precise per-line link). Unmatched lines fall back to
    // the OCR name + the receipt-item's own price.
    const [rows]: any = await pool.query(
        `SELECT
            ri.lineIdx,
            COALESCE(sp.storeProductName, ri.matchedName, ri.name) as name,
            ri.name as ocrName,
            sp.brandName,
            p.categoryId,
            COALESCE(ct.name, c.name, ri.categoryName) as categoryName,
            COALESCE(pr.price, ri.price) as price,
            COALESCE(pr.promoPrice, ri.promoPrice) as promoPrice,
            pr.id as priceId,
            ri.matchedSpId as storeProductId
         FROM ReceiptItem ri
         LEFT JOIN StoreProduct sp ON sp.id = ri.matchedSpId
         LEFT JOIN Product p ON p.id = sp.productId
         LEFT JOIN Category c ON c.id = p.categoryId
         LEFT JOIN CategoryTranslation ct ON ct.categoryId = c.id AND ct.locale = ?
         LEFT JOIN Price pr ON pr.receiptItemId = ri.id
         WHERE ri.receiptId = ?
         ORDER BY ri.lineIdx ASC`,
        [locale, receiptId]
    );
    if (rows.length > 0) return rows;

    // Legacy fallback (deploy-order safety): a pre-migration receipt with no ReceiptItem
    // rows still has its lines in the blob. Every sibling reader carries this fallback —
    // without it an un-backfilled receipt's Items list renders empty until the backfill runs.
    const [blobRows]: any = await pool.query(
        'SELECT parsedData FROM Receipt WHERE id = ? LIMIT 1',
        [receiptId],
    );
    if (!blobRows[0]?.parsedData) return rows;
    let parsed: any;
    try {
        parsed = typeof blobRows[0].parsedData === 'string'
            ? JSON.parse(blobRows[0].parsedData)
            : blobRows[0].parsedData;
    } catch {
        return rows;
    }
    const products: any[] = Array.isArray(parsed?.products) ? parsed.products : [];
    return products.map((p: any, i: number) => ({
        lineIdx: i,
        name: p?.matchedName ?? p?.name ?? '',
        ocrName: p?.name ?? '',
        brandName: null,
        categoryId: p?.categoryId ?? null,
        categoryName: p?.categoryName ?? null,
        price: p?.price ?? null,
        promoPrice: p?.promoPrice ?? null,
        priceId: null,
        storeProductId: p?.storeProductId ?? null,
    }));
};

// NOTE: this rewrites parsedData (product items only) and deliberately does NOT touch the
// receiptNo / receiptNos columns — it must never alter footer.receiptNo / footer.receiptNos. If a
// future edit here changes an identifier, it MUST also re-derive both columns (see receiptSaveService),
// or the functional columns will silently diverge from the blob (recovery reads the columns).
export const updateReceiptParsedDataItem = async (
    receiptId: number,
    oldName: string,
    newName: string,
    categoryId: number,
    price: number,
    promoPrice: number | null
) => {
    const receipt = await getReceiptById(receiptId);
    if (!receipt?.parsedData) return;

    const parsedData = receipt.parsedData;

    if (oldName === '') {
        // Add new item
        parsedData.items.push({
            name: newName,
            categoryId,
            price,
            promoPrice,
            quantity: 1,
            isWeighable: false,
            brandName: null
        });
    } else {
        // Update existing item
        parsedData.items = parsedData.items.map((item: any) =>
            item.name === oldName
                ? { ...item, name: newName, categoryId, price, promoPrice }
                : item
        );
    }

    await pool.query(
        'UPDATE Receipt SET parsedData = ? WHERE id = ?',
        [JSON.stringify(parsedData), receiptId]
    );
};

 //Update Receipt.filePath after mobile finishes MinIO upload.
export const updateReceiptFilePath = async (id: number, filePath: string, conn?: Connection) => {
    const db = conn || pool;
    await db.query('UPDATE Receipt SET filePath = ? WHERE id = ?', [filePath, id]);
};

export const updateReceiptSavedAmount = async (id: number, amount: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query('UPDATE Receipt SET savedAmount = ? WHERE id = ?', [amount, id]);
};

export const setMandatorySwipesRequired = async (id: number, count: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query('UPDATE Receipt SET mandatorySwipesRequired = ? WHERE id = ?', [count, id]);
};

export const completeMandatorySwipes = async (id: number): Promise<void> => {
    await pool.query(
        'UPDATE Receipt SET mandatorySwipesCompleted = mandatorySwipesRequired WHERE id = ?',
        [id],
    );
};

export const incrementMandatorySwipesCompleted = async (id: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query(
        'UPDATE Receipt SET mandatorySwipesCompleted = mandatorySwipesCompleted + 1 WHERE id = ?',
        [id]
    );
};

export const setHasBurstSwipes = async (id: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query('UPDATE Receipt SET hasBurstSwipes = 1 WHERE id = ?', [id]);
};

export const getPendingMandatorySwipeCount = async (userId: string): Promise<number> => {
    const [rows]: any = await pool.query(
        `SELECT COUNT(*) AS cnt FROM Receipt
          WHERE userId = ?
            AND processingStatus = 'completed'
            AND mandatorySwipesCompleted < mandatorySwipesRequired`,
        [userId]
    );
    return rows[0]?.cnt ?? 0;
};

export const getLastThreeReceiptBurstFlags = async (userId: string): Promise<boolean[]> => {
    const [rows]: any = await pool.query(
        `SELECT hasBurstSwipes FROM Receipt
          WHERE userId = ? AND processingStatus = 'completed' AND mandatorySwipesRequired > 0
          ORDER BY id DESC LIMIT 3`,
        [userId]
    );
    return rows.map((r: any) => r.hasBurstSwipes === 1);
};
