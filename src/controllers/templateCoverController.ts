import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import sharp from 'sharp';
import {
    uploadTemplateCover,
    getTemplateCoverSignedUrl,
} from '../services/storageService.js';

/**
 * Template cover-image upload + signed-URL refresh.
 *
 * Souply-web posts a base64-encoded image; we re-encode through sharp
 * to a 512×512 JPEG, strip EXIF, and store it under
 *   template-covers/{userId}/{uuid}.jpg
 * Returns a presigned 7-day GET URL the client can show immediately.
 *
 * Why base64 in JSON instead of multipart:
 *   - Matches the existing /api/users/me/avatar pattern so we don't
 *     have to thread multer through index.ts just for this route.
 *   - souply-web's processCoverImage() already produces a Blob; the
 *     client just reads it as a base64 string before POSTing.
 *
 * Auth: dev-mode accepts an explicit `userId` in the body because the
 * web doesn't yet have a real JWT pipeline. When the OAuth flow lands,
 * swap this for `requireVerifiedUser` middleware + drop the body
 * `userId` (use `req.verifiedUser!.id`).
 */

const MAX_BYTES_IN  = 6 * 1024 * 1024;  // 6 MB ceiling on the raw base64 payload
const TARGET_PX     = 512;
const JPEG_QUALITY  = 88;

export const postTemplateCover = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { imageBase64 } = req.body ?? {};
        // Identity from the session token (requireUser sets authUserId from a Bearer/cookie,
        // or the non-prod dev-header shim). The old body userId is ignored — it let anyone
        // upload into another user's cover namespace.
        const userId = req.authUserId ?? (req.verifiedUser?.id ? String(req.verifiedUser.id) : '');
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
            res.status(400).json({ error: 'image-required' });
            return;
        }
        // Strip optional data-URL prefix so the client can send either
        // `data:image/jpeg;base64,...` or a raw base64 string.
        const cleanB64 = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
        const inputBuf = Buffer.from(cleanB64, 'base64');
        if (inputBuf.length === 0) {
            res.status(400).json({ error: 'image-decode-failed' });
            return;
        }
        if (inputBuf.length > MAX_BYTES_IN) {
            res.status(413).json({ error: 'too-large' });
            return;
        }

        // Server-side re-encode: defends against client-side fakes
        // (corrupt EXIF, malformed PNGs, unexpected dimensions). Even
        // though souply-web already crops to 512² JPEG, we don't trust
        // it — sharp() rotates per EXIF, strips metadata, and re-emits
        // a clean stream. cover-fit guarantees 1:1 even if a caller
        // ever sends a non-square buffer.
        const processed = await sharp(inputBuf)
            .rotate()
            .resize(TARGET_PX, TARGET_PX, { fit: 'cover' })
            .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
            .toBuffer();

        const storageKey = `template-covers/${userId}/${crypto.randomUUID()}.jpg`;
        const uploaded = await uploadTemplateCover(userId, storageKey, processed, 'image/jpeg');
        res.json(uploaded);
    } catch (e) { next(e); }
};

export const fetchTemplateCoverSignedUrl = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const key = String(req.query.key ?? '').trim();
        if (!key) {
            res.status(400).json({ error: 'key-required' });
            return;
        }
        // Defense against a caller asking us to sign a key in a
        // sibling bucket (e.g. receipts/...) by accident or worse.
        if (!key.startsWith('template-covers/')) {
            res.status(400).json({ error: 'bad-key-prefix' });
            return;
        }
        const result = await getTemplateCoverSignedUrl(key);
        res.json(result);
    } catch (e) { next(e); }
};
