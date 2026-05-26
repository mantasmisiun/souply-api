/**
 * One-shot: sync chain logos from production MinIO + DB → test MinIO + DB.
 *
 * Copies every object in the prod `chain-logos` bucket into the test
 * bucket of the same name, then mirrors StoreChain.logoUrl /
 * miniLogoUrl rows from prod DB into test DB. URLs that embed the prod
 * MinIO host get rewritten to the test host on the way in.
 *
 * Usage (set every var, then run with tsx):
 *
 *   export SRC_MINIO_PUBLIC_URL=https://minio.<prod-domain>
 *   export SRC_MINIO_ACCESS_KEY=<prod access key>
 *   export SRC_MINIO_SECRET_KEY=<prod secret key>
 *
 *   export DST_MINIO_PUBLIC_URL=http://192.168.1.212:9000      # or test domain
 *   export DST_MINIO_ACCESS_KEY=<test access key>
 *   export DST_MINIO_SECRET_KEY=<test secret key>
 *
 *   export SRC_DB_HOST=<prod-host>
 *   export SRC_DB_PORT=3306
 *   export SRC_DB_USER=<prod-user>
 *   export SRC_DB_PASS=<prod-pw>
 *   export SRC_DB_NAME=Basket_DB
 *
 *   export DST_DB_HOST=<test-host>
 *   export DST_DB_PORT=3306
 *   export DST_DB_USER=<test-user>
 *   export DST_DB_PASS=<test-pw>
 *   export DST_DB_NAME=Basket-DB-Test
 *
 *   export BUCKET=chain-logos        # optional, default chain-logos
 *
 *   npx tsx src/scripts/syncChainLogosProdToTest.ts
 *
 * Idempotent: re-running overwrites existing test objects + reapplies
 * the same row values. Safe to retry on failure.
 */
import * as Minio from 'minio';
import mysql from 'mysql2/promise';
import { Readable } from 'stream';

interface MinioConf {
    publicUrl: string;
    endPoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
}

function parseMinio(prefix: 'SRC' | 'DST'): MinioConf {
    const publicUrl = process.env[`${prefix}_MINIO_PUBLIC_URL`];
    const accessKey = process.env[`${prefix}_MINIO_ACCESS_KEY`];
    const secretKey = process.env[`${prefix}_MINIO_SECRET_KEY`];
    if (!publicUrl || !accessKey || !secretKey) {
        throw new Error(`Missing ${prefix}_MINIO_PUBLIC_URL / ACCESS_KEY / SECRET_KEY env vars`);
    }
    const u = new URL(publicUrl);
    const useSSL = u.protocol === 'https:';
    return {
        publicUrl: publicUrl.replace(/\/+$/, ''),
        endPoint: u.hostname,
        port: u.port ? Number(u.port) : (useSSL ? 443 : 80),
        useSSL,
        accessKey,
        secretKey,
    };
}

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var ${name}`);
    return v;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

(async () => {
    const src = parseMinio('SRC');
    const dst = parseMinio('DST');
    const bucket = process.env.BUCKET || 'chain-logos';

    const srcMinio = new Minio.Client({
        endPoint: src.endPoint, port: src.port, useSSL: src.useSSL,
        accessKey: src.accessKey, secretKey: src.secretKey,
    });
    const dstMinio = new Minio.Client({
        endPoint: dst.endPoint, port: dst.port, useSSL: dst.useSSL,
        accessKey: dst.accessKey, secretKey: dst.secretKey,
    });

    // Ensure destination bucket exists (no-op if it does).
    const dstHasBucket = await dstMinio.bucketExists(bucket).catch(() => false);
    if (!dstHasBucket) {
        await dstMinio.makeBucket(bucket);
        console.log(`[minio] created dst bucket '${bucket}'`);
    }

    // ── 1. Copy every object in the prod bucket into the test bucket ──
    const objects: { name: string; size: number }[] = [];
    await new Promise<void>((resolve, reject) => {
        const stream = srcMinio.listObjectsV2(bucket, '', true);
        stream.on('data', obj => objects.push({ name: obj.name!, size: obj.size ?? 0 }));
        stream.on('error', reject);
        stream.on('end', () => resolve());
    });
    console.log(`[minio] found ${objects.length} objects in src bucket '${bucket}'`);

    let copied = 0, copyFails = 0;
    for (const obj of objects) {
        try {
            const stat = await srcMinio.statObject(bucket, obj.name);
            const stream = await srcMinio.getObject(bucket, obj.name);
            const buffer = await streamToBuffer(stream as Readable);
            await dstMinio.putObject(bucket, obj.name, buffer, buffer.length, {
                'Content-Type': stat.metaData?.['content-type'] || 'application/octet-stream',
            });
            copied++;
            if (copied % 10 === 0) console.log(`[minio] copied ${copied}/${objects.length}`);
        } catch (e: any) {
            copyFails++;
            console.warn(`[minio] copy failed for '${obj.name}': ${e.message}`);
        }
    }
    console.log(`[minio] done: ${copied} copied, ${copyFails} failed`);

    // ── 2. Mirror StoreChain logo columns from src DB → dst DB ────────
    if (process.env.MINIO_ONLY === '1') {
        console.log('[db] MINIO_ONLY=1 — skipping DB row sync');
        console.log('[done]');
        return;
    }

    const srcDb = await mysql.createConnection({
        host: requireEnv('SRC_DB_HOST'),
        port: Number(process.env.SRC_DB_PORT ?? 3306),
        user: requireEnv('SRC_DB_USER'),
        password: requireEnv('SRC_DB_PASS'),
        database: requireEnv('SRC_DB_NAME'),
        ssl: undefined,
    });
    const dstDb = await mysql.createConnection({
        host: requireEnv('DST_DB_HOST'),
        port: Number(process.env.DST_DB_PORT ?? 3306),
        user: requireEnv('DST_DB_USER'),
        password: requireEnv('DST_DB_PASS'),
        database: requireEnv('DST_DB_NAME'),
        ssl: undefined,
    });

    const [rows]: any = await srcDb.query(
        'SELECT id, name, logoUrl, miniLogoUrl FROM StoreChain',
    );
    console.log(`[db] read ${rows.length} StoreChain rows from src`);

    const rewrite = (url: string | null): string | null => {
        if (!url) return url;
        if (url.startsWith(src.publicUrl)) return dst.publicUrl + url.slice(src.publicUrl.length);
        // Other absolute URL or relative path — leave as-is.
        return url;
    };

    let updated = 0, missing = 0;
    for (const r of rows as any[]) {
        const newLogo = rewrite(r.logoUrl);
        const newMini = rewrite(r.miniLogoUrl);
        const [result]: any = await dstDb.query(
            `UPDATE StoreChain
                SET logoUrl = ?, miniLogoUrl = ?
              WHERE id = ?`,
            [newLogo, newMini, r.id],
        );
        if (result.affectedRows === 0) {
            missing++;
            console.warn(`[db] no matching row in dst for StoreChain.id=${r.id} (${r.name}) — skipped`);
        } else {
            updated++;
        }
    }
    console.log(`[db] done: ${updated} rows updated, ${missing} missing in dst`);

    await srcDb.end();
    await dstDb.end();

    console.log('[done]');
})().catch(e => {
    console.error('[syncChainLogos] failed:', e?.stack ?? e);
    process.exit(1);
});
