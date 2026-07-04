import '../config/env.js';
import pool from '../config/db.js';
import { refreshDiscountedSummary } from '../models/productModel.js';
import { runBarboraPromoScraper } from './barbora/index.js';
import { runIkiPromoScraper } from './iki/index.js';
import { runNorfaPromoScraper } from './norfa/index.js';
import { runRimiPromoScraper } from './rimi/index.js';
import { runLidlPromoScraper } from './lidl/index.js';

(async () => {
    try {
        await runBarboraPromoScraper();
        await runIkiPromoScraper();
        await runNorfaPromoScraper();
        await runRimiPromoScraper();
        await runLidlPromoScraper();
    } finally {
        // The Discounts screen reads the materialized DiscountedProductSummary table, which
        // is otherwise only rebuilt at API boot or by the prod-only scheduler — so a manual
        // scrape writes fresh promo rows that never surface until restart. Rebuild it here
        // (in `finally`, so partial results still show if a scraper throws). Single-chain
        // scrapes (scrape:iki, …) don't hit this path — use `npm run discounts:refresh`.
        try {
            await refreshDiscountedSummary();
        } catch (e) {
            console.error('[scrape:all] discounts summary refresh failed:', (e as Error).message);
        }
        await pool.end();
    }
})();
