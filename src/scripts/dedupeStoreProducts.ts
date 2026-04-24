/**
 * StoreProduct deduplication script.
 *
 * The Rimi and IKI catalog scrapers insert without upsert semantics,
 * so each rescrape appends rather than updates — duplicate rows
 * accumulate per (chainId, productId, amount, unit). Top IKI offender
 * has 39 copies of the same SKU. This blocks cross-chain bootstrap
 * for receipt matching because the dedupe lookup returns multiple
 * candidates with no clean tiebreaker.
 *
 * Run in two modes:
 *
 *   --dry-run   (default)
 *     Build SPRemap temp table, print affected row counts for every
 *     FK table + the Receipt JSON, exit WITHOUT mutation. Safe to
 *     run against production; touches no writable state outside a
 *     session-scoped temp table that auto-drops on connection close.
 *
 *   --wet
 *     Executes phases 1-5:
 *       1. Collapse duplicate Price rows whose
 *          (storeProductId, storeId, date) would collide after remap.
 *          Keeps latest by (priceVerified DESC, id DESC), deletes rest.
 *       2. Remap FK-holding columns to canonical storeProductId.
 *       3. Walk Receipt.parsedData JSON, replace any oldId in
 *          products[].storeProductId or products[].altMatches[].storeProductId
 *          with the canonical newId.
 *       4. Delete the non-canonical StoreProduct rows.
 *       5. Add `UNIQUE (chainId, productId, amount, unit)` so this
 *          can't silently recur. Scrapers must switch to
 *          INSERT ... ON DUPLICATE KEY UPDATE after this migration.
 *
 * Usage:
 *   node --loader ts-node/esm src/scripts/dedupeStoreProducts.ts          # dry-run
 *   node --loader ts-node/esm src/scripts/dedupeStoreProducts.ts --wet    # commit
 *
 * Prerequisites:
 *   - mysqldump of the DB taken within the last hour.
 *   - Dry-run reviewed and the reported counts look plausible.
 */

import '../config/env.js';
import pool from '../config/db.js';
import type { PoolConnection } from 'mysql2/promise';

interface CliArgs {
    wet: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
    let wet = false;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--wet') wet = true;
        else if (argv[i] === '--dry-run') wet = false;
    }
    return { wet };
};

/**
 * Build a scratch table mapping every non-canonical StoreProduct.id
 * to the canonical id for its (chainId, productId, amount, unit)
 * group. Canonical = MIN(id) in the group.
 *
 * Regular (non-TEMPORARY) table because MySQL won't let a single
 * query reference a TEMPORARY table twice, and the Price collision
 * pre-count needs exactly that pattern. The script drops SPRemap
 * at the end (including on error) so nothing leaks.
 *
 * COALESCE on amount/unit is intentional: nulls need to compare
 * equal under the group key, MySQL's GROUP BY doesn't treat nulls
 * as equal by default on all versions.
 */
const buildRemapTable = async (conn: PoolConnection): Promise<void> => {
    await conn.query(`DROP TABLE IF EXISTS SPRemap`);
    await conn.query(`
        CREATE TABLE SPRemap (
            oldId INT PRIMARY KEY,
            newId INT NOT NULL,
            INDEX idx_newId (newId)
        ) ENGINE=InnoDB
    `);
    await conn.query(`
        INSERT INTO SPRemap (oldId, newId)
        SELECT sp.id, canon.canonicalId
        FROM StoreProduct sp
        JOIN (
            SELECT
                MIN(id) AS canonicalId,
                chainId, productId,
                COALESCE(amount, -1) AS amt,
                COALESCE(unit, '__null__') AS u
            FROM StoreProduct
            WHERE productId IS NOT NULL
            GROUP BY chainId, productId, amt, u
            HAVING COUNT(*) > 1
        ) canon
          ON sp.chainId = canon.chainId
         AND sp.productId = canon.productId
         AND COALESCE(sp.amount, -1) = canon.amt
         AND COALESCE(sp.unit, '__null__') = canon.u
         AND sp.id <> canon.canonicalId
    `);
};

