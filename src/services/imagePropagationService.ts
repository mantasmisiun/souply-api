import pool from '../config/db.js';

/**
 * Auto-fills missing `StoreProduct.imageUrl` from cross-chain siblings
 * on the same `Product`. Runs nightly (see scrapers/scheduler.ts) so
 * any newly-scraped chain that now has an image for a Product flows
 * its image to the other chains' rows automatically.
 *
 * Logged per copy in `ImagePropagationLog` so we can:
 *   1. Surface the auto-decision inline in the admin image card
 *      ("Auto-set from {sourceChain} on {date}, change?").
 *   2. Bulk-revert if a wrong-Product merge propagated a bad image
 *      across chains.
 *
 * Why same-Product only (not BaseProductLink): a same-Product cluster
 * is the result of an `identical` Wilson-merge, which means at least
 * 3 votes confirmed they're the SAME product — high confidence. A
 * BaseProductLink (similar variant) might differ visually (Pienas
 * 2,5 % vs Pienas 3,5 %) so those candidates are surfaced to the
 * admin instead of auto-applied.
 *
 * Idempotent: running it twice in a row picks up zero new candidates
 * the second time because every SP either now has an image, or its
 * cluster still has no imaged sibling.
 */

export interface PropagationResult {
    candidatesFound: number;
    propagated: number;
    skipped: number;
    errors: number;
}

/**
 * Single pass over every Product cluster that has at least one
 * missing-image SP and at least one imaged SP. Copies the imaged
 * sibling's URL to all missing-image siblings in the same cluster.
 *
 * Tie-breaker when multiple imaged siblings exist: prefer the one
 * with the lowest `id` (oldest, most-stable historical reference).
 * Could change to "most recent price update" later if image staleness
 * becomes a problem.
 */
export async function propagateCrossChainImages(): Promise<PropagationResult> {
    const result: PropagationResult = {
        candidatesFound: 0,
        propagated: 0,
        skipped: 0,
        errors: 0,
    };

    // Pull all (missingSpId, sourceSpId, sourceImageUrl) triples in one
    // query. The JOIN ensures every emitted row has a non-null source.
    const [rows]: any = await pool.query(
        `SELECT missing.id AS missingSpId,
                (SELECT MIN(src.id)
                   FROM StoreProduct src
                  WHERE src.productId = missing.productId
                    AND src.id != missing.id
                    AND src.imageUrl IS NOT NULL) AS sourceSpId
           FROM StoreProduct missing
          WHERE missing.imageUrl IS NULL
            AND EXISTS (
                SELECT 1 FROM StoreProduct src
                 WHERE src.productId = missing.productId
                   AND src.id != missing.id
                   AND src.imageUrl IS NOT NULL
            )`,
    );

    result.candidatesFound = (rows as any[]).length;

    if (result.candidatesFound === 0) return result;

    // Fetch the source images in one batch keyed by sourceSpId.
    const sourceSpIds = [...new Set((rows as any[]).map(r => Number(r.sourceSpId)))];
    const [sourceRows]: any = await pool.query(
        `SELECT id, imageUrl FROM StoreProduct WHERE id IN (?)`,
        [sourceSpIds],
    );
    const sourceUrlBySpId = new Map<number, string>();
    for (const r of sourceRows as any[]) {
        if (r.imageUrl) sourceUrlBySpId.set(Number(r.id), String(r.imageUrl));
    }

    // Apply each propagation inside its own try so one bad row doesn't
    // abort the whole pass. The double UPDATE-then-log is intentionally
    // not transactional per row — losing a log row would leave an
    // un-traceable image change, but the image itself is correct and
    // we'd rather propagate than not.
    for (const row of rows as any[]) {
        const missingSpId = Number(row.missingSpId);
        const sourceSpId = Number(row.sourceSpId);
        const toImageUrl = sourceUrlBySpId.get(sourceSpId);
        if (!toImageUrl) {
            result.skipped++;
            continue;
        }
        try {
            const [updateRes]: any = await pool.query(
                `UPDATE StoreProduct SET imageUrl = ? WHERE id = ? AND imageUrl IS NULL`,
                [toImageUrl, missingSpId],
            );
            // affectedRows = 0 means the SP got an image from another
            // path between query and write — skip gracefully.
            if (updateRes.affectedRows === 0) {
                result.skipped++;
                continue;
            }
            await pool.query(
                `INSERT INTO ImagePropagationLog
                    (spId, sourceType, sourceSpId, fromImageUrl, toImageUrl, actor)
                 VALUES (?, 'cross_chain_sibling', ?, NULL, ?, 'auto')`,
                [missingSpId, sourceSpId, toImageUrl],
            );
            result.propagated++;
        } catch (e: any) {
            console.error(`[imagePropagation] failed for spId=${missingSpId}:`, e?.message);
            result.errors++;
        }
    }

    return result;
}
