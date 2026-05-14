import '../config/env.js';
import pool from '../config/db.js';
import { propagateCrossChainImages } from '../services/imagePropagationService.js';

/**
 * One-shot runner for the cross-chain image propagation. Use this to
 * backfill the initial pool of missing-image SPs that have an imaged
 * sibling — should be run once before relying on the nightly cron, so
 * the admin queue doesn't get flooded with cards that auto-propagation
 * would have closed.
 *
 *   npx tsx src/scripts/runImagePropagation.ts
 */
(async () => {
    try {
        console.log('[runImagePropagation] starting');
        const r = await propagateCrossChainImages();
        console.log(`[runImagePropagation] done — candidates=${r.candidatesFound} propagated=${r.propagated} skipped=${r.skipped} errors=${r.errors}`);
    } finally {
        await pool.end();
    }
})();