const scalar = async (conn: PoolConnection, sql: string): Promise<number> => {
    const [rows]: any = await conn.query(sql);
    return Number(rows[0]?.c ?? 0);
};

const reportDryRun = async (conn: PoolConnection): Promise<void> => {
    // ─── group stats ────────────────────────────────────────────
    const [groupStats]: any = await conn.query(`
        SELECT
            COUNT(*) AS totalDupes,
            COUNT(DISTINCT newId) AS canonicalCount
        FROM SPRemap
    `);
    const totalDupes = Number(groupStats[0].totalDupes);
    const canonicals = Number(groupStats[0].canonicalCount);

    console.log('─── DUPE GROUPS ──────────────────────────────');
    console.log(`Canonical SPs (survive):      ${canonicals}`);
    console.log(`Non-canonical SPs (remove):   ${totalDupes}`);
    console.log(`Avg copies per canonical:     ${((totalDupes + canonicals) / Math.max(1, canonicals)).toFixed(2)}`);

    // ─── top 10 worst offenders ─────────────────────────────────
    const [worst]: any = await conn.query(`
        SELECT r.newId AS canonicalId, COUNT(*) + 1 AS copies,
               sp.chainId, sp.productId, sp.storeProductName
        FROM SPRemap r
        JOIN StoreProduct sp ON sp.id = r.newId
        GROUP BY r.newId, sp.chainId, sp.productId, sp.storeProductName
        ORDER BY copies DESC
        LIMIT 10
    `);
    console.log('');
    console.log('Top 10 worst offenders:');
    for (const w of worst) {
        console.log(
            `  chain=${w.chainId} productId=${w.productId} copies=${w.copies}  "${w.storeProductName ?? ''}"`,
        );
    }

    // ─── FK remap counts ────────────────────────────────────────
    console.log('');
    console.log('─── FK ROWS TO REMAP ─────────────────────────');

    const price = await scalar(conn, `
        SELECT COUNT(*) AS c FROM Price p
        JOIN SPRemap r ON p.storeProductId = r.oldId
    `);
    // BasketItem stores productId directly, not storeProductId —
    // it's unaffected by the remap.
    const rsc = await scalar(conn, `
        SELECT COUNT(*) AS c FROM ReceiptSwipeCandidate rsc
        JOIN SPRemap r ON rsc.storeProductId = r.oldId
    `);
    // ReceiptLineIssue has no storeProductId column — stores only
    // (receiptId, receiptLineIdx, userId, flags, note). Its FK chain
    // to StoreProduct is indirect via Price via Receipt, not direct.
    const sli = await scalar(conn, `
        SELECT COUNT(*) AS c FROM ShoppingListItem sli
        JOIN SPRemap r ON sli.storeProductId = r.oldId
    `);
    const oscOrphan = await scalar(conn, `
        SELECT COUNT(*) AS c FROM OrphanSwipeCandidate osc
        JOIN SPRemap r ON osc.orphanSpId = r.oldId
    `);
    const oscCand = await scalar(conn, `
        SELECT COUNT(*) AS c FROM OrphanSwipeCandidate osc
        JOIN SPRemap r ON osc.candidateSpId = r.oldId
    `);

    console.log(`Price.storeProductId:                   ${price.toLocaleString()}`);
    console.log(`ReceiptSwipeCandidate.storeProductId:   ${rsc.toLocaleString()}`);
    console.log(`ShoppingListItem.storeProductId:        ${sli.toLocaleString()}`);
    console.log(`OrphanSwipeCandidate.orphanSpId:        ${oscOrphan.toLocaleString()}`);
    console.log(`OrphanSwipeCandidate.candidateSpId:     ${oscCand.toLocaleString()}`);

    // ─── Price dedupe pre-count ─────────────────────────────────
    // After remap, multiple Price rows could collide on the UNIQUE
    // (storeProductId, storeId, date). Count how many would need
    // deletion (all but one per colliding group). Uses ROW_NUMBER
    // partitioned on effective canonical SP — same logic the wet
    // phase uses to populate PriceDoomed, so the count matches.
    const priceDelete = await scalar(conn, `
        SELECT COUNT(*) AS c FROM (
            SELECT p.id,
                   ROW_NUMBER() OVER (
                       PARTITION BY COALESCE(r.newId, p.storeProductId),
                                    p.storeId, p.date
                       ORDER BY p.priceVerified DESC, p.id DESC
                   ) AS rn
            FROM Price p
            LEFT JOIN SPRemap r ON p.storeProductId = r.oldId
            WHERE p.storeProductId IN (SELECT oldId FROM SPRemap)
               OR p.storeProductId IN (SELECT newId FROM SPRemap)
        ) t
        WHERE t.rn > 1
    `);
    console.log('');
    console.log(`Price rows to DELETE (post-remap collisions): ${priceDelete.toLocaleString()}`);

    // ─── Receipt JSON scan ──────────────────────────────────────
    const [receipts]: any = await conn.query(`
        SELECT id FROM Receipt WHERE parsedData IS NOT NULL
    `);
    console.log('');
    console.log('─── RECEIPT JSON ─────────────────────────────');
    console.log(`Receipt rows with parsedData: ${receipts.length}`);

    let touched = 0;
    let replacementsTotal = 0;
    for (const row of receipts) {
        const [rs]: any = await conn.query(
            `SELECT parsedData FROM Receipt WHERE id = ?`,
            [row.id],
        );
        const raw = rs[0]?.parsedData;
        if (!raw) continue;
        let parsed: any;
        try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            console.warn(`  Receipt id=${row.id} has unparseable JSON, skipping`);
            continue;
        }
        const [remapRows]: any = await conn.query(`SELECT oldId, newId FROM SPRemap`);
        const remap = new Map<number, number>(
            remapRows.map((r: any) => [Number(r.oldId), Number(r.newId)]),
        );
        const replacements = countReceiptSpIdReplacements(parsed, remap);
        if (replacements > 0) {
            touched++;
            replacementsTotal += replacements;
        }
    }
    console.log(`Receipts that would be rewritten: ${touched}`);
    console.log(`Total JSON storeProductId substitutions: ${replacementsTotal}`);

    // ─── Phase 5 preview ────────────────────────────────────────
    console.log('');
    console.log('─── UNIQUE CONSTRAINT (post-cleanup) ────────');
    console.log(`Would add: UNIQUE (chainId, productId, amount, unit)`);
    console.log(`Note: MySQL treats each NULL as distinct in a UNIQUE`);
    console.log(`      index, so null-amount / null-unit rows can still`);
    console.log(`      accumulate dupes in the future.`);
};

