import { Request, Response, NextFunction } from "express";
import { createReceipt, getReceiptsByUserId, getReceiptById, deleteReceipt, getReceiptItemsWithDetails, updateReceiptFilePath } from "../models/receiptModel";
import { getPresignedUrl } from "../services/storageService";
import { persistReceiptPrices } from '../services/receiptSaveService';
import { getReceiptComparison } from '../services/receiptComparisonService';

export const fetchReceiptsByUserId = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = String(req.params.userId);
        const receipts = await getReceiptsByUserId(userId);
        res.json(receipts);
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        res.json(receipt);
    } catch (error) {
        next(error);
    }
};

export const removeReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        await deleteReceipt(id);
        res.status(204).send();
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptImage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        const url = await getPresignedUrl(receipt.filePath);
        res.json({ url });
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptItems = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const items = await getReceiptItemsWithDetails(id);
        res.json(items);
    } catch (error) {
        next(error);
    }
};

/**
 * Create a receipt record and persist its parsed prices.
 * Called once when receipt-process screen first completes OCR+matching.
 * Returns the new receipt ID.
 */
export const createReceiptFromOcr = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId, filePath, fileType, parsedData } = req.body;
        if (!userId || !parsedData) {
            res.status(400).json({ error: 'userId and parsedData are required' });
            return;
        }
        // Receipt.storeId is resolved from parsedData later; initial insert can use null
        const storeId = parsedData.header?.storeId ?? null;
        const receiptId = await createReceipt(userId, storeId, filePath || '', fileType || 'image/jpeg');

        const result = await persistReceiptPrices(receiptId, userId, parsedData, {
            chainId: parsedData.header?.chainId,
            storeId,
            receiptNo: parsedData.footer?.receiptNo ?? null,
            date: parsedData.footer?.date ?? null,
            products: (parsedData.products || []).map((p: any) => ({
                storeProductId: p.storeProductId ?? null,
                matchConfirmed: !!p.matchConfirmed,
                price: p.price,
                promoPrice: p.promoPrice,
                quantity: p.quantity,
                unit: p.unit,
            })),
        });

        res.status(201).json({ id: receiptId, ...result });
    } catch (error) {
        next(error);
    }
};

/**
 * Update an existing receipt with edited parsedData.
 * New Price rows added for changed products (dedup'd, clearance-filtered).
 * Existing prices are not deleted — historical edits stay as price history.
 */
export const updateReceiptFromOcr = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { userId, parsedData } = req.body;
        if (isNaN(id) || !userId || !parsedData) {
            res.status(400).json({ error: 'Invalid id or missing userId/parsedData' });
            return;
        }

        const result = await persistReceiptPrices(id, userId, parsedData, {
            chainId: parsedData.header?.chainId,
            storeId: parsedData.header?.storeId ?? null,
            receiptNo: parsedData.footer?.receiptNo ?? null,
            date: parsedData.footer?.date ?? null,
            products: (parsedData.products || []).map((p: any) => ({
                storeProductId: p.storeProductId ?? null,
                matchConfirmed: !!p.matchConfirmed,
                price: p.price,
                promoPrice: p.promoPrice,
                quantity: p.quantity,
                unit: p.unit,
            })),
        });

        res.json({ id, ...result });
    } catch (error) {
        next(error);
    }
};

/**
 * Mobile-side MinIO upload helper: returns a presigned PUT URL.
 * Body: { filename, mimeType }
 * Response: { uploadUrl, filePath (what to store on Receipt.filePath) }
 */
export const getReceiptUploadUrl = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { filename, mimeType } = req.body;
        if (!filename) {
            res.status(400).json({ error: 'filename is required' });
            return;
        }
        const { getPresignedUploadUrl } = await import('../services/storageService');
        const { uploadUrl, filePath } = await getPresignedUploadUrl(filename, mimeType || 'image/jpeg');
        res.json({ uploadUrl, filePath });
    } catch (error) {
        next(error);
    }
};

 //Set Receipt.filePath after mobile finishes MinIO upload.
export const setReceiptFilePath = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { filePath } = req.body;
        if (isNaN(id) || !filePath) {
            res.status(400).json({ error: 'Invalid id or missing filePath' });
            return;
        }
        await updateReceiptFilePath(id, filePath);
        res.json({ id, filePath });
    } catch (error) {
        next(error);
    }
};

export const fetchReceiptComparison = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }

        const comparison = await getReceiptComparison(id);
        res.json(comparison);
    } catch (error: any) {
        if (error?.statusCode === 404) {
            res.status(404).json({ error: error.message });
            return;
        }
        if (error?.statusCode === 400) {
            res.status(400).json({ error: error.message });
            return;
        }
        next(error);
    }
};