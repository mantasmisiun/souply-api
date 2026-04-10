import pool from '../config/db';

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
    receiptDate: Date | null,
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