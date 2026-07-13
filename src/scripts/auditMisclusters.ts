/**
 * READ-ONLY audit — finds Products whose StoreProducts do NOT all share a
 * common significant token. That's the fingerprint of a loose-threshold
 * mis-cluster like Lidl "Airanas" pulled into "Šafranas KOTANYI" (productId
 * 5125): the saffron SPs share {safranas, kotanyi} but the Airanas SP shares
 * nothing with them.
 *
 * Makes NO writes — it only prints a report of review candidates. Run against
 * the target DB with the usual env (e.g. through the DBeaver tunnel):
 *   DB_HOST=127.0.0.1 DB_PORT=<tunnel> DB_USER=souply_app DB_PASSWORD=… \
 *   DB_NAME=souply_production npx tsx src/scripts/auditMisclusters.ts
 */
import pool from '../config/db.js';
import { significantTokens } from '../utils/nameMatchGate.js';

async function main() {
    const [rows]: any = await pool.query(
        `SELECT sp.productId, p.name AS productName, sp.id AS spId, sp.storeProductName
           FROM StoreProduct sp
           JOIN Product p ON p.id = sp.productId
          WHERE p.mergedIntoId IS NULL
          ORDER BY sp.productId`,
    );

    const byProduct = new Map<number, { name: string; sps: { id: number; name: string }[] }>();
    for (const r of rows as any[]) {
        const pid = Number(r.productId);
        if (!byProduct.has(pid)) byProduct.set(pid, { name: String(r.productName ?? ''), sps: [] });
        byProduct.get(pid)!.sps.push({ id: Number(r.spId), name: String(r.storeProductName ?? '') });
    }

    let flagged = 0;
    for (const [pid, { name, sps }] of byProduct) {
        if (sps.length < 2) continue;
        const usable = sps
            .map(sp => ({ sp, tokens: new Set(significantTokens(sp.name)) }))
            .filter(x => x.tokens.size > 0);
        if (usable.length < 2) continue;

        // Is there a significant token present in EVERY usable SP?
        const [first, ...rest] = usable;
        const common = [...first.tokens].filter(t => rest.every(x => x.tokens.has(t)));
        if (common.length > 0) continue;

        flagged++;
        console.log(`\n⚠ product ${pid} "${name}" — no token shared by all StoreProducts:`);
        for (const sp of sps) {
            console.log(`    [sp ${sp.id}] ${sp.name}  → {${significantTokens(sp.name).join(', ')}}`);
        }
    }

    console.log(`\nDone. ${flagged} product(s) with no common anchor token — review for mis-clustering.`);
    await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
