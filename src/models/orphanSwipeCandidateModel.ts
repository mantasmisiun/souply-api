import pool from '../config/db.js';
import type { Connection, RowDataPacket } from 'mysql2/promise';

/**
 * CRUD + queue-assembly helpers for OrphanSwipeCandidate.
 *
 * Orphan swipe feed flow:
 *   1. seedOrphanSwipeCandidates.ts populates rows (top-K per orphan) once
 *      per import cycle; the extra-queue endpoint calls refillForOrphan()
 *      individually when a specific orphan's top-K runs out.
 *   2. fetchExtraQueue() joins against StoreProductMatchVote to hide pairs
 *      a user has already voted on, and against Product/StoreProduct/
 *      StoreChain to produce a frontend-ready card shape.
 *   3. markResolvedForProductPair() is called from reevaluateMerge after
 *      promote/demote so the candidate disappears from future feeds.
 */

export type ResolvedOutcome = 'promoted' | 'demoted';

export interface OrphanSwipeCardItem {
    candidateId: number;
    orphanProductId: number;
    candidateProductId: number;
    orphanSpId: number;
    candidateSpId: number;
    similarityScore: number;
    tier: number;
    orphan: {
        name: string;
        brandName: string | null;
        amount: number | null;
        unit: string | null;
        imageUrl: string | null;
        chainName: string;
        chainLogoUrl: string | null;
    };
    candidate: {
        name: string;
        brandName: string | null;
        amount: number | null;
        unit: string | null;
        imageUrl: string | null;
        chainName: string;
        chainLogoUrl: string | null;
    };
}

/**
 * Batch upsert: seed or refresh a set of candidate rows for one or more
 * orphans. Reuses the (orphanProductId, candidateProductId) unique key so
 * reseeding does not duplicate — only updates the rank/score.
 */
export const upsertCandidates = async (
    rows: Array<{
        orphanProductId: number;
        candidateProductId: number;
        orphanSpId: number;
        candidateSpId: number;
        similarityScore: number;
        rankPos: number;
        tier: number;
    }>,
    conn?: Connection
): Promise<number> => {
    if (rows.length === 0) return 0;
    const db = conn ?? pool;

    // TOCTOU guard: these rows come from an in-memory snapshot that can go stale
    // between load and insert — a referenced StoreProduct may have been deleted
    // or merged away (e.g. a concurrent receipt delete, or this receipt's own
    // post-commit orphan consolidation). Inserting a dangling orphanSpId /
    // candidateSpId trips the FK and aborts the WHOLE batch. Drop rows whose SPs
    // no longer exist so the surviving candidates still seed. (Runs against the
    // same connection/pool, so it sees committed state.)
    const spIds = [...new Set(rows.flatMap(r => [r.orphanSpId, r.candidateSpId]))];
    const [liveSpRows]: any = await (db as any).query(
        `SELECT id FROM StoreProduct WHERE id IN (?)`,
        [spIds],
    );
    const liveSp = new Set((liveSpRows as RowDataPacket[]).map(r => Number((r as any).id)));
    const safeRows = rows.filter(r => liveSp.has(r.orphanSpId) && liveSp.has(r.candidateSpId));
    if (safeRows.length === 0) return 0;

    const values = safeRows.map(r => [
        r.orphanProductId,
        r.candidateProductId,
        r.orphanSpId,
        r.candidateSpId,
        r.similarityScore,
        r.rankPos,
        r.tier,
    ]);
    const [res]: any = await (db as any).query(
        `INSERT INTO OrphanSwipeCandidate
           (orphanProductId, candidateProductId, orphanSpId, candidateSpId,
            similarityScore, rankPos, tier)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           orphanSpId      = VALUES(orphanSpId),
           candidateSpId   = VALUES(candidateSpId),
           similarityScore = VALUES(similarityScore),
           rankPos         = VALUES(rankPos),
           tier            = VALUES(tier)`,
        [values]
    );
    return res.affectedRows as number;
};

/** Count unresolved candidates in the overall pool (used by refill watermark). */
export const countUnresolved = async (): Promise<number> => {
    const [rows]: any = await pool.query(
        `SELECT COUNT(*) AS c FROM OrphanSwipeCandidate WHERE resolved = 0`
    );
    return Number(rows[0]?.c ?? 0);
};

/**
 * Orphan ids that currently have zero unresolved candidates — the set a
 * refill pass should target. We consider a Product "still orphan" via
 * categoryId=688 for tier-1; tier-2 is reserved for later.
 */
export const findOrphansNeedingRefill = async (
    limit: number = 200
): Promise<number[]> => {
    const [rows]: any = await pool.query(
        `SELECT p.id
           FROM Product p
      LEFT JOIN OrphanSwipeCandidate osc
             ON osc.orphanProductId = p.id AND osc.resolved = 0
          WHERE p.categoryId = 688
            AND p.mergedIntoId IS NULL
            AND EXISTS (SELECT 1 FROM StoreProduct sp WHERE sp.productId = p.id)
          GROUP BY p.id
         HAVING COUNT(osc.id) = 0
          LIMIT ?`,
        [limit]
    );
    return (rows as any[]).map(r => Number(r.id));
};

/**
 * Build a ready-to-render feed of `limit` unresolved orphan↔candidate
 * pairs for `userId`. Filters out pairs the user has voted on (any vote
 * direction) by joining StoreProductMatchVote with the canonical pair
 * ordering (LEAST/GREATEST mirrors orderPair() in swipeVoteService).
 *
 * Tier-1 orphans come first, then rankPos (1..K), then similarityScore
 * descending as the tiebreaker. The top-ranked candidate per orphan is
 * always served first; that gives the orphan a fair shot at its most
 * promising match before rotating down.
 */