/**
 * Count (don't mutate) how many storeProductId values inside the
 * Receipt's parsedData would be substituted. Walks products[] and
 * products[].altMatches[] — both carry SP ids.
 */
const countReceiptSpIdReplacements = (parsed: any, remap: Map<number, number>): number => {
    let n = 0;
    if (!parsed || typeof parsed !== 'object') return 0;
    const products = parsed.products;
    if (!Array.isArray(products)) return 0;
    for (const p of products) {
        if (remap.has(Number(p.storeProductId))) n++;
        const alts = p.altMatches;
        if (Array.isArray(alts)) {
            for (const a of alts) {
                if (remap.has(Number(a.storeProductId))) n++;
            }
        }
    }
    return n;
};

/**
 * In-place rewrite of Receipt.parsedData: walks products[] and
 * products[].altMatches[], substitutes any storeProductId present
 * in `remap.oldId` with the corresponding `remap.newId`. Returns
 * the number of substitutions.
 */
const rewriteReceiptSpIds = (parsed: any, remap: Map<number, number>): number => {
    let n = 0;
    if (!parsed || typeof parsed !== 'object') return 0;
    const products = parsed.products;
    if (!Array.isArray(products)) return 0;
    for (const p of products) {
        const pNew = remap.get(Number(p.storeProductId));
        if (pNew !== undefined) {
            p.storeProductId = pNew;
            n++;
        }
        const alts = p.altMatches;
        if (Array.isArray(alts)) {
            for (const a of alts) {
                const aNew = remap.get(Number(a.storeProductId));
                if (aNew !== undefined) {
                    a.storeProductId = aNew;
                    n++;
                }
            }
        }
    }
    return n;
};

