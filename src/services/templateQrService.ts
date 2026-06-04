/**
 * Branded share QR generation — Pass B remainder.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 4.1.
 *
 * Generates a 512×512 PNG: QR pattern + Souply logo composited in the
 * centre via `sharp`. The QR uses ECC level 'H' (~30 % redundancy) so
 * the centre logo doesn't break scannability — same trick every "logo
 * QR" library uses.
 *
 * Cached in MinIO under `template-qrs/{slug}.png`. Re-uploaded each
 * time the share endpoint runs because the slug is stable per template
 * but the bucket put is cheap and we want one canonical asset.
 */

import * as path from 'path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode';
import sharp from 'sharp';
import { uploadObject } from './storageService.js';

const QR_SIZE = 512;
const LOGO_RATIO = 0.22; // ~22% of total — well inside H-level ECC tolerance

/**
 * Pure: render a square PNG buffer for the given URL with the Souply
 * logo composited centre. Exported so tests can stub the upload step.
 */
export async function buildBrandedQrPng(url: string): Promise<Buffer> {
    // Step 1: render the bare QR code at our target size. The 'H' ECC
    // level reserves ~30 % of the modules for redundancy, which is
    // exactly what lets us punch a logo over the centre without
    // breaking scanning.
    const qrBuffer = await qrcode.toBuffer(url, {
        errorCorrectionLevel: 'H',
        type: 'png',
        margin: 1,
        width: QR_SIZE,
        color: { dark: '#1A1A1C', light: '#FFFFFF' },
    });

    // Step 2: load the bundled Souply mark. Same `assets/logo.png` that
    // the mobile app ships as its launcher icon — pink rounded square
    // with the "S" + sprigs. The icon already brings its own background
    // shape so we sit it directly on the QR with no halo / outline
    // ring (per UX request — the asset reads as its own brand chip).
    const logoSize = Math.round(QR_SIZE * LOGO_RATIO);
    // Resolve relative to THIS module, not process.cwd(): in prod the runtime
    // cwd is /app while the asset ships at /app/dist/souply-api/assets, so a
    // cwd-based path silently missed the logo and fell back to a bare QR. From
    // the compiled service dir (dist/souply-api/src/services) and the dev source
    // dir (src/services), the asset is two levels up under assets/.
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const logoPath = path.resolve(moduleDir, '../../assets/logo.png');
    let logo: Buffer;
    try {
        logo = await sharp(logoPath).resize(logoSize, logoSize, { fit: 'contain' }).png().toBuffer();
    } catch {
        // Asset missing in dev → return the bare QR rather than crashing.
        return qrBuffer;
    }

    // Step 3: composite the logo over the QR centre. ECC-H gives us
    // enough redundancy that the modules under the logo can be lost
    // without breaking scannability — confirmed against iOS Camera +
    // Google Lens.
    return sharp(qrBuffer)
        .composite([{ input: logo, gravity: 'center' }])
        .png()
        .toBuffer();
}

/**
 * Render + upload + return the public URL. Idempotent per slug —
 * subsequent calls overwrite the same object key.
 */
export async function generateAndStoreBrandedQr(slug: string, url: string): Promise<string> {
    const png = await buildBrandedQrPng(url);
    return uploadObject(`template-qrs/${slug}.png`, png, 'image/png');
}

/**
 * Render + upload + return BOTH the public URL (for the souply.lt landing
 * page's `<img>` tag) AND an inline data URI (for the in-app share sheet,
 * which would otherwise fall back to an unbranded client-rendered QR
 * whenever MinIO isn't reachable from the phone — common on LAN dev,
 * CDN warmup, or any spotty network). Branded bytes are the same in
 * both representations; the data URI is ~38 KB on the wire, which is
 * fine for a non-hot endpoint.
 */
export async function generateBrandedQrWithDataUri(
    slug: string,
    url: string,
): Promise<{ qrUrl: string | null; qrDataUrl: string }> {
    const png = await buildBrandedQrPng(url);
    const qrDataUrl = `data:image/png;base64,${png.toString('base64')}`;
    let qrUrl: string | null = null;
    try {
        qrUrl = await uploadObject(`template-qrs/${slug}.png`, png, 'image/png');
    } catch (e: any) {
        // Upload failure is non-fatal — the data URI guarantees the
        // client still shows the branded QR.
        console.warn('[templateQr] MinIO upload failed:', e?.message);
    }
    return { qrUrl, qrDataUrl };
}
