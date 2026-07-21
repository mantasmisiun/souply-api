/**
 * DEMO/BACKFILL: replay REAL Lidl receipts from the OCR corpus through the
 * code-evidence service. Extracts `<code> <printed name>` lines from each
 * receipts/_logs/lidl/<receipt>/rawLines.json (actual scanned receipts — no
 * synthetic data) and records each sighting; K=2 promotions fire exactly as
 * they would live. Safe to re-run (evidence upserts, promotions idempotent).
 *
 *   npx tsx src/scripts/replayReceiptCodes.ts [--limit N]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from '../config/db.js';
import { recordCodeEvidence } from '../services/codeEvidenceService.js';

const LIDL_CHAIN_ID = 5;
const CORPUS = '/home/mantas/Documents/Projects/souply-api/receipts/_logs/lidl';
// "7600526 Švyturys Ekstra a.5,2% 4x0,568" → code + name (name = up to a
// trailing qty/price tail if present; keep it simple — parseSize cleans later).
const LINE_RE = /^(\d{7})\s+(\D[^\d].*?)(?:\s+[\d,.]+\s*(?:x|X)?\s*[\d,.]*)?$/;

async function main() {
    const limitArg = process.argv.indexOf('--limit');
    const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : null;
    const dirs = fs.readdirSync(CORPUS).filter(d => fs.existsSync(path.join(CORPUS, d, 'rawLines.json')));
    console.log(`corpus receipts: ${dirs.length}${LIMIT ? ` (limit ${LIMIT})` : ''}`);

    let sightings = 0, promotedMint = 0, promotedExisting = 0;
    const promotions: string[] = [];
    for (const d of (LIMIT ? dirs.slice(0, LIMIT) : dirs)) {
        let lines: any;
        try { lines = JSON.parse(fs.readFileSync(path.join(CORPUS, d, 'rawLines.json'), 'utf8')); } catch { continue; }
        const texts: string[] = (Array.isArray(lines) ? lines : lines.lines ?? [])
            .map((l: any) => (typeof l === 'string' ? l : l?.text ?? '')).filter(Boolean);
        for (const t of texts) {
            const m = t.trim().match(LINE_RE);
            if (!m) continue;
            const name = m[2].trim();
            if (name.length < 4 || /kvitas|čekis|tarpin/i.test(name)) continue;
            // Lidl deposit noise (Užstatas / Užstato grąžinimas) — never product codes.
            if (/u[žz]stat/i.test(name)) continue;
            const res = await recordCodeEvidence(LIDL_CHAIN_ID, m[1], name);
            sightings++;
            if (res.action === 'promoted_minted') { promotedMint++; promotions.push(`MINT  #${res.code} → "${res.spName}" (sp ${res.spId})`); }
            if (res.action === 'promoted_existing') { promotedExisting++; promotions.push(`JOIN  #${res.code} → "${res.spName}" (sp ${res.spId})`); }
        }
    }
    console.log(`sightings recorded: ${sightings} | umbrella promotions: ${promotedMint + promotedExisting} (${promotedExisting} joined existing SP, ${promotedMint} minted)`);
    promotions.forEach(p => console.log('  ' + p));
    await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