export const fetchExtraQueue = async (
    userId: string,
    limit: number
): Promise<OrphanSwipeCardItem[]> => {
    const [rows]: any = await pool.query(
        `SELECT osc.id                       AS candidateId,
                osc.orphanProductId          AS orphanProductId,
                osc.candidateProductId       AS candidateProductId,
                osc.orphanSpId               AS orphanSpId,
                osc.candidateSpId            AS candidateSpId,
                osc.similarityScore          AS similarityScore,
                osc.tier                     AS tier,

                op.name                      AS orphanProductName,
                osp.storeProductName         AS orphanSpName,
                osp.brandName                AS orphanBrandName,
                osp.amount                   AS orphanAmount,
                osp.unit                     AS orphanUnit,
                osp.imageUrl                 AS orphanImageUrl,
                ocsc.name                    AS orphanChainName,
                ocsc.logoUrl                 AS orphanChainLogoUrl,

                cp.name                      AS candProductName,
                csp.storeProductName         AS candSpName,
                csp.brandName                AS candBrandName,
                csp.amount                   AS candAmount,
                csp.unit                     AS candUnit,
                csp.imageUrl                 AS candImageUrl,
                ccsc.name                    AS candChainName,
                ccsc.logoUrl                 AS candChainLogoUrl
           FROM OrphanSwipeCandidate osc
           JOIN Product       op    ON op.id   = osc.orphanProductId
           JOIN StoreProduct  osp   ON osp.id  = osc.orphanSpId
           JOIN StoreChain    ocsc  ON ocsc.id = osp.chainId
           JOIN Product       cp    ON cp.id   = osc.candidateProductId
           JOIN StoreProduct  csp   ON csp.id  = osc.candidateSpId
           JOIN StoreChain    ccsc  ON ccsc.id = csp.chainId
      LEFT JOIN StoreProductMatchVote v
             ON v.userId = ?
            AND v.spIdA  = LEAST(osc.orphanSpId, osc.candidateSpId)
            AND v.spIdB  = GREATEST(osc.orphanSpId, osc.candidateSpId)
          WHERE osc.resolved = 0
            AND v.userId IS NULL
            AND op.mergedIntoId IS NULL
            AND cp.mergedIntoId IS NULL
       ORDER BY osc.tier ASC, osc.rankPos ASC, osc.similarityScore DESC, osc.id ASC
          LIMIT ?`,
        [userId, limit]
    );

    return (rows as any[]).map(r => ({
        candidateId: Number(r.candidateId),
        orphanProductId: Number(r.orphanProductId),
        candidateProductId: Number(r.candidateProductId),
        orphanSpId: Number(r.orphanSpId),
        candidateSpId: Number(r.candidateSpId),
        similarityScore: Number(r.similarityScore),
        tier: Number(r.tier),
        orphan: {
            name: r.orphanSpName ?? r.orphanProductName,
            brandName: r.orphanBrandName,
            amount: r.orphanAmount !== null ? parseFloat(r.orphanAmount) : null,
            unit: r.orphanUnit,
            imageUrl: r.orphanImageUrl,
            chainName: r.orphanChainName,
            chainLogoUrl: r.orphanChainLogoUrl,
        },
        candidate: {
            name: r.candSpName ?? r.candProductName,
            brandName: r.candBrandName,
            amount: r.candAmount !== null ? parseFloat(r.candAmount) : null,
            unit: r.candUnit,
            imageUrl: r.candImageUrl,
            chainName: r.candChainName,
            chainLogoUrl: r.candChainLogoUrl,
        },
    }));
};

/**
 * Mark every OrphanSwipeCandidate row that corresponds to the given
 * Product pair as resolved. Pair order is ambiguous at call sites (merge
 * service returns winner/loser), so we match both (orphan, candidate) and
 * (candidate, orphan) orientations. Only touches resolved=0 rows — safe to
 * call repeatedly.
 */
export const markResolvedForProductPair = async (
    productIdA: number,
    productIdB: number,
    outcome: ResolvedOutcome,
    conn?: Connection
): Promise<number> => {
    const db = conn ?? pool;
    const [res]: any = await (db as any).query(
        `UPDATE OrphanSwipeCandidate
            SET resolved        = 1,
                resolvedOutcome = ?,
                resolvedAt      = CURRENT_TIMESTAMP
          WHERE resolved = 0
            AND (
                 (orphanProductId = ? AND candidateProductId = ?)
              OR (orphanProductId = ? AND candidateProductId = ?)
            )`,
        [outcome, productIdA, productIdB, productIdB, productIdA]
    );
    return res.affectedRows as number;
};

/**
 * Map an OrphanSwipeCandidate.id to its (orphanSpId, candidateSpId) pair.
 * Used by the orphan vote endpoint to resolve the SP pair it should cast
 * a vote on without the frontend needing to know SP ids directly.
 */
export const getCandidatePair = async (
    candidateId: number
): Promise<{ orphanSpId: number; candidateSpId: number } | null> => {
    const [rows]: any = await pool.query(
        `SELECT orphanSpId, candidateSpId
           FROM OrphanSwipeCandidate
          WHERE id = ?
          LIMIT 1`,
        [candidateId]
    );
    if ((rows as any[]).length === 0) return null;
    const r = (rows as any[])[0];
    return {
        orphanSpId: Number(r.orphanSpId),
        candidateSpId: Number(r.candidateSpId),
    };
};
