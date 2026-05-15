import '../config/env.js';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import pool from '../config/db.js';
import { parseAmountFromName, amountsAgree } from '../utils/nameAmountParser.js';

/**
 * One-shot diagnostic — runs `parseAmountFromName` against every
 * StoreProduct in the DB and reports how the population breaks down:
 *
 *   matched          — parser hit AND agrees with stored DB values (green)
 *   mismatch         — parser hit, disagrees with DB (admin queue candidates)
 *   unparseable      — name has no <num><unit> pattern (skipped silently)
 *
 * Also dumps the mismatch rows to `mismatches.csv` so we can spot-
 * check the parser's precision before letting admins act on them.
 *
 * Run:
 *   npx tsx src/scripts/scanAmountCoverage.ts
 */

interface Counts {
    matched: number;
    mismatch: number;
    unparseable: number;
}

(async () => {
    console.log('[scanAmountCoverage] starting');

    const [rows]: any = await pool.query(
        `SELECT sp.id            AS spId,
                sp.storeProductName AS spName,
                p.name           AS productName,
                sp.amount        AS storedAmount,
                sp.unit          AS storedUnit,
                sp.isWeighable   AS storedIsWeighable,
                sp.chainId,
                sc.name          AS chainName
           FROM StoreProduct sp
           JOIN Product p ON p.id = sp.productId
           LEFT JOIN StoreChain sc ON sc.id = sp.chainId`,
    );

    const total = (rows as any[]).length;
    console.log(`[scanAmountCoverage] ${total} SPs to scan`);

    const overall: Counts = { matched: 0, mismatch: 0, unparseable: 0 };
    const byChain = new Map<string, Counts>();
    const byUnit = new Map<string, number>();
    const mismatchCsvRows: string[] = [
        // CSV header
        'spId,chainName,name,parsedAmount,parsedUnit,storedAmount,storedUnit,matchedSubstring',
    ];

    const bump = (chain: string, key: keyof Counts) => {
        let c = byChain.get(chain);
        if (!c) { c = { matched: 0, mismatch: 0, unparseable: 0 }; byChain.set(chain, c); }
        c[key]++;
    };

    for (const r of rows as any[]) {
        // Pick the SP-specific override when present, fall back to the
        // Product's canonical name — same precedence the rest of the
        // app uses for display.
        const name = String(r.spName ?? r.productName ?? '');
        const chain = String(r.chainName ?? '(no chain)');
        const parsed = parseAmountFromName(name);

        if (!parsed) {
            overall.unparseable++;
            bump(chain, 'unparseable');
            continue;
        }

        byUnit.set(parsed.unit, (byUnit.get(parsed.unit) ?? 0) + 1);

        const storedAmountNum = r.storedAmount !== null && r.storedAmount !== undefined
            ? parseFloat(String(r.storedAmount))
            : null;
        const agrees = amountsAgree(parsed, {
            amount: storedAmountNum,
            unit: r.storedUnit ?? null,
        });

        if (agrees) {
            overall.matched++;
            bump(chain, 'matched');
        } else {
            overall.mismatch++;
            bump(chain, 'mismatch');
            mismatchCsvRows.push([
                r.spId,
                escapeCsv(chain),
                escapeCsv(name),
                parsed.amount,
                parsed.unit,
                storedAmountNum ?? '',
                r.storedUnit ?? '',
                escapeCsv(parsed.matched),
            ].join(','));
        }
    }

    const outPath = resolve(process.cwd(), 'mismatches.csv');
    await fs.writeFile(outPath, mismatchCsvRows.join('\n'), 'utf8');

    // Headline summary
    console.log('');
    console.log(`[scanAmountCoverage] ${total} SPs scanned`);
    console.log(`  ✓ matched DB (no action needed): ${overall.matched.toLocaleString()}`);
    console.log(`  ⚠ mismatch (queue these):        ${overall.mismatch.toLocaleString()}`);
    console.log(`  ? unparseable name (skip):       ${overall.unparseable.toLocaleString()}`);

    // Unit breakdown
    console.log('');
    console.log('By unit detected:');
    for (const [unit, count] of [...byUnit.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${unit.padEnd(4)} ${count.toLocaleString()}`);
    }

    // Per-chain mismatch ranking (for impact-by-chain visibility)
    console.log('');
    console.log('Mismatches by chain:');
    const chainRanked = [...byChain.entries()].sort((a, b) => b[1].mismatch - a[1].mismatch);
    for (const [chain, c] of chainRanked) {
        if (c.mismatch === 0) continue;
        console.log(`  ${chain.padEnd(28)} ${c.mismatch.toLocaleString()} mismatches  (matched ${c.matched.toLocaleString()}, unparseable ${c.unparseable.toLocaleString()})`);
    }

    console.log('');
    console.log(`[scanAmountCoverage] mismatch CSV → ${outPath}`);
})()
    .catch(e => {
        console.error('[scanAmountCoverage] failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await pool.end();
    });

function escapeCsv(s: string | number): string {
    const v = String(s);
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
}
