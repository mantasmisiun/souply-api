/**
 * Stage receipt PDFs for the phone-side batch screen:
 *   1. Walks souply-api/receipts/<chain>/*.pdf
 *   2. Runs `pdftoppm -r 300 -png` per file (300 dpi: 200 left thin price digits at MLKit's glyph floor — dropped rows) → one PNG per page, named
 *      <basename>.png (or <basename>-N.png for multi-page) under
 *      souply-api/receipts/_batch_staging/<chain>/.
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
 * Add --with-truth to stage ONLY receipts that have a hand-annotated
 * `<basename>.truth.json` sibling — useful when you want the phone
 * batch test to score only the receipts you've prepared truth for:
 *
 *   npm run receipts:stage -- --chain all --with-truth
 *
 * Prereqs on dev machine: poppler-utils (pdftoppm) — no adb needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { convertPdfBufferToImagePages } from '../../services/pdfService.js';

type ChainName = 'maxima' | 'rimi' | 'iki' | 'norfa' | 'lidl';
const SUPPORTED: ChainName[] = ['maxima', 'rimi', 'iki', 'norfa', 'lidl'];

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
// Source PDFs live in the cross-stack module dir under
// shared/receipts/<chain>/<name>.pdf, alongside their hand-annotated
// .truth.json siblings. This is where the parser test fixtures live.
const RECEIPTS_ROOT = path.join(REPO_ROOT, 'shared', 'receipts');
// Staging output (PNGs + manifest) stays inside souply-api so the
// existing /receipts-batch static route in src/index.ts keeps
// serving it without configuration changes. _batch_staging is
// regeneratable disposable output — no need to live in /shared.
const STAGING_ROOT = path.join(REPO_ROOT, 'souply-api', 'receipts', '_batch_staging');

interface CliArgs {
    chains: ChainName[];
    withTruth: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
    let chain: string | null = null;
    let withTruth = false;
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--chain') chain = argv[++i];
        else if (a === '--with-truth') withTruth = true;
    }
    if (!chain) throw new Error('--chain <maxima|rimi|iki|all> required');
    if (chain === 'all') return { chains: SUPPORTED, withTruth };
    if (!SUPPORTED.includes(chain as ChainName)) {
        throw new Error(`--chain must be one of ${SUPPORTED.join('|')}|all`);
    }
    return { chains: [chain as ChainName], withTruth };
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
 * Convert one PDF to PNGs via the SHARED pdfService — the exact code the
 * live /api/receipts/pdf-to-image endpoint runs, so a receipt staged here
 * is pixel-identical to what a user's share-PDF upload produces (including
 * the image-wrapper extraction + enhancement path for Rimi app-share PDFs).
 * Naming keeps pdftoppm's convention the phone screen expects: single page
 * → `<base>.png`, multi-page → `<base>-1.png`… (zero-padded to page count).
 */
const convertPdf = async (pdfPath: string, outDir: string, baseName: string): Promise<string[]> => {
    const pages = await convertPdfBufferToImagePages(fs.readFileSync(pdfPath));
    if (pages.length === 1) {
        fs.writeFileSync(path.join(outDir, `${baseName}.png`), pages[0]);
        return [`${baseName}.png`];
    }
    const pad = String(pages.length).length;
    return pages.map((buf: Buffer, i: number) => {
        const n = String(i + 1).padStart(pad, '0');
        fs.writeFileSync(path.join(outDir, `${baseName}-${n}.png`), buf);
        return `${baseName}-${n}.png`;
    });
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
        const allDirEntries = fs.readdirSync(srcDir);
        const truthBaseSet = new Set(
            allDirEntries
                .filter((f) => f.endsWith('.truth.json'))
                .map((f) => f.replace(/\.truth\.json$/, ''))
        );
        let files = allDirEntries
            .filter((f) => /\.(pdf|png|jpe?g)$/i.test(f))
            .sort();

        if (args.withTruth) {
            const before = files.length;
            files = files.filter((f) => {
                const ext = path.extname(f);
                const base = path.basename(f, ext);
                return truthBaseSet.has(base);
            });
            console.log(
                `[${chain}] --with-truth: ${files.length}/${before} have truth siblings`
            );
        }

        console.log(`[${chain}] processing ${files.length} file${files.length === 1 ? '' : 's'}…`);

        interface ManifestEntry {
            sourcePdf: string;
            pages: string[];
            /** Staged copy of the raw PDF — present so a device with the
             *  souply-receipt-pdf native module can convert ON-DEVICE (the
             *  production share-flow path) instead of using the server-
             *  converted PNGs. Batch↔live parity for the conversion step. */
            pdf?: string;
        }
        const manifest: ManifestEntry[] = [];
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            const base = path.basename(file, ext);
            try {
                if (ext === '.pdf') {
                    const pages = await convertPdf(path.join(srcDir, file), outDir, base);
                    const pdfName = `${base}.pdf`;
                    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, pdfName));
                    manifest.push({ sourcePdf: file, pages, pdf: pdfName });
                    process.stdout.write(`  · ${file} → ${pages.length} page(s) + raw pdf\n`);
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
