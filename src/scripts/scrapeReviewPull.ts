/**
 * Pull FLAGGED + UNRESOLVED products from a scrape-review day — the "hey,
 * pull chain X day Y" command. On dev the agent runs it directly; on prod
 * run it on the VM and paste the output.
 *
 *   npx tsx src/scripts/scrapeReviewPull.ts <chainId|lidl|rimi|iki|barbora|maxima|norfa> <YYYY-MM-DD> [--flagged-only]
 */
import 'dotenv/config';
import pool from '../config/db.js';

const CHAINS: Record<string, number> = { maxima: 1, barbora: 1, rimi: 2, iki: 3, norfa: 4, lidl: 5 };

async function main() {
    const arg = String(process.argv[2] ?? '').toLowerCase();
    const chainId = Number(arg) || CHAINS[arg];
    const date = String(process.argv[3] ?? '');
    const flaggedOnly = process.argv.includes('--flagged-only');
    if (!chainId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error('usage: scrapeReviewPull <chain> <YYYY-MM-DD> [--flagged-only]');
        process.exit(1);
    }

    const [rows]: any = await pool.query(
        `SELECT p.id AS productId, p.name AS productName, c.name AS category,
                v.status, v.note,
                (SELECT GROUP_CONCAT(CONCAT(sp.chainId, ':', sp.id, ' "', sp.storeProductName, '" ',
                        COALESCE(sp.amount, ''), COALESCE(sp.unit, '')) SEPARATOR ' | ')
                   FROM StoreProduct sp WHERE sp.productId = p.id) AS listings,
                (SELECT CONCAT(pr2.price, ' → ', COALESCE(pr2.promoPrice, '-'),
                        ' [', COALESCE(DATE_FORMAT(pr2.validFrom, '%m-%d'), '·'), '..',
                        COALESCE(DATE_FORMAT(pr2.promoEnd, '%m-%d'), '·'), ']')
                   FROM Price pr2 JOIN StoreProduct sp2 ON sp2.id = pr2.storeProductId
                  WHERE sp2.productId = p.id AND sp2.chainId = ?
                  ORDER BY pr2.id DESC LIMIT 1) AS latestChainPrice
           FROM Product p
           JOIN Category c ON c.id = p.categoryId
           LEFT JOIN AdminScrapeVerification v
                  ON v.chainId = ? AND v.scrapeDate = ? AND v.productId = p.id
          WHERE p.mergedIntoId IS NULL
            AND EXISTS (SELECT 1 FROM StoreProduct spc JOIN Price pr ON pr.storeProductId = spc.id
                        WHERE spc.productId = p.id AND spc.chainId = ?
                          AND pr.date >= ? AND pr.date < DATE_ADD(?, INTERVAL 1 DAY))
            AND ${flaggedOnly ? "v.status = 'flagged'" : "(v.status IS NULL OR v.status = 'flagged')"}
          ORDER BY (v.status = 'flagged') DESC, p.name`,
        [chainId, chainId, date, chainId, date, date],
    );
    console.log(`chain ${chainId} · ${date} · ${flaggedOnly ? 'FLAGGED' : 'flagged + unresolved'}: ${(rows as any[]).length} products\n`);
    for (const r of rows as any[]) {
        const tag = r.status === 'flagged' ? '🚩' : '·';
        console.log(`${tag} [${r.productId}] ${r.productName}  (${r.category})`);
        if (r.note) console.log(`     note: ${r.note}`);
        console.log(`     chain price: ${r.latestChainPrice ?? '—'}`);
        console.log(`     listings: ${r.listings ?? '—'}\n`);
    }
    await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
