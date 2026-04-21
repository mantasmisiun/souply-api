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

const extractObjectKey = (filePathOrKey: string | null | undefined): string | null => {
    if (!filePathOrKey) return null;
    const marker = `/${BUCKET}/`;
    const idx = filePathOrKey.indexOf(marker);
    return idx >= 0 ? filePathOrKey.slice(idx + marker.length) : filePathOrKey;
};

export const getPresignedUrl = async (objectName: string | null | undefined): Promise<string> => {
    const key = extractObjectKey(objectName);
    if (!key) {
        const err = new Error('Receipt image is missing');
        (err as any).statusCode = 404;
        throw err;
    }
    return await getClient().presignedGetObject(BUCKET, key, 60 * 60);
};

export const deleteReceiptImage = async (fileUrl: string | null | undefined): Promise<void> => {
    const key = extractObjectKey(fileUrl);
    if (!key) return;
    await getClient().removeObject(BUCKET, key);
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
const PRODUCT_IMAGES_BUCKET = process.env.MINIO_PRODUCT_IMAGES_BUCKET || 'product-images';

export const getPresignedProductImageUploadUrl = async (
  filename: string,
  mimeType: string
): Promise<{ uploadUrl: string; filePath: string }> => {
  const client = getClient();
  const objectName = `${Date.now()}-${filename.replace(/[^\w.-]/g, '_')}`;
  const uploadUrl = await client.presignedPutObject(PRODUCT_IMAGES_BUCKET, objectName, 60 * 15);
  const filePath = `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}/${PRODUCT_IMAGES_BUCKET}/${objectName}`;
  return { uploadUrl, filePath };
};