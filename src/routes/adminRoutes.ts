import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { adminRateLimit } from '../middleware/adminRateLimit.js';
import { deleteUserAccount } from '../controllers/adminController.js';
import {
    getImageQueue,
    claimImageBatch,
    releaseImageBatch,
    adoptCandidate,
    removeImage,
    skipImageCard,
    rejectPendingUpload,
    resolveReceiptLineIssue,
    revertImageChange,
    getAuditLog,
} from '../controllers/adminImageController.js';
import {
    getAmountQueue,
    claimAmountBatch,
    releaseAmountBatch,
    confirmAmount,
    skipAmountCard,
} from '../controllers/adminAmountController.js';
import {
    getFlagQueue,
    claimFlagBatch,
    releaseFlagBatch,
    confirmFlag,
    dismissFlag,
    skipFlagCard,
} from '../controllers/adminFlagController.js';
import { getFlaggedReceiptCrop } from '../controllers/adminReceiptCropController.js';
import {
    adminProductSearch,
    adminCategorySearch,
} from '../controllers/adminSearchController.js';
import {
    getUncategorisedQueue,
    claimUncategorisedBatch,
    releaseUncategorisedBatch,
    confirmUncategorisedProduct,
    deleteUncategorisedProduct,
    skipUncategorisedProduct,
} from '../controllers/adminUncategorisedController.js';

const router = Router();

// Existing — user deletion. requireAdmin only; no audit/rate-limit because
// the action goes through a dedicated service with its own logging.
router.delete('/admin/users/:id', requireAdmin, deleteUserAccount);

// Image tab — reads use requireAdmin only; writes also pass adminRateLimit.
router.get('/admin/images/queue', requireAdmin, getImageQueue);
// Claim/release are reads from a rate-limit POV (they don't write audit
// rows; lease rows are separate accounting). Letting an admin reclaim
// every couple of minutes is normal usage.
router.post('/admin/images/claim-batch', requireAdmin, claimImageBatch);
router.post('/admin/images/release-batch', requireAdmin, releaseImageBatch);
router.post('/admin/images/:spId/adopt-candidate', requireAdmin, adminRateLimit, adoptCandidate);
router.post('/admin/images/:spId/remove', requireAdmin, adminRateLimit, removeImage);
router.post('/admin/images/:spId/skip', requireAdmin, adminRateLimit, skipImageCard);
router.post('/admin/images/:spId/reject-pending', requireAdmin, adminRateLimit, rejectPendingUpload);
router.post('/admin/images/revert/:auditId', requireAdmin, adminRateLimit, revertImageChange);
router.post('/admin/issues/resolve', requireAdmin, adminRateLimit, resolveReceiptLineIssue);
router.get('/admin/audit', requireAdmin, getAuditLog);

// Amounts tab — same chassis as images.
router.get('/admin/amounts/queue', requireAdmin, getAmountQueue);
router.post('/admin/amounts/claim-batch', requireAdmin, claimAmountBatch);
router.post('/admin/amounts/release-batch', requireAdmin, releaseAmountBatch);
router.post('/admin/amounts/:spId/confirm', requireAdmin, adminRateLimit, confirmAmount);
router.post('/admin/amounts/:spId/skip', requireAdmin, adminRateLimit, skipAmountCard);

// Flags tab — unified inbox for ReceiptLineIssue rows. Same chassis;
// :flagKey is `${receiptId}-${lineIdx}` instead of a bare spId.
router.get('/admin/flags/queue', requireAdmin, getFlagQueue);
router.post('/admin/flags/claim-batch', requireAdmin, claimFlagBatch);
router.post('/admin/flags/release-batch', requireAdmin, releaseFlagBatch);
router.post('/admin/flags/:flagKey/confirm', requireAdmin, adminRateLimit, confirmFlag);
router.post('/admin/flags/:flagKey/dismiss', requireAdmin, adminRateLimit, dismissFlag);
router.post('/admin/flags/:flagKey/skip', requireAdmin, adminRateLimit, skipFlagCard);
// Receipt-line crop image — served on demand. Not rate-limited; pure
// read, and a single card review can fire multiple if the admin re-pans.
router.get('/admin/flags/receipts/:receiptId/:lineIdx/crop', requireAdmin, getFlaggedReceiptCrop);

// Type-ahead pickers used by the Flags-tab card (re-link to a
// different Product, re-categorise). Both are pure reads.
router.get('/admin/products/search', requireAdmin, adminProductSearch);
router.get('/admin/categories/search', requireAdmin, adminCategorySearch);

// Uncategorised tab — DB rescue queue for Products that fall outside
// both user-driven (Žymos) and heuristic-driven (Nuotraukos / Kiekiai).
router.get('/admin/uncategorised/queue', requireAdmin, getUncategorisedQueue);
router.post('/admin/uncategorised/claim-batch', requireAdmin, claimUncategorisedBatch);
router.post('/admin/uncategorised/release-batch', requireAdmin, releaseUncategorisedBatch);
router.post('/admin/uncategorised/:productId/confirm', requireAdmin, adminRateLimit, confirmUncategorisedProduct);
router.post('/admin/uncategorised/:productId/delete', requireAdmin, adminRateLimit, deleteUncategorisedProduct);
router.post('/admin/uncategorised/:productId/skip', requireAdmin, adminRateLimit, skipUncategorisedProduct);

export default router;
