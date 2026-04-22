import { fromBuffer } from 'pdf2pic';

/**
 * Convert every page of a PDF buffer to a JPEG buffer. Returns one entry
 * per page in page order. The client OCRs each page separately and merges
 * the resulting line lists — stitching into a single giant image tanks ML
 * Kit accuracy on large receipts.
 *
 * density=200 is a good balance between OCR accuracy and output size for
 * typical receipt PDFs.
 */
export const convertPdfBufferToJpegPages = async (
    pdfBuffer: Buffer,
    opts: { density?: number; width?: number } = {}
): Promise<Buffer[]> => {
    const converter = fromBuffer(pdfBuffer, {
        density: opts.density ?? 200,
        format: 'jpeg',
        width: opts.width ?? 2000,
        preserveAspectRatio: true,
    });

    // -1 = all pages. Returns [{ buffer, ... }, ...] in page order.
    const results = await converter.bulk(-1, { responseType: 'buffer' });
    const pages: Buffer[] = results
        .map((r: any) => r?.buffer)
        .filter((b: unknown): b is Buffer => Buffer.isBuffer(b));

    if (pages.length === 0) {
        throw new Error('pdf2pic returned no page buffers');
    }

    return pages;
};
