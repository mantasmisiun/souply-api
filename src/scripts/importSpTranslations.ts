/**
 * Souply 2.0 — import translated SP names into StoreProductTranslation.
 *
 * Input TSV (tab-delimited — 44 product names contain semicolons), produced
 * by the translation workflow from the prod export:
 *   spId\tname\ten\tsynonyms
 * where `en` = English translation and `synonyms` = optional |-separated
 * Lithuanian synonyms (e.g. "batatai").
 *
 * The export deduped by NAME (MIN(id) representative), so this script
 * FANS each row back out to every StoreProduct sharing that exact name.
 * IDEMPOTENT: INSERT IGNORE against uq_spt(storeProductId, lang, normalized).
 *
 * Run: npm run import:translations -- <csv-path>
 * (dev first; prod when 2.0 ships — the data is inert until the search arms read it.)
 */
import '../config/env.js';
import { readFileSync } from 'fs';
import pool from '../config/db.js';
import { normalizeForSearch } from '../utils/searchStem.js';

const run = async () => {
    const csvPath = process.argv[2];
    if (!csvPath) { console.error('Usage: npm run import:translations -- <csv-path>'); process.exit(1); }

    const lines = readFileSync(csvPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    // Header: spId\tname\ten\tsynonyms (tolerate its absence).
    const start = /^\s*\d+\t/.test(lines[0]) ? 0 : 1;

    let rows = 0, skipped = 0, fanned = 0;
    for (let i = start; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts.length < 3) { skipped++; continue; }
        const name = parts[1]?.trim();
        const en = parts[2]?.trim();
        const synonyms = (parts[3] ?? '').split('|').map((s) => s.trim()).filter(Boolean);
        if (!name || !en) { skipped++; continue; }

        // Fan out to EVERY SP sharing this exact name (export deduped by name).
        let [sps]: any = await pool.query(
            'SELECT id FROM StoreProduct WHERE storeProductName = ?', [name]);
        if (sps.length === 0) {
            // Rescue rows whose names got mangled in CSV transit (embedded
            // newlines split the export line): trust the spId directly.
            const spId = Number(parts[0]);
            if (Number.isFinite(spId) && spId > 0) {
                const [byId]: any = await pool.query('SELECT id FROM StoreProduct WHERE id = ?', [spId]);
                sps = byId;
            }
            if (sps.length === 0) { skipped++; continue; }
        }

        const values: any[] = [];
        for (const sp of sps) {
            values.push([sp.id, 'en', en, normalizeForSearch(en)]);
            for (const syn of synonyms) values.push([sp.id, 'lt', syn, normalizeForSearch(syn)]);
        }
        const [res]: any = await pool.query(
            'INSERT IGNORE INTO StoreProductTranslation (storeProductId, lang, text, normalized) VALUES ?',
            [values]);
        rows += res.affectedRows;
        fanned += sps.length;

        if ((i - start) % 2000 === 0) console.log(`[importSpTranslations] ${i - start}/${lines.length - start} names…`);
    }

    console.log(`[importSpTranslations] done: ${rows} rows inserted (fanned to ${fanned} SPs), ${skipped} lines skipped`);
    process.exit(0);
};

run().catch((e) => { console.error('[importSpTranslations] FAILED:', e); process.exit(1); });
