import { Request, Response, NextFunction } from 'express';
import sharp from 'sharp';
import pool from '../config/db.js';
import { getPresignedUrl } from '../services/storageService.js';

/**
 * On-demand crop of a flagged receipt line.
 *
 * The Flags tab shows admins a cropped image of the specific line the
 * user complained about — much faster than asking them to scrub the
 * full receipt. The endpoint:
 *   1. Looks up the receipt's MinIO `filePath` and `parsedData.products[lineIdx].region`.
 *   2. Fetches the JPEG from MinIO.
 *   3. Crops to the line region with ~30% vertical padding so the
 *      admin can see the row above + below for context.
 *   4. Streams the JPEG bytes back inline.
 *
 * No caching for v1 — each flag is typically reviewed once. If the
 * Flags tab gets heavy traffic later, switch to writing the crop to a
 * deterministic MinIO key and serving via the public-CDN bucket.
 *
 * Multi-page receipts (PDFs converted to N PNGs) are out of v1 scope.
 * Most uploads are single-image phone photos; the rare multi-page
 * receipt falls through with a 422 so the client can degrade
 * gracefully to "no preview available".
 */

const VERTICAL_PADDING_PCT = 0.3;

export const getFlaggedReceiptCrop = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const receiptId = Number(req.params.receiptId);
        const lineIdx = Number(req.params.lineIdx);
        if (!Number.isFinite(receiptId) || !Number.isFinite(lineIdx)) {
            res.status(400).json({ error: 'receiptId and lineIdx must be numbers' });
            return;
        }

        const [rows]: any = await pool.query(
            `SELECT filePath, fileType,
                    JSON_EXTRACT(parsedData, ?) AS regionJson
               FROM Receipt
              WHERE id = ?
              LIMIT 1`,
            [`$.products[${lineIdx}].region`, receiptId],
        );
        if (!rows[0]) {
            res.status(404).json({ error: 'receipt not found' });
            return;
        }
        const { filePath, fileType } = rows[0];
        const regionRaw = rows[0].regionJson;
        if (!filePath || !regionRaw) {
            res.status(404).json({ error: 'no region data for that line' });
            return;
        }
        const region = typeof regionRaw === 'string' ? JSON.parse(regionRaw) : regionRaw;
        if (!region || typeof region.yTop !== 'number' || typeof region.yBottom !== 'number') {
            res.status(422).json({ error: 'malformed region' });
            return;
        }

        // PDFs and multi-page receipts aren't supported in v1. The
        // parsedData region coordinates assume a single image; a PDF
        // would need per-page logic. Bail with 422 so the client can
        // hide the preview gracefully.
        if (typeof fileType === 'string' && fileType.includes('pdf')) {
            res.status(422).json({ error: 'multi-page crop not supported' });
            return;
        }

        // The Receipt.filePath is a bare MinIO URL — the `receipts`
        // bucket is private (presigned reads only), so a raw fetch
        // returns 403. Presign first; reuse the same helper the
        // receipts route uses.
        let signedUrl: string;
        try {
            signedUrl = await getPresignedUrl(filePath);
        } catch (e: any) {
            console.warn(
                '[adminReceiptCrop] presign failed',
                { receiptId, filePath, err: e?.message },
            );
            res.status(502).json({ error: `receipt presign: ${e?.message ?? 'unknown'}` });
            return;
        }

        const imgRes = await fetch(signedUrl);
        if (!imgRes.ok) {
            const bodyText = await imgRes.text().catch(() => '');
            console.warn(
                '[adminReceiptCrop] minio fetch failed',
                { receiptId, status: imgRes.status, body: bodyText.slice(0, 200) },
            );
            res.status(502).json({
                error: `receipt image fetch ${imgRes.status}`,
            });
            return;
        }
        const buffer = Buffer.from(await imgRes.arrayBuffer());

        // Read the image dimensions so we can clamp the crop and add
        // vertical padding without overshooting. Sharp's `metadata()`
        // is lazy — only reads the JPEG header, microseconds.
        const meta = await sharp(buffer).metadata();
        const imgHeight = meta.height ?? 0;
        const imgWidth = meta.width ?? 0;
        if (imgHeight === 0 || imgWidth === 0) {
            res.status(422).json({ error: 'image has no dimensions' });
            return;
        }

        const yTop = Math.max(0, Math.min(imgHeight, Math.floor(region.yTop)));
        const yBottom = Math.max(0, Math.min(imgHeight, Math.ceil(region.yBottom)));
        const lineHeight = Math.max(1, yBottom - yTop);
        const pad = Math.floor(lineHeight * VERTICAL_PADDING_PCT);
        const cropTop = Math.max(0, yTop - pad);
        const cropBottom = Math.min(imgHeight, yBottom + pad);
        const cropHeight = Math.max(1, cropBottom - cropTop);

        const out = await sharp(buffer)
            .extract({
                left: 0,
                top: cropTop,
                // Full receipt width — admin gets context (price column
                // visible alongside the product name). Per-column
                // cropping by xLeft/xRight would chop off the price.
                width: imgWidth,
                height: cropHeight,
            })
            .jpeg({ quality: 80 })
            .toBuffer();

        // Small 5-min cache header — admins reviewing the same flag in
        // succession reuse the result without re-fetching from MinIO.
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(out);
    } catch (e) { next(e); }
};
