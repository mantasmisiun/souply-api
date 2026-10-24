// Copy MinIO objects from another S3 endpoint into STAGING's MinIO.
// Runs INSIDE the souply-api:staging image (which has the `minio` package), so the
// staging credentials come from `--env-file .env.staging` and are never handled by
// whoever runs it. The source is passed as SRC_* env vars. See load-from-local.sh.
//
//   docker run --rm --network souply-staging_default --env-file .env.staging \
//     -e SRC_ENDPOINT=… -e SRC_PORT=… -e SRC_ACCESS_KEY=… -e SRC_SECRET_KEY=… \
//     -v "$PWD/scripts/staging/mirror-objects.mjs:/app/mirror-objects.mjs:ro" \
//     --entrypoint node souply-api:staging /app/mirror-objects.mjs
//
// Skips objects already present with the same size, so it's safe to re-run.
import * as Minio from 'minio';

const env = process.env;
const source = new Minio.Client({
    endPoint: env.SRC_ENDPOINT,
    port: Number(env.SRC_PORT || 9000),
    useSSL: env.SRC_USE_SSL === 'true',
    accessKey: env.SRC_ACCESS_KEY,
    secretKey: env.SRC_SECRET_KEY,
    region: env.SRC_REGION || 'us-east-1',
});
// Talk to staging's MinIO over the compose network, not the public URL.
const target = new Minio.Client({
    endPoint: env.MINIO_ENDPOINT || 'minio',
    port: Number(env.MINIO_PORT || 9000),
    useSSL: false,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    region: env.MINIO_REGION || 'us-east-1',
});

// [bucket, anonymous read] — same access as the deployed stacks.
const BUCKETS = [
    [env.MINIO_BUCKET || 'receipts', false],
    [env.MINIO_PRODUCT_IMAGES_BUCKET || 'product-images', true],
    [env.MINIO_AVATARS_BUCKET || 'avatars', false],
    [env.MINIO_TEMPLATE_COVERS_BUCKET || 'template-covers', false],
];

const publicRead = (bucket) => JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }],
});

const listAll = async (client, bucket) => {
    const items = [];
    for await (const o of client.listObjectsV2(bucket, '', true)) if (o.name) items.push(o);
    return items;
};

let failed = 0;
for (const [bucket, isPublic] of BUCKETS) {
    if (!(await target.bucketExists(bucket))) await target.makeBucket(bucket, 'us-east-1');
    if (isPublic) await target.setBucketPolicy(bucket, publicRead(bucket));
    let srcItems;
    try {
        srcItems = await listAll(source, bucket);
    } catch (err) {
        failed++;
        console.warn(`[mirror] ${bucket}: can't list source (${err?.code ?? err?.message}) — skipped`);
        continue;
    }
    const have = new Map((await listAll(target, bucket)).map(o => [o.name, o.size]));
    const todo = srcItems.filter(o => have.get(o.name) !== o.size);
    console.log(`[mirror] ${bucket}: ${srcItems.length} on source, ${todo.length} to copy${isPublic ? ' (public read)' : ''}`);
    for (const o of todo) {
        try {
            const stat = await source.statObject(bucket, o.name);
            await target.putObject(bucket, o.name, await source.getObject(bucket, o.name), o.size,
                { 'Content-Type': stat.metaData['content-type'] });
        } catch (err) {
            failed++;
            console.warn(`[mirror] ${bucket}/${o.name}: ${err?.code ?? err?.message}`);
        }
    }
}
console.log(`[mirror] done${failed ? ` — ${failed} failure(s), re-run to retry` : ''}`);
process.exitCode = failed ? 1 : 0;
