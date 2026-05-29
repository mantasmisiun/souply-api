import { Router } from 'express';
import {
    postTemplateCover,
    fetchTemplateCoverSignedUrl,
} from '../controllers/templateCoverController.js';

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
router.post('/uploads/template-cover', postTemplateCover);
router.get('/uploads/template-cover/signed-url', fetchTemplateCoverSignedUrl);

export default router;
