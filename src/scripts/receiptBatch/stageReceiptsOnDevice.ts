/**
 * Stage receipt PDFs for the phone-side batch screen:
 *   1. Walks basket-api/receipts/<chain>/*.pdf
 *   2. Runs `pdftoppm -r 200 -png` per file → one PNG per page, named
 *      <basename>.png (or <basename>-N.png for multi-page) under
 *      basket-api/receipts/_batch_staging/<chain>/.
 *   3. Writes a manifest.json alongside so the phone knows what to
 *      iterate.
 *
 * The Express server already static-serves _batch_staging at
 * /receipts-batch/<chain>/... so the phone pulls files over HTTP on
 * the same LAN as the rest of the API. No ADB push — Samsung/OneUI
 * silently drops direct writes to /Android/data/<pkg>/ in FUSE and
 * file:// reads from the app fail on scoped-storage devices.
 *
 * Usage:
 *   npm run receipts:stage -- --chain maxima
 *   npm run receipts:stage -- --chain rimi
 *   npm run receipts:stage -- --chain all
 *
 * Prereqs on dev machine: poppler-utils (pdftoppm) — no adb needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

type ChainName = 'maxima' | 'rimi' | 'iki' | 'norfa' | 'lidl';
const SUPPORTED: ChainName[] = ['maxima', 'rimi', 'iki', 'norfa', 'lidl'];

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
// Source PDFs live in the cross-stack module dir under
// shared/receipts/<chain>/<name>.pdf, alongside their hand-annotated
// .truth.json siblings. This is where the parser test fixtures live.
const RECEIPTS_ROOT = path.join(REPO_ROOT, 'shared', 'receipts');
// Staging output (PNGs + manifest) stays inside basket-api so the
// existing /receipts-batch static route in src/index.ts keeps
// serving it without configuration changes. _batch_staging is
// regeneratable disposable output — no need to live in /shared.
const STAGING_ROOT = path.join(REPO_ROOT, 'basket-api', 'receipts', '_batch_staging');

interface CliArgs {
    chains: ChainName[];
}

const parseArgs = (argv: string[]): CliArgs => {
    let chain: string | null = null;
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--chain') chain = argv[++i];
    }
    if (!chain) throw new Error('--chain <maxima|rimi|iki|all> required');
    if (chain === 'all') return { chains: SUPPORTED };
    if (!SUPPORTED.includes(chain as ChainName)) {
        throw new Error(`--chain must be one of ${SUPPORTED.join('|')}|all`);
    }
    return { chains: [chain as ChainName] };
};

const which = (cmd: string): boolean => {
    const r = spawnSync('which', [cmd]);
    return r.status === 0;
};

const run = (cmd: string, args: string[]): { stdout: string; status: number } => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { stdout: r.stdout ?? '', status: r.status ?? 1 };
};

/**
 * Convert one PDF to PNGs via pdftoppm. Multi-page PDFs produce
 * `<base>-1.png`, `<base>-2.png`, ... (pdftoppm's default). Single-page
 * PDFs produce a single `<base>.png` when we pass `-singlefile`; we
 * detect page count first and dispatch accordingly so the phone screen
 * doesn't need to special-case naming.
 */
const convertPdf = (pdfPath: string, outDir: string, baseName: string): string[] => {
    const info = run('pdfinfo', [pdfPath]);
    const pagesMatch = info.stdout.match(/^Pages:\s*(\d+)/m);
    const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 1;

    const outPrefix = path.join(outDir, baseName);
    if (pages === 1) {
        const r = run('pdftoppm', ['-r', '200', '-png', '-singlefile', pdfPath, outPrefix]);
        if (r.status !== 0) throw new Error(`pdftoppm failed for ${pdfPath}`);
        return [`${baseName}.png`];
    } else {
        const r = run('pdftoppm', ['-r', '200', '-png', pdfPath, outPrefix]);
        if (r.status !== 0) throw new Error(`pdftoppm failed for ${pdfPath}`);
        // pdftoppm pads with enough zeros to represent pages (e.g. 10
        // pages → "-01", "-02", …). We regenerate the expected names
        // here rather than re-list the dir so ordering is stable.
        const pad = String(pages).length;
        return Array.from({ length: pages }, (_, i) => {
            const n = String(i + 1).padStart(pad, '0');
            return `${baseName}-${n}.png`;
        });
    }
};

const main = async () => {
    const args = parseArgs(process.argv);

    if (!which('pdftoppm')) {
        throw new Error('pdftoppm not found. Install via: sudo apt install poppler-utils');
    }

    for (const chain of args.chains) {
        const srcDir = path.join(RECEIPTS_ROOT, chain);
        const outDir = path.join(STAGING_ROOT, chain);
        if (!fs.existsSync(srcDir)) {
            console.log(`[${chain}] no receipts dir, skipping`);
            continue;
        }
        // Fresh staging per run so old PNGs don't linger from a previous
        // chain set. The device side gets overwritten anyway but the
        // local staging folder is also where the manifest lives.
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });

        // Accept PDFs (converted via pdftoppm) or pre-rasterised images
        // (PNG/JPG/JPEG — dropped in as-is, no conversion step). Photo-
        // based receipts (Lidl on this project) already arrive as PNGs
        // from the phone; requiring them to be wrapped in a PDF just
        // to go through the batch pipeline would be wasteful.
        const files = fs
            .readdirSync(srcDir)
            .filter((f) => /\.(pdf|png|jpe?g)$/i.test(f))
            .sort();

        console.log(`[${chain}] processing ${files.length} file${files.length === 1 ? '' : 's'}…`);

        interface ManifestEntry {
            sourcePdf: string;
            pages: string[];
        }
        const manifest: ManifestEntry[] = [];
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            const base = path.basename(file, ext);
            try {
                if (ext === '.pdf') {
                    const pages = convertPdf(path.join(srcDir, file), outDir, base);
                    manifest.push({ sourcePdf: file, pages });
                    process.stdout.write(`  · ${file} → ${pages.length} page(s)\n`);
                } else {
                    // Raw image — copy (with normalized extension) into
                    // staging. We re-use the pdftoppm output filename
                    // convention `<base>.png` so the phone batch screen
                    // doesn't need to know whether a receipt originated
                    // from a PDF or a photo.
                    const destName = `${base}.png`;
                    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, destName));
                    manifest.push({ sourcePdf: file, pages: [destName] });
                    process.stdout.write(`  · ${file} → copied\n`);
                }
            } catch (e: any) {
                console.warn(`  ✗ ${file}: ${e.message ?? e}`);
            }
        }
        fs.writeFileSync(
            path.join(outDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
        );
        console.log(`[${chain}] staged at ${outDir}`);
    }
    console.log(
        'Done. API server serves files at /receipts-batch/<chain>/. Open the app → Menu → Kvitų paketinis testas.'
    );
};

main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
});
