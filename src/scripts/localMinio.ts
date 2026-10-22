/**
 * MinIO helper for the local stack (docker-compose.local.yml).
 *
 *   npx tsx src/scripts/localMinio.ts init              create the buckets the API expects
 *   npx tsx src/scripts/localMinio.ts mirror <envfile>  copy buckets from an S3 source
 *                                                       (R2: .env.r2) into local
 *
 * Bucket access mirrors the deployed setup: product-images (and logos) are
 * anonymous-read (stored URLs are unsigned); receipts, avatars and
 * template-covers stay private and are served through presigned URLs.
 *
 * Source env file: MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL, MINIO_ACCESS_KEY,
 * MINIO_SECRET_KEY, MINIO_REGION, and MIRROR_BUCKETS — comma-separated
 * `source:local[:public]` (local defaults to the source name). Use a READ-ONLY
 * token for the source.
 *
 * Reads both env files directly with dotenv.parse, so the source and target
 * credentials never mix in process.env. Mirroring skips objects that already
 * exist locally with the same size, so it's safe to re-run.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import * as Minio from 'minio';

const mode = process.argv[2];

const readEnv = (file: string): Record<string, string> => {
    if (!fs.existsSync(file)) throw new Error(`${file} not found (run from souply-api/)`);
    return dotenv.parse(fs.readFileSync(file));
};

const clientFor = (env: Record<string, string>): Minio.Client => new Minio.Client({
    endPoint: env.MINIO_ENDPOINT,
    port: Number(env.MINIO_PORT || (env.MINIO_USE_SSL === 'true' ? 443 : 9000)),
    useSSL: env.MINIO_USE_SSL === 'true',
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    region: env.MINIO_REGION || 'us-east-1',
});

const local = readEnv('.env.local');
const target = clientFor(local);

const BUCKETS = {
    receipts:          local.MINIO_BUCKET || 'receipts',
    productImages:     local.MINIO_PRODUCT_IMAGES_BUCKET || 'product-images',
    avatars:           local.MINIO_AVATARS_BUCKET || 'avatars',
    templateCovers:    local.MINIO_TEMPLATE_COVERS_BUCKET || 'template-covers',
};

const publicReadPolicy = (bucket: string) => JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
    }],
});

async function ensureBucket(bucket: string, isPublic: boolean) {
    if (await target.bucketExists(bucket)) {
        console.log(`[minio] ${bucket}: exists`);
    } else {
        await target.makeBucket(bucket, 'us-east-1');
        console.log(`[minio] ${bucket}: created`);
    }
    if (isPublic) {
        await target.setBucketPolicy(bucket, publicReadPolicy(bucket));
        console.log(`[minio] ${bucket}: anonymous read enabled`);
    }
}

async function init() {
    for (const bucket of Object.values(BUCKETS)) {
        await ensureBucket(bucket, bucket === BUCKETS.productImages);
    }
}

const listAll = (client: Minio.Client, bucket: string): Promise<Minio.BucketItem[]> =>
    new Promise((resolve, reject) => {
        const items: Minio.BucketItem[] = [];
        const stream = client.listObjectsV2(bucket, '', true);
        stream.on('data', (o) => { if (o.name) items.push(o as Minio.BucketItem); });
        stream.on('error', reject);
        stream.on('end', () => resolve(items));
    });

async function mirror(sourceFile: string) {
    const sourceEnv = readEnv(sourceFile);
    const mappings = (sourceEnv.MIRROR_BUCKETS ?? '').split(',').map(s => s.trim()).filter(Boolean)
        .map(s => {
            const [src, dst, flag] = s.split(':');
            return { src, dst: dst || src, isPublic: flag === 'public' };
        });
    if (!mappings.length) throw new Error(`${sourceFile}: set MIRROR_BUCKETS=source:local[:public],...`);

    const source = clientFor(sourceEnv);
    await init();
    let failed = 0;
    for (const { src, dst, isPublic } of mappings) {
        await ensureBucket(dst, isPublic);
        // No bucketExists probe on the source: bucket-scoped read-only tokens
        // (R2 "Object Read") may not allow HeadBucket. Listing is the real test.
        let srcItems: Minio.BucketItem[];
        try {
            srcItems = await listAll(source, src);
        } catch (err: any) {
            failed++;
            console.warn(`[mirror] ${src}: can't list (${err?.code ?? err?.message}) — skipped`);
            continue;
        }
        const dstItems = await listAll(target, dst);
        const have = new Map(dstItems.map(o => [o.name, o.size]));
        const todo = srcItems.filter(o => have.get(o.name!) !== o.size);
        console.log(`[mirror] ${src} → ${dst}: ${srcItems.length} on source, ${todo.length} to copy`);
        let done = 0;
        for (const o of todo) {
            try {
                const stat = await source.statObject(src, o.name!);
                const body = await source.getObject(src, o.name!);
                await target.putObject(dst, o.name!, body, o.size, { 'Content-Type': stat.metaData['content-type'] });
            } catch (err: any) {
                failed++;
                console.warn(`[mirror] ${src}/${o.name}: ${err?.code ?? err?.message}`);
            }
            if (++done % 200 === 0) console.log(`[mirror] ${src}: ${done}/${todo.length}`);
        }
    }
    console.log(`[mirror] done${failed ? ` — ${failed} failure(s), see warnings above (re-run to retry)` : ''}`);
    if (failed) process.exitCode = 1;
}

if (mode === 'init') await init();
else if (mode === 'mirror' && process.argv[3]) await mirror(process.argv[3]);
else {
    console.error('usage: localMinio.ts init | mirror <source-envfile>');
    process.exit(1);
}
