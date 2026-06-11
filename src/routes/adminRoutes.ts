import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { adminRateLimit } from '../middleware/adminRateLimit.js';
import { deleteUserAccount } from '../controllers/adminController.js';
import { getFailedReceiptsQueue, resolveFailedReceipt } from '../controllers/adminFailedReceiptsController.js';
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
import { getFlaggedReceiptCrop, getAmountReceiptCrop } from '../controllers/adminReceiptCropController.js';
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
    getCategorySuggestions,
} from '../controllers/adminUncategorisedController.js';
import {
    getSourceReceipt,
    applySplit,
} from '../controllers/adminReceiptSplitController.js';
import { mergeProductsHandler, moveProductsHandler, renameProductHandler } from '../controllers/adminCatalogController.js';
import {
    getAdminProductDetail,
    deleteAdminStoreProduct,
    editAdminStoreProduct,
    moveAdminStoreProduct,
} from '../controllers/adminStoreProductController.js';
import { getQueueCounts } from '../controllers/adminQueueController.js';
import {
    getAdminReceiptList,
    getAdminReceipt,
    patchReceiptDate,
    patchProductName,
    postConfirmMatch,
    patchProductUnit,
    patchProductAmount,
    patchProductQuantity,
    postDenyMatch,
} from '../controllers/adminReceiptsController.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';

const router = Router();

// Unified queue counts — badge numbers for filter chips in the Eilė tab.
router.get('/admin/queue/counts', requireAdmin, getQueueCounts);

// Failed-receipts queue (unprocessable uploads). Reads = requireAdmin; the
// resolve write also passes adminRateLimit.
router.get('/admin/failed-receipts', requireAdmin, getFailedReceiptsQueue);
router.post('/admin/failed-receipts/:id/resolve', requireAdmin, adminRateLimit, resolveFailedReceipt);

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
router.get('/admin/amounts/:spId/receipt-crop', requireAdmin, getAmountReceiptCrop);

// Catalog tab — superadmin-only product operations.
// requireAdmin gates the outer shell; handlers enforce superadmin role internally.
// Static segments (/search, /merge, /move) must come before /:id so Express
// doesn't greedily match them as the dynamic param.
router.get('/admin/products/search', requireAdmin, adminProductSearch);
router.get('/admin/categories/search', requireAdmin, adminCategorySearch);
router.post('/admin/products/merge', requireAdmin, adminRateLimit, mergeProductsHandler);
router.post('/admin/products/move', requireAdmin, adminRateLimit, moveProductsHandler);
router.get('/admin/products/:id', requireAdmin, getAdminProductDetail);
router.patch('/admin/products/:id/name', requireAdmin, adminRateLimit, renameProductHandler);
router.delete('/admin/store-products/:spId', requireAdmin, adminRateLimit, deleteAdminStoreProduct);
router.patch('/admin/store-products/:spId', requireAdmin, adminRateLimit, editAdminStoreProduct);
router.post('/admin/store-products/:spId/move', requireAdmin, adminRateLimit, moveAdminStoreProduct);

// Uncategorised tab — DB rescue queue for Products that fall outside
// both user-driven (Žymos) and heuristic-driven (Nuotraukos / Kiekiai).
router.get('/admin/uncategorised/queue', requireAdmin, getUncategorisedQueue);
router.post('/admin/uncategorised/claim-batch', requireAdmin, claimUncategorisedBatch);
router.post('/admin/uncategorised/release-batch', requireAdmin, releaseUncategorisedBatch);
router.post('/admin/uncategorised/:productId/confirm', requireAdmin, adminRateLimit, confirmUncategorisedProduct);
router.post('/admin/uncategorised/:productId/delete', requireAdmin, adminRateLimit, deleteUncategorisedProduct);
router.post('/admin/uncategorised/:productId/skip', requireAdmin, adminRateLimit, skipUncategorisedProduct);
router.get('/admin/uncategorised/:productId/category-suggestions', requireAdmin, getCategorySuggestions);
router.get('/admin/uncategorised/:productId/source-receipt', requireAdmin, getSourceReceipt);
router.post('/admin/uncategorised/:productId/split', requireAdmin, adminRateLimit, applySplit);

// Receipts tab — superadmin only.
router.get('/admin/receipts', requireSuperAdmin, getAdminReceiptList);
router.get('/admin/receipts/:id', requireSuperAdmin, getAdminReceipt);
router.patch('/admin/receipts/:id/date', requireSuperAdmin, adminRateLimit, patchReceiptDate);
router.patch('/admin/receipts/:id/products/:index/name', requireSuperAdmin, adminRateLimit, patchProductName);
router.post('/admin/receipts/:id/products/:index/confirm-match', requireSuperAdmin, adminRateLimit, postConfirmMatch);
router.patch('/admin/receipts/:id/products/:index/unit', requireSuperAdmin, adminRateLimit, patchProductUnit);
router.patch('/admin/receipts/:id/products/:index/amount', requireSuperAdmin, adminRateLimit, patchProductAmount);
router.patch('/admin/receipts/:id/products/:index/quantity', requireSuperAdmin, adminRateLimit, patchProductQuantity);
router.post('/admin/receipts/:id/products/:index/deny-match', requireSuperAdmin, adminRateLimit, postDenyMatch);

export default router;
