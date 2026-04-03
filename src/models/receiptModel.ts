import pool from '../config/db';

export const createReceipt = async (
    userId: string,
    storeId: number,
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
        'SELECT * FROM Receipt WHERE id = ?',
        [id]
    );
    return rows[0] || null;
};

export const updateReceiptDetails = async (
    id: number,
    receiptNo: string,
    receiptDate: Date,
    processingStatus: string
) => {
    await pool.query(
        'UPDATE Receipt SET receiptNo = ?, receiptDate = ?, processingStatus = ? WHERE id = ?',
        [receiptNo, receiptDate, processingStatus, id]
    );
};

export const deleteReceipt = async (id: number) => {
    await pool.query('DELETE FROM Receipt WHERE id = ?', [id]);
};
