import * as Minio from 'minio';
import { Readable } from 'stream';

/**
 * MinIO client configured against the PUBLIC hostname.
 *
 * Presigned URLs embed the target hostname into the SigV4 signature.
 * If we sign with endPoint=`minio` (the docker network name) and the
 * phone later requests `https://minio.manofoto.dpdns.org/...`, MinIO's
 * signature check sees a different Host header and rejects the PUT as
 * SignatureDoesNotMatch. We were hitting this bug in prod — uploads
 * failed silently, leaving Receipt rows with empty filePath.
 *
 * Fix: sign against the public URL. The API's own direct calls
 * (removeObject, putObject) pay a round-trip through Cloudflare +
 * Traefik, but those operations are infrequent and the latency is
 * acceptable for correctness.
 */
let minioClient: Minio.Client | null = null;

interface ParsedEndpoint {
    endPoint: string;
    port: number;
    useSSL: boolean;
}

const parsePublicUrl = (raw: string | undefined): ParsedEndpoint => {
    // Fallback to internal endpoint if PUBLIC_URL isn't set. Works on
    // LAN / dev setups where the phone can reach MinIO directly.
    if (!raw) {
        return {
            endPoint: process.env.MINIO_ENDPOINT || '192.168.1.212',
            port: parseInt(process.env.MINIO_PORT || '9000'),
            useSSL: false,
        };
    }
    try {
        const u = new URL(raw);
        const useSSL = u.protocol === 'https:';
        return {
            endPoint: u.hostname,
            port: u.port ? parseInt(u.port) : (useSSL ? 443 : 80),
            useSSL,
        };
    } catch {
        // Malformed MINIO_PUBLIC_URL — log loudly, fall back so the
        // service doesn't crash during startup.
        console.warn('[storageService] malformed MINIO_PUBLIC_URL:', raw);
        return {
            endPoint: process.env.MINIO_ENDPOINT || '192.168.1.212',
            port: parseInt(process.env.MINIO_PORT || '9000'),
            useSSL: false,
        };
    }
};

const getClient = () => {
    if (!minioClient) {
        const { endPoint, port, useSSL } = parsePublicUrl(process.env.MINIO_PUBLIC_URL);
        minioClient = new Minio.Client({
            endPoint,
            port,
            useSSL,
            accessKey: process.env.MINIO_ACCESS_KEY || '',
            secretKey: process.env.MINIO_SECRET_KEY || '',
        });
        console.log('[MinIO] signing presigned URLs for', `${useSSL ? 'https' : 'http'}://${endPoint}:${port}`);
    }
    return minioClient;
};

const BUCKET = process.env.MINIO_BUCKET || 'receipts';

/**
 * Compute the public URL prefix used to build stored `filePath` strings.
 * Matches the endpoint the client signs against so the filePath the
 * phone receives is directly openable (sans query-signature).
 */
const publicUrlPrefix = (): string => {
    const { endPoint, port, useSSL } = parsePublicUrl(process.env.MINIO_PUBLIC_URL);
    const proto = useSSL ? 'https' : 'http';
    // Omit :port for default ports — cleaner URL, same behaviour.
    const portSuffix = (useSSL && port === 443) || (!useSSL && port === 80) ? '' : `:${port}`;
    return `${proto}://${endPoint}${portSuffix}`;
};

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

    return `${publicUrlPrefix()}/${BUCKET}/${objectName}`;
};

/**
 * Generic upload at an explicit object key (no auto-timestamp suffix).
 * Used for avatars (avatars/{userId}.jpg — overwrites on every change)
 * and branded share QRs (template-qrs/{slug}.png — overwrites on
 * snapshot refresh). Returns the public URL.
 */
export const uploadObject = async (
    objectKey: string,
    body: Buffer,
    mimeType: string,
): Promise<string> => {
    const client = getClient();
    await client.putObject(
        BUCKET,
        objectKey,
        Readable.from(body),
        body.length,
        { 'Content-Type': mimeType },
    );
    return `${publicUrlPrefix()}/${BUCKET}/${objectKey}`;
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
    _mimeType: string
): Promise<{ uploadUrl: string; filePath: string }> => {
    const client = getClient();
    const objectName = `${Date.now()}-${filename.replace(/[^\w.-]/g, '_')}`;
    const uploadUrl = await client.presignedPutObject(BUCKET, objectName, 60 * 15); // 15 min
    const filePath = `${publicUrlPrefix()}/${BUCKET}/${objectName}`;
    return { uploadUrl, filePath };
};
const PRODUCT_IMAGES_BUCKET = process.env.MINIO_PRODUCT_IMAGES_BUCKET || 'product-images';

export const getPresignedProductImageUploadUrl = async (
  filename: string,
  _mimeType: string
): Promise<{ uploadUrl: string; filePath: string }> => {
  const client = getClient();
  const objectName = `${Date.now()}-${filename.replace(/[^\w.-]/g, '_')}`;
  const uploadUrl = await client.presignedPutObject(PRODUCT_IMAGES_BUCKET, objectName, 60 * 15);
  const filePath = `${publicUrlPrefix()}/${PRODUCT_IMAGES_BUCKET}/${objectName}`;
  return { uploadUrl, filePath };
};