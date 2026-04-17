import { Request, Response, NextFunction } from "express";
import { createReceipt, getReceiptsByUserId, getReceiptById, updateReceiptDetails, deleteReceipt, getReceiptItemsWithDetails, updateReceiptParsedDataItem } from "../models/receiptModel";
import { updatePriceById, createPrice } from "../models/priceModel";
import { updateStoreProductName, createStoreProduct } from "../models/storeProductModel";
import { updateProductCategory, createProduct } from "../models/productModel";
import { getChainIdByStoreId } from "../models/storeModel";
import { getPresignedUrl } from "../services/storageService";

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
        const url = await getPresignedUrl(receipt.filePath);
        res.json({ url });
    } catch (error) {
        next(error);
    }
};

export const processReceiptManually = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = Number(req.params.id);
        if (isNaN(id)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }
        const { chainName, receiptNo, date, items, storeName, storeAddress } = req.body;
        const { processReceiptManual } = await import('../services/receiptProcessingService');
        const result = await processReceiptManual(id, { chainName, receiptNo, date, items, storeName, storeAddress });
        res.json({ message: 'Receipt processed successfully', result });
    } catch (error: any) {
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

export const updateReceiptItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        const priceId = Number(req.params.priceId);
        const { name, categoryId, price, promoPrice, oldName, storeProductId, isWeighable } = req.body;

        if (isNaN(receiptId) || isNaN(priceId)) {
            res.status(400).json({ error: 'Invalid IDs' });
            return;
        }

        await updatePriceById(priceId, price, promoPrice || null);
        await updateStoreProductName(storeProductId, name);
        await updateProductCategory(storeProductId, categoryId);
        await updateReceiptParsedDataItem(receiptId, oldName, name, categoryId, price, promoPrice || null);

        // Propagate fallback prices
        const receipt = await getReceiptById(receiptId);
        if (receipt?.storeId) {
            const chainId = await getChainIdByStoreId(receipt.storeId);
            if (chainId) {
                const { propagateFallbackPrices } = await import('../services/priceService');
                await propagateFallbackPrices(storeProductId, receipt.storeId, chainId, price, promoPrice || null, new Date());
            }
        }

        res.json({ message: 'Item updated successfully' });
    } catch (error) {
        next(error);
    }
};

export const addReceiptItem = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.id);
        if (isNaN(receiptId)) {
            res.status(400).json({ error: 'Invalid receipt ID' });
            return;
        }

        const { name, categoryId, price, promoPrice, brandName, isWeighable } = req.body;

        if (!name || !categoryId || !price) {
            res.status(400).json({ error: 'name, categoryId and price are required' });
            return;
        }

        const receipt = await getReceiptById(receiptId);
        if (!receipt) {
            res.status(404).json({ error: 'Receipt not found' });
            return;
        }

        const chainId = await getChainIdByStoreId(receipt.storeId);
        const productId = await createProduct(categoryId, null, name, null);
        const storeProductId = await createStoreProduct(productId, chainId, name, brandName || null, isWeighable || false, null, null);

        await createPrice(
            storeProductId,
            receipt.storeId,
            price,
            promoPrice || null,
            null,
            false,
            new Date(receipt.receiptDate || new Date()),
            true,
            receiptId
        );

        await updateReceiptParsedDataItem(receiptId, '', name, categoryId, price, promoPrice || null);

        res.status(201).json({ message: 'Item added successfully' });
    } catch (error) {
        next(error);
    }
};