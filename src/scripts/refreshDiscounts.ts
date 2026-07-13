import '../config/env.js';
import pool from '../config/db.js';
import { refreshDiscountedSummary } from '../models/productModel.js';

// Rebuild the materialized DiscountedProductSummary table that the Discounts screen reads.
// On dev the scheduler is disabled, so a manual scrape (especially the single-chain
// scrape:iki / scrape:lidl / … runners, which don't refresh) leaves the screen showing the
// last API-boot snapshot. Run this after scraping to surface the fresh promos without a
// server restart:  npm run discounts:refresh
(async () => {
    try {
        console.log('[discounts:refresh] rebuilding DiscountedProductSummary…');
        await refreshDiscountedSummary();
        console.log('[discounts:refresh] done.');
    } catch (e) {
        console.error('[discounts:refresh] failed:', (e as Error).message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
