import { Request, Response, NextFunction } from "express";
import { createReceipt, getReceiptsByUserId, getReceiptById, updateReceiptDetails, deleteReceipt } from "../models/receiptModel";

export const addReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userId, storeId, filePath, fileType } = req.body;
        if (!userId || !storeId || !filePath || !fileType) {
            res.status(400).json({ error: 'All fields are required' });
            return;
        }
        const id = await createReceipt(userId, storeId, filePath, fileType);
        res.status(201).json({ id, userId, storeId, filePath, fileType });
    } catch (error) {
        next(error);
    }
};

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

export const updateReceiptOcrDetails = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { receiptNo, receiptDate, processingStatus } = req.body;
        if (isNaN(id) || !receiptNo || !receiptDate || !processingStatus) {
            res.status(400).json({ error: 'Invalid ID or missing fields' });
            return;
        }
        const validStatuses = ['pending', 'processing', 'completed', 'failed'];
        if (!validStatuses.includes(processingStatus)) {
            res.status(400).json({ error: 'Status must be pending, processing, completed or failed' });
            return;
        }
        await updateReceiptDetails(id, receiptNo, new Date(receiptDate), processingStatus);
        res.json({ id, receiptNo, receiptDate, processingStatus });
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
        const { getPresignedUrl } = await import('../services/storageService');
        const url = await getPresignedUrl(receipt.filePath);
        res.json({ url });
    } catch (error) {
        next(error);
    }
};