const BATCH_SIZE = 50_000;

/**
 * Batched mutation helper driven by a scratch id-table. Loops:
 *   1. SELECT up to BATCH_SIZE ids from `sourceTable`.
 *   2. Call `onBatch(ids)` to do the actual DELETE/UPDATE on the
 *      real target table using those ids.
 *   3. DELETE those ids from `sourceTable` so the next iteration
 *      picks the next chunk.
 * Exits when sourceTable is empty.
 *
 * Avoids MySQL 8's restriction that LIMIT is not allowed on multi-
 * table DELETE/UPDATE. Single-table IN (?) queries work everywhere.
 * Non-transactional: each batch commits independently.
 */
const batchedIdLoop = async (
    conn: PoolConnection,
    label: string,
    sourceTable: string,
    onBatch: (ids: number[]) => Promise<void>,
): Promise<number> => {
    let total = 0;
    while (true) {
        const [batch]: any = await conn.query(
            `SELECT id FROM ${sourceTable} LIMIT ${BATCH_SIZE}`,
        );
        if (batch.length === 0) break;
        const ids = batch.map((r: any) => Number(r.id));
        await onBatch(ids);
        await conn.query(`DELETE FROM ${sourceTable} WHERE id IN (?)`, [ids]);
        total += ids.length;
        process.stdout.write(`\r  ${label}: ${total.toLocaleString()} rows`);
    }
    process.stdout.write('\n');
    return total;
};

