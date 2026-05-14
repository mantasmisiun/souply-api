import '../config/env.js';
import * as Minio from 'minio';

/**
 * Apply public-read policy to the `product-images` bucket.
 *
 * Catalog images need anonymous GET — every user fetching a product
 * card hits the URL without auth. Without this policy MinIO returns
 * 403 and React Native's <Image> renders empty.
 *
 * Receipts bucket stays private (per-user signed GETs) because receipt
 * contents are PII. Different security rules per bucket.
 *
 * Run once per environment:
 *   npx tsx src/scripts/setProductImagesBucketPublic.ts
 */
(async () => {
    const endPoint = (process.env.MINIO_PUBLIC_URL
        ? new URL(process.env.MINIO_PUBLIC_URL).hostname
        : process.env.MINIO_ENDPOINT) ?? '192.168.1.212';
    const port = process.env.MINIO_PUBLIC_URL
        ? Number(new URL(process.env.MINIO_PUBLIC_URL).port || 80)
        : Number(process.env.MINIO_PORT ?? 9000);
    const useSSL = process.env.MINIO_PUBLIC_URL?.startsWith('https://') ?? false;

    const client = new Minio.Client({
        endPoint,
        port,
        useSSL,
        accessKey: process.env.MINIO_ACCESS_KEY || '',
        secretKey: process.env.MINIO_SECRET_KEY || '',
    });

    const bucket = process.env.MINIO_PRODUCT_IMAGES_BUCKET || 'product-images';

    const policy = {
        Version: '2012-10-17',
        Statement: [{
            Sid: 'AnonRead',
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucket}/*`],
        }],
    };

    await client.setBucketPolicy(bucket, JSON.stringify(policy));
    console.log(`[bucket-policy] '${bucket}' on ${endPoint}:${port} → public-read`);
})().catch(e => {
    console.error('[bucket-policy] failed:', e?.message ?? e);
    process.exit(1);
});
