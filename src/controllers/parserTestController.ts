/**
 * Dev-only: receive parser-test run summaries from the phone's
 * Kvitų paketinis testas screen and persist them under
 * shared/receipts/_results/<runId>.json so we have a paste-friendly
 * artifact per run for diffing parser changes.
 *
 * The phone POSTs the full JSON it built locally — server doesn't
 * validate beyond ensuring runId is filename-safe. This is a dev
 * tool, not a public endpoint.
 */
import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';

const RESULTS_DIR = path.resolve(process.cwd(), '../shared/receipts/_results');

export const saveParserTestResult = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    try {
        const body = req.body;
        if (!body || typeof body !== 'object') {
            res.status(400).json({ error: 'JSON body required' });
            return;
        }
        const runId = String(body.runId ?? '').trim();
        // Filename safety: alphanumerics, hyphen, underscore, colon (in
        // ISO timestamps) only. Reject anything else so a malicious
        // runId can't traverse paths.
        if (!runId || !/^[A-Za-z0-9_\-:.T]+$/.test(runId)) {
            res.status(400).json({ error: 'runId required, must be filename-safe' });
            return;
        }
        // Replace colons with hyphens for cross-platform filesystem
        // safety (Windows can't have ':' in filenames; harmless on
        // Linux but consistent).
        const safeName = runId.replace(/:/g, '-') + '.json';

        await fs.mkdir(RESULTS_DIR, { recursive: true });
        const fullPath = path.join(RESULTS_DIR, safeName);
        await fs.writeFile(fullPath, JSON.stringify(body, null, 2), 'utf8');
        res.status(201).json({ ok: true, path: `_results/${safeName}` });
    } catch (e) {
        next(e);
    }
};
