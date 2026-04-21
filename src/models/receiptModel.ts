import pool from '../config/db.js';

type Connection = typeof pool | any;

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
        'SELECT * FROM Receipt WHERE userId = ?',
        [userId]
    );
    return rows;
};

export const getReceiptById = async (id: number) => {
    const [rows]: any = await pool.query(
        `SELECT r.*, sc.name as chainName 
         FROM Receipt r
         LEFT JOIN Store s ON r.storeId = s.id
         LEFT JOIN StoreChain sc ON s.chainId = sc.id
         WHERE r.id = ?`,
        [id]
    );
    return rows[0] || null;
};

export const updateReceiptDetails = async (
    id: number,
    receiptNo: string | null,
    receiptDate: Date | string | null,
    processingStatus: string,
    parsedData?: any,
    conn?: Connection
) => {
    const db = conn || pool;
    await db.query(
        'UPDATE Receipt SET receiptNo = ?, receiptDate = ?, processingStatus = ?, parsedData = COALESCE(?, parsedData) WHERE id = ?',
        [receiptNo, receiptDate, processingStatus, parsedData ? JSON.stringify(parsedData) : null, id]
    );
};

export const deleteReceipt = async (id: number) => {
    await pool.query('DELETE FROM Receipt WHERE id = ?', [id]);
};

export const updateReceiptStore = async (id: number, storeId: number, conn?: Connection) => {
    const db = conn || pool;
    await db.query(
        'UPDATE Receipt SET storeId = ? WHERE id = ?',
        [storeId, id]
    );
};

export const getReceiptByReceiptNoAndUser = async (receiptNo: string, userId: string, excludeReceiptId?: number) => {
    const [rows]: any = await pool.query(
        `SELECT * FROM Receipt 
         WHERE receiptNo = ? 
         AND userId = ? 
         AND processingStatus IN ("completed", "failed")
         ${excludeReceiptId ? 'AND id != ?' : ''}`,
        excludeReceiptId ? [receiptNo, userId, excludeReceiptId] : [receiptNo, userId]
    );
    return rows[0] || null;
};

export const getReceiptItemsWithDetails = async (receiptId: number) => {
    const [rows]: any = await pool.query(
        `SELECT 
            sp.storeProductName as name,
            sp.brandName,
            p.categoryId,
            c.name as categoryName,
            pr.price,
            pr.promoPrice,
            pr.id as priceId,
            sp.id as storeProductId
         FROM Price pr
         JOIN StoreProduct sp ON pr.storeProductId = sp.id
         JOIN Product p ON sp.productId = p.id
         JOIN Category c ON p.categoryId = c.id
         JOIN Store s ON pr.storeId = s.id
         JOIN Receipt r ON r.storeId = s.id
         WHERE r.id = ? AND pr.receiptId = ?`,
        [receiptId, receiptId]
    );
    return rows;
};

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
