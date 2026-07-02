import { Router } from 'express';
import {
    fetchReceiptById,
    fetchReceiptsByUserId,
    removeReceipt,
    // ^ dev-only cascade purge; route below is gated server-side too.
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
    rejectReceiptLineMatch,
    submitReceiptLineVote,
    getReceiptResolveQueue,
    logAnalizeFailure,
    logReocrTelemetry,
    markSwipesDone,
} from '../controllers/receiptController.js';
import { getFlaggedReceiptCrop } from '../controllers/adminReceiptCropController.js';
import {
    logBatchReceipt,
    finalizeBatchReport,
} from '../controllers/receiptBatchLogController.js';
import { requireUser, requireSelfUserParam } from '../middleware/sessionAuth.js';
import { requireReceiptOwner } from '../middleware/requireReceiptOwner.js';
import { pdfConvertLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Every receipt is a per-user resource. `requireUser` proves the caller holds a valid
// session token (anonymous or verified) and sets req.authUserId; `owns` then binds each
// :id route to that subject so a bare sequential id can't read/tamper another user's
// receipt (the IDOR class the audit flagged). Identity ALWAYS comes from the token now —
// controllers no longer trust a userId in the body/params. See middleware/sessionAuth.ts.
const owns = requireReceiptOwner('id');

// Dev-only: the phone's Menu → "Kvitų paketinis testas" flow POSTs one
// receipt at a time to /batch-log and a finalize call at the end.
// Guarded only by the non-prod nature of the caller (dev build with
// __DEV__=true renders the Menu tab); no auth middleware because the
// dev API is LAN-only anyway.
router.post('/receipts/batch-log', logBatchReceipt);
router.post('/receipts/batch-log/finalize', finalizeBatchReport);

// Create a new receipt from OCR results — called once on receipt-process screen mount.
// The receipt is owned by the token subject (req.authUserId), NOT a body userId.
router.post('/receipts', requireUser, createReceiptFromOcr);

// Analize-flow bail path: log a receipt that couldn't be processed
// (OCR produced nothing, chain not detected, or store lookup failed).
// No Receipt row created; this is pure audit logging.
router.post('/receipts/log-fail', requireUser, logAnalizeFailure);

// On-device product re-OCR (Phase 1/2) outcome telemetry — fire-and-forget,
// no DB write, just a structured server log line for aggregate regression watch.
router.post('/receipts/reocr-telemetry', requireUser, logReocrTelemetry);

// Update an existing receipt after user edits (debounced auto-save)
router.put('/receipts/:id', requireUser, owns, updateReceiptFromOcr);

// Region-only rehydration: mobile re-OCRs a legacy receipt image to
// recover per-field bboxes and PATCHes them in. Never touches products/
// totals/etc., so user edits are preserved.
router.patch('/receipts/:id/regions', requireUser, owns, updateReceiptRegions);

// Upload helpers
router.post('/receipts/upload-url', requireUser, getReceiptUploadUrl);
router.patch('/receipts/:id/file-path', requireUser, owns, setReceiptFilePath);
router.post('/receipts/pdf-to-image', pdfConvertLimiter, requireUser, convertPdfToImage);

router.get('/users/:userId/receipts', requireUser, requireSelfUserParam, fetchReceiptsByUserId);
router.get('/receipts/:id', requireUser, owns, fetchReceiptById);
router.get('/receipts/:id/image', requireUser, owns, fetchReceiptImage);
router.get('/receipts/:id/comparison', requireUser, owns, fetchReceiptComparison);
router.get('/receipts/:id/swipe-queue', requireUser, owns, fetchReceiptSwipeQueue);
router.post('/receipts/:id/complete-swipes', requireUser, owns, markSwipesDone);
router.post('/receipts/:id/lines/:idx/report-issue', requireUser, owns, reportReceiptLineIssue);
router.post('/receipts/:id/lines/:idx/reject-match', requireUser, owns, rejectReceiptLineMatch);
router.post('/receipts/:id/lines/:idx/vote', requireUser, owns, submitReceiptLineVote);
// Mandatory post-scan resolve cards (Card B) + the band-crop they render (a
// non-admin reuse of the flagged-crop controller, which keys on receiptId/lineIdx).
router.get('/receipts/:id/resolve-queue', requireUser, owns, getReceiptResolveQueue);
router.get('/receipts/:receiptId/lines/:lineIdx/crop', requireUser, requireReceiptOwner('receiptId'), getFlaggedReceiptCrop);

// DEV-ONLY hard delete: receipt + its prices + orphan SPs/Products + MinIO
// image. The controller refuses when NODE_ENV==='production' (prod/staging).
// Still ownership-bound so the dev purge can only touch the caller's own receipts.
router.delete('/receipts/:id', requireUser, owns, removeReceipt);

export default router;