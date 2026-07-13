/**
 * DEV one-off: move ALL data from one account UUID into another, then delete the
 * source row. Reuses the production-safe `mergeFreshIntoRecovered` (atomic
 * transaction + rollback + the canonical list of every userId-bearing table),
 * so it can't half-move data.
 *
 * Usage:
 *   npx tsx src/scripts/devReassignAccount.ts <fromUUID> <toUUID>
 *
 * Example — recover yesterday's random-UUID dev data onto the pinned 000 user
 * (after DEV_RANDOM_USER_UUID was flipped back to false):
 *   npx tsx src/scripts/devReassignAccount.ts \
 *     99c95203-b962-4aa5-9083-3e778aabcdc5 00000000-0000-0000-0000-000000000000
 *
 * <fromUUID> is DELETED; its data ends up under <toUUID> (which must already
 * exist). Collisions on the aggregate tables (scores/votes/equivalences) are
 * merged by the same rules the recovery flow uses.
 */
import '../config/env.js';
import pool from '../config/db.js';
import { mergeFreshIntoRecovered } from '../services/accountMergeService.js';

async function main() {
    const [from, to] = process.argv.slice(2);
    if (!from || !to) {
        console.error('Usage: npx tsx src/scripts/devReassignAccount.ts <fromUUID> <toUUID>');
        process.exit(1);
    }
    if (from === to) {
        console.error('[reassign] from and to UUIDs must differ');
        process.exit(1);
    }
    console.log(`[reassign] merging ${from} -> ${to} ...`);
    const snapshot = await mergeFreshIntoRecovered(from, to, null);
    console.log('[reassign] done. Moved from the source account:', snapshot);
    await pool.end();
    process.exit(0);
}

main().catch(async (e) => {
    console.error('[reassign] FAILED (rolled back if mid-merge):', e);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
});
