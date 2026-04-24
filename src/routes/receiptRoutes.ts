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
    fetchReceiptSwipeQueue,
    convertPdfToImage,
    reportReceiptLineIssue,
} from '../controllers/receiptController.js';
import {
    logBatchReceipt,
    finalizeBatchReport,
} from '../controllers/receiptBatchLogController.js';

const router = Router();

// Dev-only: the phone's Menu → "Kvitų paketinis testas" flow POSTs one
// receipt at a time to /batch-log and a finalize call at the end.
// Guarded only by the non-prod nature of the caller (dev build with
// __DEV__=true renders the Menu tab); no auth middleware because the
// dev API is LAN-only anyway.
router.post('/receipts/batch-log', logBatchReceipt);
router.post('/receipts/batch-log/finalize', finalizeBatchReport);

// Create a new receipt from OCR results — called once on receipt-process screen mount
router.post('/receipts', createReceiptFromOcr);

// Update an existing receipt after user edits (debounced auto-save)
router.put('/receipts/:id', updateReceiptFromOcr);

// Upload helpers
router.post('/receipts/upload-url', getReceiptUploadUrl);
router.patch('/receipts/:id/file-path', setReceiptFilePath);
router.post('/receipts/pdf-to-image', convertPdfToImage);

router.get('/users/:userId/receipts', fetchReceiptsByUserId);
router.get('/receipts/:id', fetchReceiptById);
router.get('/receipts/:id/image', fetchReceiptImage);
router.get('/receipts/:id/comparison', fetchReceiptComparison);
router.get('/receipts/:id/swipe-queue', fetchReceiptSwipeQueue);
router.post('/receipts/:id/lines/:idx/report-issue', reportReceiptLineIssue);

export default router;