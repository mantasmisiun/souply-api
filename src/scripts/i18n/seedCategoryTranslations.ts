/**
 * Seed CategoryTranslation rows from `categories-{locale}.json`.
 *
 * - Creates the `CategoryTranslation` table if it doesn't exist (acts as
 *   a one-shot migration so there's no separate migrations infra).
 * - Reads `categories-en.json` (and any other locales added later) and
 *   upserts one row per (categoryId, locale).
 * - Idempotent — re-running refreshes translations without duplicating.
 * - Skips IDs that don't exist in `Category` and reports them at the end
 *   instead of failing; new categories that appear later just need a
 *   JSON entry + a re-run.
 *
 * Usage:
 *   npx tsx src/scripts/i18n/seedCategoryTranslations.ts
 *   npx tsx src/scripts/i18n/seedCategoryTranslations.ts --locale en
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import '../../config/env.js';
import pool from '../../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** All locales we ship translations for. Add a row here + create the
 *  matching JSON when a new language goes live. */
const LOCALES_SHIPPING = ['en'] as const;

interface CliArgs {
    locales: string[];
}

function parseArgs(argv: string[]): CliArgs {
    const out: CliArgs = { locales: [...LOCALES_SHIPPING] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--locale' && argv[i + 1]) {
            out.locales = [argv[i + 1]];
            i++;
        }
    }
    return out;
}

async function ensureTable(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS CategoryTranslation (
            categoryId INT NOT NULL,
            locale VARCHAR(8) NOT NULL,
            name VARCHAR(255) NOT NULL,
            PRIMARY KEY (categoryId, locale),
            INDEX idx_locale (locale),
            CONSTRAINT fk_category_translation_category
                FOREIGN KEY (categoryId) REFERENCES Category(id)
                ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function fetchCategoryIds(): Promise<Set<number>> {
    const [rows]: any = await pool.query(`SELECT id FROM Category`);
    return new Set((rows as { id: number }[]).map(r => Number(r.id)));
}

async function seedLocale(locale: string): Promise<void> {
    const filePath = path.join(__dirname, `categories-${locale}.json`);
    let raw: string;
    try {
        raw = await readFile(filePath, 'utf-8');
    } catch (e) {
        console.error(`[seedCategoryTranslations] missing file: ${filePath}`);
        return;
    }

    const map = JSON.parse(raw) as Record<string, string>;
    const validIds = await fetchCategoryIds();

    const rows: Array<[number, string, string]> = [];
    const missingInDb: number[] = [];
    const missingInJson: number[] = [];

    for (const [idStr, name] of Object.entries(map)) {
        const id = Number(idStr);
        if (!Number.isFinite(id)) continue;
        if (!validIds.has(id)) {
            missingInDb.push(id);
            continue;
        }
        rows.push([id, locale, String(name).trim()]);
    }

    for (const id of validIds) {
        if (!(String(id) in map)) missingInJson.push(id);
    }

    if (rows.length === 0) {
        console.warn(`[seedCategoryTranslations] no rows to insert for ${locale}`);
        return;
    }

    // INSERT ... ON DUPLICATE KEY UPDATE so re-running refreshes without
    // duplicating. Single multi-row INSERT for speed.
    const placeholders = rows.map(() => '(?, ?, ?)').join(', ');
    const flat = rows.flat();
    const [result]: any = await pool.query(
        `INSERT INTO CategoryTranslation (categoryId, locale, name)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        flat,
    );

    console.log(`[seedCategoryTranslations] locale=${locale}: ${rows.length} rows processed (affected=${result?.affectedRows ?? '?'})`);
    if (missingInDb.length > 0) {
        console.warn(`  JSON has ${missingInDb.length} id(s) not in Category table: ${missingInDb.slice(0, 10).join(', ')}${missingInDb.length > 10 ? '…' : ''}`);
    }
    if (missingInJson.length > 0) {
        console.warn(`  Category table has ${missingInJson.length} id(s) without ${locale} translation: ${missingInJson.slice(0, 10).join(', ')}${missingInJson.length > 10 ? '…' : ''}`);
    }
}

async function main(): Promise<void> {
    const { locales } = parseArgs(process.argv.slice(2));
    console.log(`[seedCategoryTranslations] target locales: ${locales.join(', ')}`);
    await ensureTable();
    for (const locale of locales) {
        await seedLocale(locale);
    }
    await pool.end();
    console.log('[seedCategoryTranslations] done');
}

main().catch((e) => {
    console.error('[seedCategoryTranslations] failed:', e);
    process.exit(1);
});
