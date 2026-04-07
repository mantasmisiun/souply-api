import * as Minio from 'minio';
import { Readable } from 'stream';

const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || '192.168.1.212',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || '',
    secretKey: process.env.MINIO_SECRET_KEY || ''
});

const BUCKET = process.env.MINIO_BUCKET || 'receipts';

export const uploadReceiptImage = async (
    imageBuffer: Buffer,
    filename: string,
    mimeType: string
): Promise<string> => {
    const objectName = `${Date.now()}-${filename}`;

    await minioClient.putObject(
        BUCKET,
        objectName,
        Readable.from(imageBuffer),
        imageBuffer.length,
        { 'Content-Type': mimeType }
    );

    return `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}/${BUCKET}/${objectName}`;
};