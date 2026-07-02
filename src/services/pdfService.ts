import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Convert every page of a PDF buffer to a PNG buffer. Returns one
 * entry per page in page order. The client OCRs each page separately
 * and merges the resulting line lists — stitching into a single giant
 * image tanks ML Kit accuracy on large receipts.
 *
 * Uses `pdftoppm` (poppler-utils), the same rasterizer the dev-time
 * batch staging script uses. Keeping the rasterizer identical means
 * a receipt that parses correctly in Kvitų paketinis testas parses
 * identically when the user uploads its PDF through analize. PNG
 * (lossless) preserves text edges better than JPEG for the high-
 * contrast, low-pixel-budget price-row glyphs OCR cares about most.
 *
 * Density 200 dpi matches `stageReceiptsOnDevice.ts` so the output
 * pixel sizes line up with what the parser was tuned against.
 *
 * Server prerequisite: poppler-utils installed (`apt install
 * poppler-utils` on Debian/Ubuntu, equivalent on the deployment
 * container).
 */
/**
 * Resource caps against a crafted-PDF DoS (event-loop freeze / OOM) on the
 * unauthenticated-enumerable convert endpoint:
 *   - MAX_PAGES: a receipt PDF is 1–3 pages; reject page-bombs.
 *   - MAX_PAGE_PT: PDF MediaBox tops out at 14400pt (200in); at 200dpi that's
 *     ~40000px/side → gigapixel raster. Cap at a generous receipt bound (~28in).
 *   - SPAWN_TIMEOUT_MS + maxBuffer: pdfinfo/pdftoppm are BLOCKING (spawnSync),
 *     so a pathological input would freeze the single Node event loop without these.
 */
const MAX_PAGES = 12;
const MAX_PAGE_PT = 2100;
const SPAWN_TIMEOUT_MS = 20_000;
const SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

export class PdfTooLargeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PdfTooLargeError';
    }
}

export const convertPdfBufferToImagePages = async (
    pdfBuffer: Buffer,
    opts: { density?: number } = {}
): Promise<Buffer[]> => {
    const density = opts.density ?? 200;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-rasterize-'));
    const tmpPdf = path.join(tmpDir, 'input.pdf');
    const outPrefix = path.join(tmpDir, 'p');
    const spawnOpts = { encoding: 'utf8' as const, timeout: SPAWN_TIMEOUT_MS, maxBuffer: SPAWN_MAX_BUFFER };

    try {
        await fs.writeFile(tmpPdf, pdfBuffer);

        // Need page count up front — pdftoppm uses different output
        // filename conventions for single vs multi-page PDFs and we
        // want stable read-back ordering without globbing the dir.
        const info = spawnSync('pdfinfo', [tmpPdf], spawnOpts);
        if (info.error && (info.error as any).code === 'ETIMEDOUT') {
            throw new PdfTooLargeError('pdfinfo timed out');
        }
        if (info.status !== 0) {
            throw new Error(`pdfinfo failed: ${info.stderr || 'unknown error'}`);
        }
        const pagesMatch = info.stdout.match(/^Pages:\s*(\d+)/m);
        const pageCount = pagesMatch ? parseInt(pagesMatch[1], 10) : 1;
        if (pageCount <= 0) throw new Error('PDF reports zero pages');
        if (pageCount > MAX_PAGES) {
            throw new PdfTooLargeError(`PDF has ${pageCount} pages (max ${MAX_PAGES})`);
        }
        // Reject an oversized MediaBox before rasterising — "Page size: 595.32 x 841.92 pts".
        const sizeMatch = info.stdout.match(/^Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/m);
        if (sizeMatch) {
            const w = parseFloat(sizeMatch[1]);
            const h = parseFloat(sizeMatch[2]);
            if (w > MAX_PAGE_PT || h > MAX_PAGE_PT) {
                throw new PdfTooLargeError(`PDF page ${w}x${h}pt exceeds ${MAX_PAGE_PT}pt cap`);
            }
        }

        if (pageCount === 1) {
            const r = spawnSync(
                'pdftoppm',
                ['-r', String(density), '-png', '-singlefile', tmpPdf, outPrefix],
                spawnOpts
            );
            if (r.error && (r.error as any).code === 'ETIMEDOUT') {
                throw new PdfTooLargeError('pdftoppm timed out');
            }
            if (r.status !== 0) {
                throw new Error(`pdftoppm failed: ${r.stderr || 'unknown error'}`);
            }
            const buf = await fs.readFile(`${outPrefix}.png`);
            return [buf];
        }

        const r = spawnSync(
            'pdftoppm',
            ['-r', String(density), '-png', tmpPdf, outPrefix],
            spawnOpts
        );
        if (r.error && (r.error as any).code === 'ETIMEDOUT') {
            throw new PdfTooLargeError('pdftoppm timed out');
        }
        if (r.status !== 0) {
            throw new Error(`pdftoppm failed: ${r.stderr || 'unknown error'}`);
        }
        // pdftoppm pads page numbers with enough zeros to represent
        // the page count (e.g. 10 pages → "p-01.png", "p-02.png"…),
        // matching the dev staging script's expectations.
        const pad = String(pageCount).length;
        const pages: Buffer[] = [];
        for (let i = 1; i <= pageCount; i++) {
            const n = String(i).padStart(pad, '0');
            pages.push(await fs.readFile(`${outPrefix}-${n}.png`));
        }
        return pages;
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
};
