import { Router } from 'express';
import {
    fetchReceiptById,
    fetchReceiptsByUserId,
    removeReceipt,
    fetchReceiptImage,
    createReceiptFromOcr,
    updateReceiptFromOcr,
    getReceiptUploadUrl,
    setReceiptFilePath,
    fetchReceiptComparison,
} from '../controllers/receiptController.js';

const router = Router();

// Create a new receipt from OCR results — called once on receipt-process screen mount
router.post('/receipts', createReceiptFromOcr);

// Update an existing receipt after user edits (debounced auto-save)
router.put('/receipts/:id', updateReceiptFromOcr);

// Upload helpers
router.post('/receipts/upload-url', getReceiptUploadUrl);
router.patch('/receipts/:id/file-path', setReceiptFilePath);

router.get('/users/:userId/receipts', fetchReceiptsByUserId);
router.get('/receipts/:id', fetchReceiptById);
router.get('/receipts/:id/image', fetchReceiptImage);
router.get('/receipts/:id/comparison', fetchReceiptComparison);

export default router;