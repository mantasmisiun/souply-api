import { Request, Response, NextFunction } from "express";
import { createReceipt, getReceiptsByUserId, getReceiptById, updateReceiptStatus, deleteReceipt } from "../models/receiptModel";

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

export const updateReceipt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        const { processingStatus } = req.body;
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const validStatuses = ['pending', 'processing', 'completed', 'failed'];
        if (!processingStatus || !validStatuses.includes(processingStatus)) {
            res.status(400).json({ error: 'Status must be pending, processing, completed or failed' });
            return;
        }
        const receipt = await getReceiptById(id);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }
        await updateReceiptStatus(id, processingStatus);
        res.json({ id, processingStatus });
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