import '../config/env.js';
import pool from '../config/db.js';
import { detectLoyaltyMoney } from '../../../shared/parsers/loyaltyMoney.js';

/**
 * Backfill `parsedData.footer.loyalty` on receipts parsed before loyalty money
 * was modelled.
 *
 * The text is already stored (wordsDump / rawText), so this needs no re-OCR and
 * no device: it re-runs the detector over what each receipt captured. Until it
 * runs, an old receipt shows no "MAXIMOS pinigai" row and its line sum still
 * looks unexplainably above the printed total.
 *
 *   npm run receipts:loyaltybackfill            # report only
 *   npm run receipts:loyaltybackfill -- --write # persist
 */

const write = process.argv.includes('--write');

/**
 * The receipt's own lines WITH geometry, straight from `wordsDump` (one entry per
 * OCR line: `t` = text, `y` = [top, bottom]).
 *
 * Not a greedy walk of the blob — that also picks up per-WORD entries and feeds
 * the detector fragments like "pinigų" with whatever number sits nearby. And not
 * footer.rawText alone either: some receipts keep their loyalty rows only in the
 * dump, and Rimi prints the label and the amount as two lines in the same row, so
 * the y-band is what pairs them.
 */
const collectLines = (parsed: any): { text: string; yTop?: number; yBottom?: number }[] => {
    const dump = Array.isArray(parsed?.wordsDump) ? parsed.wordsDump : [];
    if (dump.length > 0) {
        return dump
            .filter((l: any) => typeof l?.t === 'string')
            .map((l: any) => ({
                text: l.t as string,
                yTop: Array.isArray(l.y) ? Number(l.y[0]) : undefined,
                yBottom: Array.isArray(l.y) ? Number(l.y[1]) : undefined,
            }));
    }
    // Pre-wordsDump receipts: the parser's own line text, no geometry.
    const out: { text: string }[] = [];
    const push = (v: unknown) => {
        if (typeof v !== 'string') return;
        for (const line of v.split(/\r?\n/)) if (line.trim()) out.push({ text: line });
    };
    push(parsed?.footer?.rawText);
    push(parsed?.header?.rawText);
    for (const p of Array.isArray(parsed?.products) ? parsed.products : []) {
        for (const l of Array.isArray(p?.rawLines) ? p.rawLines : []) push(l);
    }
    return out;
};

const main = async () => {
    const [rows]: any = await pool.query(
        `SELECT id, parsedData FROM Receipt
          WHERE parsedData IS NOT NULL AND userDeletedAt IS NULL
            AND JSON_EXTRACT(parsedData, '$.footer.loyalty') IS NULL
          ORDER BY id ASC`);
    console.log(`${rows.length} receipt(s) without footer.loyalty`);

    let found = 0, updated = 0;
    for (const r of rows) {
        let parsed: any;
        try { parsed = JSON.parse(r.parsedData); } catch { continue; }
        if (!parsed?.footer) continue;
        const loyalty = detectLoyaltyMoney(collectLines(parsed));
        if (!loyalty) continue;
        found++;
        console.log(`  r${r.id}: ${loyalty.program} redeemed=${loyalty.redeemed} earned=${loyalty.earned} balance=${loyalty.balance}`);
        if (!write) continue;
        parsed.footer.loyalty = loyalty;
        await pool.query('UPDATE Receipt SET parsedData = ? WHERE id = ?', [JSON.stringify(parsed), r.id]);
        updated++;
    }
    console.log(`\nloyalty found on ${found} receipt(s)${write ? `, ${updated} updated` : ' (dry run — pass --write to persist)'}`);
    process.exit(0);
};

main().catch(e => { console.error(e); process.exit(1); });
