import { Request, Response, NextFunction } from "express";
import { createReceipt, getReceiptsByUserId, getReceiptById, deleteReceipt, getReceiptItemsWithDetails, updateReceiptFilePath, getReceiptByReceiptNoAndUser } from "../models/receiptModel.js";
import { getSwipeCandidatesWithDetails } from "../models/receiptSwipeCandidateModel.js";
import { getPresignedUrl } from "../services/storageService.js";
import { persistReceiptPrices } from '../services/receiptSaveService.js';
import { getReceiptComparison } from '../services/receiptComparisonService.js';

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
    } catch (error: any) {
        if (error?.statusCode === 404) {
            res.status(404).json({ error: error.message });
            return;
        }
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
        // Reject duplicates early so re-photographing the same receipt doesn't
        // create parallel records. IKI synthesizes a `{date}-{time}-{cents}-iki-receipt`
        // number specifically so this check works when the receipt format has no
        // natural unique ID.
        const candidateReceiptNo = parsedData.footer?.receiptNo ?? null;
        if (candidateReceiptNo) {
            const existing = await getReceiptByReceiptNoAndUser(candidateReceiptNo, String(userId));
            if (existing) {
                res.status(409).json({
                    error: 'duplicate',
                    message: 'Receipt already uploaded',
                    existingReceiptId: existing.id,
                });
                return;
            }
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
                priceVerified: !!p.priceVerified,
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
                priceVerified: !!p.priceVerified,
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
        const { getPresignedUploadUrl } = await import('../services/storageService.js');
        const { uploadUrl, filePath } = await getPresignedUploadUrl(filename, mimeType || 'image/jpeg');
        res.json({ uploadUrl, filePath });
    } catch (error) {
        next(error);
    }
};

/**
 * Convert a PDF (base64) to one JPEG per page (each base64) — used by the
 * mobile app when the user uploads a downloaded Rimi/Maxima receipt PDF.
 * The client OCRs each page separately and merges the line lists.
 *
 * Returning per-page images instead of a stitched one: ML Kit accuracy
 * drops sharply on very large images, and Android's Image decoder may
 * downsample-scramble giant stitched receipts. Per-page avoids both.
 *
 * Body:     { pdfBase64: string }
 * Response: { images: string[] (base64 JPEGs, one per page), mimeType: 'image/jpeg' }
 */
export const convertPdfToImage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { pdfBase64 } = req.body;
        if (!pdfBase64 || typeof pdfBase64 !== 'string') {
            res.status(400).json({ error: 'pdfBase64 is required' });
            return;
        }
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
        if (pdfBuffer.length === 0) {
            res.status(400).json({ error: 'pdfBase64 decoded to an empty buffer' });
            return;
        }
        const { convertPdfBufferToJpegPages } = await import('../services/pdfService.js');
        const pages = await convertPdfBufferToJpegPages(pdfBuffer);
        res.json({
            images: pages.map((b) => b.toString('base64')),
            mimeType: 'image/jpeg',
        });
    } catch (error: any) {
        console.error('PDF → JPEG conversion failed:', error?.message ?? error);
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

/**
 * Build the swipe queue for a receipt: for each line that has at least one
 * candidate, pair the OCR-side info (pulled from parsedData) with the matcher
 * candidates (joined with StoreProduct + StoreChain). Items are ordered by
 * ascending top-candidate matchScore so the user sees the lowest-confidence
 * pairs first — that's where their judgement matters most.
 */
export const fetchReceiptSwipeQueue = async (req: Request, res: Response, next: NextFunction) => {
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

        const parsedData =
            typeof receipt.parsedData === 'string'
                ? JSON.parse(receipt.parsedData)
                : receipt.parsedData;
        const parsedProducts: any[] = Array.isArray(parsedData?.products)
            ? parsedData.products
            : [];

        const flat = await getSwipeCandidatesWithDetails(id);

        // Group flat rows by receiptLineIdx; build the response item shape.
        const byLine = new Map<number, any>();
        for (const r of flat) {
            if (!byLine.has(r.receiptLineIdx)) {
                const line = parsedProducts[r.receiptLineIdx] ?? {};
                byLine.set(r.receiptLineIdx, {
                    receiptLineIdx: r.receiptLineIdx,
                    ocrName: line.name ?? null,
                    ocrAmount: line.amount ?? null,
                    ocrUnit: line.unit ?? null,
                    ocrPrice: line.price ?? null,
                    ocrPromoPrice: line.promoPrice ?? null,
                    lineStoreProductId: Number.isFinite(line.storeProductId)
                        ? Number(line.storeProductId)
                        : null,
                    candidates: [],
                });
            }
            byLine.get(r.receiptLineIdx).candidates.push({
                rankPos: r.rankPos,
                storeProductId: r.storeProductId,
                name: r.name,
                brandName: r.brandName,
                amount: r.amount,
                unit: r.unit,
                isWeighable: !!r.isWeighable,
                imageUrl: r.imageUrl,
                productId: r.productId,
                chainId: r.chainId,
                chainName: r.chainName,
                chainLogoUrl: r.chainLogoUrl,
                matchScore: Number(r.matchScore),
                autoMatched: !!r.autoMatched,
            });
        }

        const items = Array.from(byLine.values()).sort((a, b) => {
            const aTop = a.candidates[0]?.matchScore ?? 0;
            const bTop = b.candidates[0]?.matchScore ?? 0;
            return aTop - bTop; // ascending: lowest-confidence first
        });

        res.json({ receiptId: id, items });
    } catch (error) {
        next(error);
    }
};