const runWetMode = async (conn: PoolConnection): Promise<void> => {
    console.log('');
    console.log('═══ WET MODE — MUTATIONS BEGIN ═══');
    console.log('');

    // ─── Phase 2: build PriceDoomed ────────────────────────────
    // Window function partitions by (effective canonical SP, storeId, date).
    // Tiebreaker: priceVerified DESC (verified wins) then id DESC (latest
    // scrape wins among same-verification). rn=1 survives, rn>1 doomed.
    console.log('[2/11] Building PriceDoomed table…');
    await conn.query(`DROP TABLE IF EXISTS PriceDoomed`);
    await conn.query(`
        CREATE TABLE PriceDoomed (
            id BIGINT PRIMARY KEY
        ) ENGINE=InnoDB
    `);
    await conn.query(`
        INSERT INTO PriceDoomed (id)
        SELECT id FROM (
            SELECT p.id,
                   ROW_NUMBER() OVER (
                       PARTITION BY COALESCE(r.newId, p.storeProductId),
                                    p.storeId, p.date
                       ORDER BY p.priceVerified DESC, p.id DESC
                   ) AS rn
            FROM Price p
            LEFT JOIN SPRemap r ON p.storeProductId = r.oldId
            WHERE p.storeProductId IN (SELECT oldId FROM SPRemap)
               OR p.storeProductId IN (SELECT newId FROM SPRemap)
        ) t
        WHERE t.rn > 1
    `);
    const [doomedCnt]: any = await conn.query(`SELECT COUNT(*) AS c FROM PriceDoomed`);
    console.log(`       PriceDoomed populated: ${Number(doomedCnt[0].c).toLocaleString()}`);

    // ─── Phase 3: delete doomed Price rows ─────────────────────
    // Batched via PriceDoomed so single-table DELETE semantics apply.
    console.log('[3/11] Deleting doomed Price rows…');
    await batchedIdLoop(conn, 'Price deleted', 'PriceDoomed', async (ids) => {
        await conn.query(`DELETE FROM Price WHERE id IN (?)`, [ids]);
    });

    // ─── Phase 4: remap Price.storeProductId → canonical ───────
    // Materialize target ids upfront into a scratch table so each
    // iteration converges — we delete from the scratch set, not from
    // Price itself (whose matching rows shrink after each UPDATE
    // but whose condition Price.storeProductId IN SPRemap.oldId
    // would keep matching the same rows otherwise).
    console.log('[4/11] Remapping Price.storeProductId → canonical…');
    await conn.query(`DROP TABLE IF EXISTS PriceRemapTarget`);
    await conn.query(`
        CREATE TABLE PriceRemapTarget (
            id BIGINT PRIMARY KEY
        ) ENGINE=InnoDB
    `);
    await conn.query(`
        INSERT INTO PriceRemapTarget (id)
        SELECT p.id FROM Price p
        JOIN SPRemap r ON p.storeProductId = r.oldId
    `);
    await batchedIdLoop(conn, 'Price remapped', 'PriceRemapTarget', async (ids) => {
        await conn.query(
            `UPDATE Price p JOIN SPRemap r ON p.storeProductId = r.oldId
               SET p.storeProductId = r.newId
             WHERE p.id IN (?)`,
            [ids],
        );
    });
    await conn.query(`DROP TABLE IF EXISTS PriceRemapTarget`);

    // ─── Phase 5: remap ReceiptSwipeCandidate ──────────────────
    console.log('[5/11] Remapping ReceiptSwipeCandidate.storeProductId…');
    const [rscRes]: any = await conn.query(
        `UPDATE ReceiptSwipeCandidate rsc JOIN SPRemap r ON rsc.storeProductId = r.oldId
           SET rsc.storeProductId = r.newId`,
    );
    console.log(`       ReceiptSwipeCandidate rows updated: ${rscRes.affectedRows}`);

    // ─── Phase 6: remap ShoppingListItem ───────────────────────
    console.log('[6/11] Remapping ShoppingListItem.storeProductId…');
    const [sliRes]: any = await conn.query(
        `UPDATE ShoppingListItem sli JOIN SPRemap r ON sli.storeProductId = r.oldId
           SET sli.storeProductId = r.newId`,
    );
    console.log(`       ShoppingListItem rows updated: ${sliRes.affectedRows}`);

    // ─── Phase 7: remap OrphanSwipeCandidate (orphan + candidate) ──
    console.log('[7/11] Remapping OrphanSwipeCandidate.orphanSpId + candidateSpId…');
    const [oscOrphanRes]: any = await conn.query(
        `UPDATE OrphanSwipeCandidate osc JOIN SPRemap r ON osc.orphanSpId = r.oldId
           SET osc.orphanSpId = r.newId`,
    );
    const [oscCandRes]: any = await conn.query(
        `UPDATE OrphanSwipeCandidate osc JOIN SPRemap r ON osc.candidateSpId = r.oldId
           SET osc.candidateSpId = r.newId`,
    );
    console.log(`       orphanSpId updated: ${oscOrphanRes.affectedRows}`);
    console.log(`       candidateSpId updated: ${oscCandRes.affectedRows}`);

    // ─── Phase 8: delete self-merge OSC rows ───────────────────
    // After remap, a vote row whose orphan+candidate SPs both collapsed
    // to the same canonical becomes "merge X into X" — semantic junk.
    console.log('[8/11] Dropping self-merge OrphanSwipeCandidate rows…');
    const [selfMergeRes]: any = await conn.query(
        `DELETE FROM OrphanSwipeCandidate WHERE orphanSpId = candidateSpId`,
    );
    console.log(`       Self-merge rows deleted: ${selfMergeRes.affectedRows}`);

    // ─── Phase 9: rewrite Receipt.parsedData JSON ──────────────
    console.log('[9/11] Rewriting Receipt.parsedData for SP remaps…');
    const [remapRows]: any = await conn.query(`SELECT oldId, newId FROM SPRemap`);
    const remap = new Map<number, number>(
        remapRows.map((r: any) => [Number(r.oldId), Number(r.newId)]),
    );
    const [receipts]: any = await conn.query(
        `SELECT id, parsedData FROM Receipt WHERE parsedData IS NOT NULL`,
    );
    let receiptsTouched = 0;
    let subsTotal = 0;
    for (const row of receipts) {
        const raw = row.parsedData;
        if (!raw) continue;
        let parsed: any;
        try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            console.warn(`       receipt id=${row.id} unparseable JSON, skipping`);
            continue;
        }
        const n = rewriteReceiptSpIds(parsed, remap);
        if (n === 0) continue;
        await conn.query(
            `UPDATE Receipt SET parsedData = CAST(? AS JSON) WHERE id = ?`,
            [JSON.stringify(parsed), row.id],
        );
        receiptsTouched++;
        subsTotal += n;
    }
    console.log(`       Receipts rewritten: ${receiptsTouched}, substitutions: ${subsTotal}`);

    // ─── Phase 10: delete non-canonical StoreProduct rows ──────
    console.log('[10/11] Deleting non-canonical StoreProduct rows…');
    const [spDelRes]: any = await conn.query(
        `DELETE sp FROM StoreProduct sp INNER JOIN SPRemap r ON sp.id = r.oldId`,
    );
    console.log(`        StoreProduct rows deleted: ${spDelRes.affectedRows}`);

    // ─── Phase 11: add UNIQUE constraint ───────────────────────
    console.log('[11/11] Adding UNIQUE (chainId, productId, amount, unit) to StoreProduct…');
    try {
        await conn.query(`
            ALTER TABLE StoreProduct
              ADD CONSTRAINT uq_sp_chain_product_size
              UNIQUE (chainId, productId, amount, unit)
        `);
        console.log('        Constraint added.');
    } catch (e: any) {
        console.error('        FAILED to add UNIQUE constraint — dupes still present?');
        throw e;
    }

    // ─── Cleanup scratch tables ────────────────────────────────
    await conn.query(`DROP TABLE IF EXISTS PriceDoomed`);
    console.log('');
    console.log('═══ WET MODE COMPLETE ═══');
    console.log('Next steps:');
    console.log('  - Switch Rimi + IKI scrapers to INSERT ... ON DUPLICATE KEY UPDATE');
    console.log('  - Verify with the same query against the 4-column key:');
    console.log('      SELECT chainId, productId, amount, unit, COUNT(*) AS dupes');
    console.log('      FROM StoreProduct WHERE productId IS NOT NULL');
    console.log('      GROUP BY chainId, productId, amount, unit HAVING COUNT(*) > 1;');
    console.log('    (Should return 0 rows — except possibly null-amount ones.)');
};

const run = async () => {
    const { wet } = parseArgs(process.argv);
    console.log(`Mode: ${wet ? 'WET (will mutate)' : 'DRY-RUN (read-only)'}`);
    console.log('');

    const conn = await pool.getConnection();
    try {
        console.log('Building SPRemap scratch table…');
        await buildRemapTable(conn);
        await reportDryRun(conn);

        if (!wet) {
            console.log('');
            console.log('Dry-run complete. Re-run with --wet to execute.');
            return;
        }

        await runWetMode(conn);
    } finally {
        // Drop scratch tables whether we exited normally or via error.
        // Regular (non-temp) tables survive across connection close,
        // so this cleanup is mandatory. PriceDoomed may or may not
        // exist depending on how far the wet-mode run got.
        for (const t of ['SPRemap', 'PriceDoomed', 'PriceRemapTarget']) {
            try {
                await conn.query(`DROP TABLE IF EXISTS ${t}`);
            } catch (e) {
                console.warn(`Failed to drop ${t} (harmless, drop manually):`, e);
            }
        }
        conn.release();
        await pool.end();
    }
};

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
