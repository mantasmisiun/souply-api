/**
 * MinIO helper for the local stack (docker-compose.local.yml).
 *
 *   npx tsx src/scripts/localMinio.ts init     create the buckets the API expects
 *   npx tsx src/scripts/localMinio.ts mirror   copy every object from the OMV dev
 *                                              MinIO (.env) into local (.env.local)
 *
 * Bucket access mirrors the deployed setup: product-images is anonymous-read
 * (stored URLs are unsigned); receipts, avatars and template-covers stay
 * private and are served through presigned URLs.
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
    port: Number(env.MINIO_PORT || 9000),
    useSSL: false,
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

async function init() {
    for (const bucket of Object.values(BUCKETS)) {
        if (await target.bucketExists(bucket)) {
            console.log(`[minio] ${bucket}: exists`);
        } else {
            await target.makeBucket(bucket, 'us-east-1');
            console.log(`[minio] ${bucket}: created`);
        }
    }
    await target.setBucketPolicy(BUCKETS.productImages, publicReadPolicy(BUCKETS.productImages));
    console.log(`[minio] ${BUCKETS.productImages}: anonymous read enabled`);
}

const listAll = (client: Minio.Client, bucket: string): Promise<Minio.BucketItem[]> =>
    new Promise((resolve, reject) => {
        const items: Minio.BucketItem[] = [];
        const stream = client.listObjectsV2(bucket, '', true);
        stream.on('data', (o) => { if (o.name) items.push(o as Minio.BucketItem); });
        stream.on('error', reject);
        stream.on('end', () => resolve(items));
    });

async function mirror() {
    const source = clientFor(readEnv('.env'));
    await init();
    for (const bucket of Object.values(BUCKETS)) {
        if (!(await source.bucketExists(bucket).catch(() => false))) {
            console.log(`[mirror] ${bucket}: not on source, skipped`);
            continue;
        }
        const [srcItems, dstItems] = await Promise.all([listAll(source, bucket), listAll(target, bucket)]);
        const have = new Map(dstItems.map(o => [o.name, o.size]));
        const todo = srcItems.filter(o => have.get(o.name!) !== o.size);
        console.log(`[mirror] ${bucket}: ${srcItems.length} on source, ${todo.length} to copy`);
        let done = 0;
        for (const o of todo) {
            const stat = await source.statObject(bucket, o.name!);
            const body = await source.getObject(bucket, o.name!);
            await target.putObject(bucket, o.name!, body, o.size, { 'Content-Type': stat.metaData['content-type'] });
            if (++done % 200 === 0) console.log(`[mirror] ${bucket}: ${done}/${todo.length}`);
        }
    }
    console.log('[mirror] done');
}

if (mode === 'init') await init();
else if (mode === 'mirror') await mirror();
else {
    console.error('usage: localMinio.ts <init|mirror>');
    process.exit(1);
}
