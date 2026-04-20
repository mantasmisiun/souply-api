import * as Minio from 'minio';
import { Readable } from 'stream';

let minioClient: Minio.Client | null = null;

const getClient = () => {
    if (!minioClient) {
        minioClient = new Minio.Client({
            endPoint: process.env.MINIO_ENDPOINT || '192.168.1.212',
            port: parseInt(process.env.MINIO_PORT || '9000'),
            useSSL: false,
            accessKey: process.env.MINIO_ACCESS_KEY || '',
            secretKey: process.env.MINIO_SECRET_KEY || ''
        });
        console.log('MinIO connecting with:', process.env.MINIO_ACCESS_KEY, process.env.MINIO_ENDPOINT);
    }
    return minioClient;
};

const BUCKET = process.env.MINIO_BUCKET || 'receipts';

export const uploadReceiptImage = async (
    imageBuffer: Buffer,
    filename: string,
    mimeType: string
): Promise<string> => {
    const client = getClient();
    const objectName = `${Date.now()}-${filename}`;

    await client.putObject(
        BUCKET,
        objectName,
        Readable.from(imageBuffer),
        imageBuffer.length,
        { 'Content-Type': mimeType }
    );

    return `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}/${BUCKET}/${objectName}`;
};

export const getPresignedUrl = async (objectName: string): Promise<string> => {
    const client = getClient();
    // Extract just the object name from the full URL
    const key = objectName.split(`/${BUCKET}/`)[1];
    // Generate presigned URL valid for 1 hour
    return await client.presignedGetObject(BUCKET, key, 60 * 60);
};

export const deleteReceiptImage = async (fileUrl: string): Promise<void> => {
    const client = getClient();
    const key = fileUrl.split(`/${BUCKET}/`)[1];
    await client.removeObject(BUCKET, key);
};

/**
 * Generate a presigned PUT URL so mobile clients can upload directly to MinIO
 * without streaming through the backend.
 */
export const getPresignedUploadUrl = async (
    filename: string,
    mimeType: string
): Promise<{ uploadUrl: string; filePath: string }> => {
    const client = getClient();
    const objectName = `${Date.now()}-${filename.replace(/[^\w.-]/g, '_')}`;
    const uploadUrl = await client.presignedPutObject(BUCKET, objectName, 60 * 15); // 15 min
    const filePath = `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}/${BUCKET}/${objectName}`;
    return { uploadUrl, filePath };
};