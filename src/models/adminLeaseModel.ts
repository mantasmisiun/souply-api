import pool from '../config/db.js';

/**
 * Lease lifecycle (same semantics as SQS visibility timeout, Sidekiq
 * reservation, Scale AI task assignment):
 *
 *   PENDING    → no row, or row with abandonedAt/completedAt/expired
 *   LEASED     → row exists, all three null-checks pass, expiresAt > NOW()
 *   DONE       → completedAt set (by adopt/remove/skip/reject handlers)
 *   ABANDONED  → abandonedAt set (admin tapped release, or sweeper hit it)
 *
 * One active lease per (spId, queueKind). Multiple admins working at
 * once never see each other's leased cards because all queue queries
 * filter out SPs that have an active lease.
 */

export const LEASE_DURATION_HOURS = 2;
export type QueueKind = 'image';

export interface ActiveLease {
    id: number;
    spId: number;
    expiresAt: string;
    leasedAt: string;
}

/**
 * Returns the admin's currently active batch — leases that are not
 * completed, not abandoned, not expired. Used by both the tab-entry
 * "what's in my batch?" call and as the source of truth that the
 * action endpoints validate against.
 */
export async function getActiveLeasesForAdmin(
    adminId: string,
    queueKind: QueueKind,
): Promise<ActiveLease[]> {
    const [rows]: any = await pool.query(
        `SELECT id, spId, expiresAt, leasedAt
           FROM AdminCardLease
          WHERE leasedTo = ?
            AND queueKind = ?
            AND completedAt IS NULL
            AND abandonedAt IS NULL
            AND expiresAt > NOW()
          ORDER BY id ASC`,
        [adminId, queueKind],
    );
    return (rows as any[]).map(r => ({
        id: Number(r.id),
        spId: Number(r.spId),
        expiresAt: String(r.expiresAt),
        leasedAt: String(r.leasedAt),
    }));
}

/**
 * Claim a new batch atomically. Within one transaction:
 *   1. Pick the top N eligible spIds (filtered by `excludedSpIdsSql` —
 *      excludes anything already actively leased).
 *   2. INSERT one lease row per spId.
 *   3. Return those rows.
 *
 * The `pickSql` callback is provided by the per-queue model so each
 * queue type (image, amount, name, etc.) can plug in its own ranking
 * without this generic helper knowing the details.
 */
export async function claimBatch(args: {
    adminId: string;
    queueKind: QueueKind;
    batchSize: number;
    /** SQL fragment + params that selects `spId` ordered by priority,
     *  WITHOUT any LIMIT — claimBatch adds it. Must reference
     *  AdminCardLease via NOT EXISTS to skip active leases. */
    pickSql: { sql: string; params: any[] };
}): Promise<ActiveLease[]> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Step 1: pick eligible SPs the caller hasn't already claimed.
        // The NOT EXISTS against the lease table guarantees concurrent
        // claim-batch calls from two admins can't both grab the same SP.
        const [pickRows]: any = await conn.query(
            args.pickSql.sql + ' LIMIT ?',
            [...args.pickSql.params, args.batchSize],
        );
        const spIds = (pickRows as any[]).map(r => Number(r.spId));
        if (spIds.length === 0) {
            await conn.commit();
            return [];
        }

        // Step 2: INSERT leases. Use INSERT IGNORE to defang a race where
        // two admins land here within the same MySQL tick — the unique
        // active-lease filter is enforced by the picker, but belt-and-
        // braces never hurts.
        const placeholders = spIds.map(() => '(?, ?, ?, NOW(), NOW() + INTERVAL ? HOUR)').join(',');
        const values: any[] = [];
        for (const spId of spIds) {
            values.push(spId, args.adminId, args.queueKind, LEASE_DURATION_HOURS);
        }
        await conn.query(
            `INSERT INTO AdminCardLease
                (spId, leasedTo, queueKind, leasedAt, expiresAt)
             VALUES ${placeholders}`,
            values,
        );

        // Step 3: fetch the rows we just created (in their insert order).
        const [createdRows]: any = await conn.query(
            `SELECT id, spId, expiresAt, leasedAt
               FROM AdminCardLease
              WHERE leasedTo = ? AND queueKind = ?
                AND spId IN (?)
                AND completedAt IS NULL AND abandonedAt IS NULL
              ORDER BY id ASC`,
            [args.adminId, args.queueKind, spIds],
        );

        await conn.commit();
        return (createdRows as any[]).map(r => ({
            id: Number(r.id),
            spId: Number(r.spId),
            expiresAt: String(r.expiresAt),
            leasedAt: String(r.leasedAt),
        }));
    } catch (e) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw e;
    } finally {
        conn.release();
    }
}

/**
 * Mark a single lease complete. Called by every action endpoint
 * (adopt/remove/skip/reject) after its primary DB write succeeds.
 *
 * If no active lease exists for (adminId, spId), this is a no-op —
 * the action endpoints still succeed but we log the orphan. That
 * shouldn't happen with a well-behaved client, but admins occasionally
 * call action endpoints directly via curl during debugging.
 */
export async function completeLease(args: {
    adminId: string;
    queueKind: QueueKind;
    spId: number;
}): Promise<void> {
    const [res]: any = await pool.query(
        `UPDATE AdminCardLease
            SET completedAt = NOW()
          WHERE leasedTo = ?
            AND queueKind = ?
            AND spId = ?
            AND completedAt IS NULL
            AND abandonedAt IS NULL
            AND expiresAt > NOW()`,
        [args.adminId, args.queueKind, args.spId],
    );
    if (res.affectedRows === 0) {
        console.warn(`[adminLease] complete called without active lease — admin=${args.adminId} sp=${args.spId} kind=${args.queueKind}`);
    }
}

/**
 * Release every active lease this admin holds in this queue. Called
 * when the admin taps "User panel" or otherwise leaves the admin
 * surface intentionally. Distinct from `completedAt` so audit data
 * can tell "admin returned this voluntarily" apart from "admin took
 * action".
 */
export async function releaseAdminBatch(args: {
    adminId: string;
    queueKind: QueueKind;
}): Promise<number> {
    const [res]: any = await pool.query(
        `UPDATE AdminCardLease
            SET abandonedAt = NOW()
          WHERE leasedTo = ?
            AND queueKind = ?
            AND completedAt IS NULL
            AND abandonedAt IS NULL
            AND expiresAt > NOW()`,
        [args.adminId, args.queueKind],
    );
    return Number(res.affectedRows);
}

/**
 * Sweeper — marks any lease past `expiresAt` as abandoned so the
 * cards return to the global queue. Runs from a setInterval inside
 * the API process; fast enough to call hourly without strain.
 *
 * Idempotent: a row already abandoned just doesn't match the WHERE.
 */
export async function sweepExpiredLeases(): Promise<number> {
    const [res]: any = await pool.query(
        `UPDATE AdminCardLease
            SET abandonedAt = NOW()
          WHERE completedAt IS NULL
            AND abandonedAt IS NULL
            AND expiresAt <= NOW()`,
    );
    return Number(res.affectedRows);
}
