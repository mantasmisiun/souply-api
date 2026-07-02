import { Router } from 'express';
import {
    postTemplateCover,
    fetchTemplateCoverSignedUrl,
} from '../controllers/templateCoverController.js';
import { requireUser } from '../middleware/sessionAuth.js';

const router = Router();

/**
 * Upload routes. Currently scoped to the template-cover flow; widen
 * the prefix once we add more upload surfaces (basket-instance
 * stickers, creator-profile banners, etc).
 *
 *   POST /api/uploads/template-cover
 *     Body: { imageBase64: string, mimeType?: string, userId?: string }
 *     200:  { storageKey, url, expiresAt }
 *
 *   GET /api/uploads/template-cover/signed-url?key=template-covers/...
 *     200:  { storageKey, url, expiresAt }
 */
// Cover upload is namespaced by the CALLER's id (template-covers/{authUserId}/…) —
// identity from the token, not a body userId. signed-url stays open (prefix-guarded,
// covers render on public template pages).
router.post('/uploads/template-cover', requireUser, postTemplateCover);
router.get('/uploads/template-cover/signed-url', fetchTemplateCoverSignedUrl);

export default router;
