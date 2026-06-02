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

// ── User avatars ────────────────────────────────────────────────────────────
// PRIVATE bucket — avatars are served via short-lived presigned GET URLs
// (minted at read time), never a public URL. We persist the storage KEY on
// User.avatarUrl and sign it whenever the user is returned.

const AVATARS_BUCKET = process.env.MINIO_AVATARS_BUCKET || 'avatars';
const AVATAR_GET_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (presign max)
let ensureAvatarsBucketPromise: Promise<void> | null = null;

const ensureAvatarsBucket = (): Promise<void> => {
    if (!ensureAvatarsBucketPromise) {
        ensureAvatarsBucketPromise = (async () => {
            const client = getClient();
            const exists = await client.bucketExists(AVATARS_BUCKET).catch(() => false);
            if (!exists) {
                await client.makeBucket(AVATARS_BUCKET, 'us-east-1');
                console.log('[MinIO] created bucket', AVATARS_BUCKET);
            }
            // No public policy — kept private; served via presigned URLs.
        })().catch((err) => {
            ensureAvatarsBucketPromise = null;
            throw err;
        });
    }
    return ensureAvatarsBucketPromise;
};

/**
 * Compress an uploaded avatar (any image) to a square 256×256 JPEG and store
 * it at `{userId}.jpg` in the private avatars bucket (overwrites on change).
 * Returns the storage KEY — persist it on User.avatarUrl and sign it on read.
 */
export const uploadAvatar = async (userId: string, body: Buffer): Promise<string> => {
    await ensureAvatarsBucket();
    const sharp = (await import('sharp')).default;
    const jpg = await sharp(body)
        .rotate() // honour EXIF orientation before cropping
        .resize(256, 256, { fit: 'cover' })
        .jpeg({ quality: 82 })
        .toBuffer();
    const key = `${userId}.jpg`;
    await getClient().putObject(AVATARS_BUCKET, key, Readable.from(jpg), jpg.length, {
        'Content-Type': 'image/jpeg',
    });
    return key;
};

/**
 * Mint a fresh presigned GET URL for a stored avatar. Accepts either a bare
 * key (new) or a legacy full URL (extracts the key after `avatars/`). Returns
 * null when there's no avatar.
 */
export const avatarSignedUrl = async (stored: string | null | undefined): Promise<string | null> => {
    if (!stored) return null;
    // Normalise: strip any host + bucket prefix + query, leaving the object key.
    let key = stored;
    const marker = `${AVATARS_BUCKET}/`;
    const i = stored.indexOf(marker);
    if (i >= 0) key = stored.slice(i + marker.length);
    key = key.split('?')[0];
    try {
        await ensureAvatarsBucket();
        return await getClient().presignedGetObject(AVATARS_BUCKET, key, AVATAR_GET_TTL_SECONDS);
    } catch {
        return null;
    }
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
/* ── Template covers ──────────────────────────────────────────────
 *
 * Per-creator cover photos for BasketTemplate rows. Souply-web
 * uploads via POST /api/uploads/template-cover; consumer surfaces
 * (souply-app basket bookmark, basket-instance icon) read fresh
 * signed URLs at fetch time so the bucket can stay private.
 *
 * Bucket is created lazily on first upload — saves a manual
 * `mc mb` step in dev, and is a no-op against existing buckets in
 * prod. 7-day signed GETs are the MinIO max; we refresh on
 * dashboard load via getTemplateCoverSignedUrl().
 */
const TEMPLATE_COVERS_BUCKET = process.env.MINIO_TEMPLATE_COVERS_BUCKET || 'template-covers';
const TEMPLATE_COVERS_GET_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

let ensureTemplateCoversBucketPromise: Promise<void> | null = null;

/** Idempotent lazy `mc mb` — first caller pays the round-trip, the
 *  rest await the cached promise. Failures bubble up so the caller
 *  can decide whether to 500 or retry. */
const ensureTemplateCoversBucket = (): Promise<void> => {
    if (!ensureTemplateCoversBucketPromise) {
        ensureTemplateCoversBucketPromise = (async () => {
            const client = getClient();
            const exists = await client.bucketExists(TEMPLATE_COVERS_BUCKET).catch(() => false);
            if (!exists) {
                await client.makeBucket(TEMPLATE_COVERS_BUCKET, 'us-east-1');
                console.log('[MinIO] created bucket', TEMPLATE_COVERS_BUCKET);
            }
        })().catch((err) => {
            // Reset so the next caller retries instead of inheriting
            // the failure (transient MinIO outage, race with manual
            // bucket creation, etc).
            ensureTemplateCoversBucketPromise = null;
            throw err;
        });
    }
    return ensureTemplateCoversBucketPromise;
};

/**
 * Upload a processed cover image at a deterministic path. Returns the
 * storage key (persist this on BasketTemplate) plus a fresh signed
 * URL the client can render immediately.
 *
 * Key format: `template-covers/{userId}/{uuid}.jpg`. userId is part of
 * the path so a future "list all covers a user owns" sweep stays a
 * simple prefix list rather than a DB scan.
 */
export const uploadTemplateCover = async (
    userId: string,
    storageKey: string,
    body: Buffer,
    mimeType: string,
): Promise<{ storageKey: string; url: string; expiresAt: string }> => {
    await ensureTemplateCoversBucket();
    const client = getClient();
    await client.putObject(
        TEMPLATE_COVERS_BUCKET,
        storageKey,
        Readable.from(body),
        body.length,
        {
            'Content-Type': mimeType,
            // Tag the user on the object metadata so a misplaced key
            // can still be traced to its owner without a DB lookup.
            'x-amz-meta-souply-user': userId,
        },
    );
    return getTemplateCoverSignedUrl(storageKey);
};

/** Mint a fresh presigned GET URL for an existing cover. Web/mobile
 *  clients call this when a list response's `expiresAt` is past or
 *  about to expire. */
export const getTemplateCoverSignedUrl = async (
    storageKey: string,
): Promise<{ storageKey: string; url: string; expiresAt: string }> => {
    await ensureTemplateCoversBucket();
    const url = await getClient().presignedGetObject(
        TEMPLATE_COVERS_BUCKET,
        storageKey,
        TEMPLATE_COVERS_GET_TTL_SECONDS,
    );
    const expiresAt = new Date(Date.now() + TEMPLATE_COVERS_GET_TTL_SECONDS * 1000).toISOString();
    return { storageKey, url, expiresAt };
};

/** Delete a cover when a template is removed. Best-effort: a 404 from
 *  MinIO (object already gone) is swallowed so cascade deletes don't
 *  fail on partial state. */
export const deleteTemplateCover = async (storageKey: string): Promise<void> => {
    try {
        await getClient().removeObject(TEMPLATE_COVERS_BUCKET, storageKey);
    } catch (err: any) {
        if (err?.code !== 'NoSuchKey') throw err;
    }
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