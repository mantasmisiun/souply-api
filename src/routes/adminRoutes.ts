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

export default router;
