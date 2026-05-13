import { Router } from 'express';
import {
    fetchReceiptById,
    fetchReceiptsByUserId,
    removeReceipt,
    fetchReceiptImage,
    createReceiptFromOcr,
    updateReceiptFromOcr,
    updateReceiptRegions,
    getReceiptUploadUrl,
    setReceiptFilePath,
    fetchReceiptComparison,
    fetchReceiptSwipeQueue,
    convertPdfToImage,
    reportReceiptLineIssue,
    logAnalizeFailure,
    markSwipesDone,
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

// Analize-flow bail path: log a receipt that couldn't be processed
// (OCR produced nothing, chain not detected, or store lookup failed).
// No Receipt row created; this is pure audit logging.
router.post('/receipts/log-fail', logAnalizeFailure);

// Update an existing receipt after user edits (debounced auto-save)
router.put('/receipts/:id', updateReceiptFromOcr);

// Region-only rehydration: mobile re-OCRs a legacy receipt image to
// recover per-field bboxes and PATCHes them in. Never touches products/
// totals/etc., so user edits are preserved.
router.patch('/receipts/:id/regions', updateReceiptRegions);

// Upload helpers
router.post('/receipts/upload-url', getReceiptUploadUrl);
router.patch('/receipts/:id/file-path', setReceiptFilePath);
router.post('/receipts/pdf-to-image', convertPdfToImage);

router.get('/users/:userId/receipts', fetchReceiptsByUserId);
router.get('/receipts/:id', fetchReceiptById);
router.get('/receipts/:id/image', fetchReceiptImage);
router.get('/receipts/:id/comparison', fetchReceiptComparison);
router.get('/receipts/:id/swipe-queue', fetchReceiptSwipeQueue);
router.post('/receipts/:id/complete-swipes', markSwipesDone);
router.post('/receipts/:id/lines/:idx/report-issue', reportReceiptLineIssue);

export default router;