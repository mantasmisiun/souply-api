import { fromBuffer } from 'pdf2pic';
import * as fs from 'fs';
import * as path from 'path';

export const convertPdfToImageBuffer = async (pdfBuffer: Buffer): Promise<Buffer> => {
    const convert = fromBuffer(pdfBuffer, {
        density: 200,
        format: 'jpeg',
        width: 1654,
        height: 2339,
        saveFilename: 'receipt',
        savePath: '/tmp'
    });

    const result = await convert(1, { responseType: 'buffer' });

    if (!result.buffer) {
        throw new Error('Failed to convert PDF to image');
    }

    return result.buffer;
};