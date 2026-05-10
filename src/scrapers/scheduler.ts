import cron from 'node-cron';
import { runBarboraPromoScraper } from './barbora/index.js';
import { runIkiPromoScraper } from './iki/index.js';
import { runNorfaPromoScraper } from './norfa/index.js';
import { runRimiPromoScraper } from './rimi/index.js';
import { runLidlPromoScraper } from './lidl/index.js';
import { recalcGlobalScores } from '../models/productInteractionModel.js';
import { invalidateDiscountsCache } from '../models/productModel.js';

// Lithuanian store promo schedule:
//   Monday 06:00   — main weekly deals start across all chains
//   Thursday 06:00 — short weekend deals start (Rimi, Lidl "super savaitgalis")
//
// Scrapers run sequentially to avoid DB contention and memory spikes
// (Playwright-based scrapers — Lidl, Rimi, Barbora — are heavy).

let running = false;

async function runAllScrapers() {
    if (running) {
        console.warn('[Scheduler] Previous scrape still running — skipping this trigger');
        return;
    }
    running = true;
    console.log('[Scheduler] Starting scheduled scrape run…');
    try {
        await runBarboraPromoScraper();
        await runIkiPromoScraper();
        await runNorfaPromoScraper();
        await runRimiPromoScraper();
        await runLidlPromoScraper();
        invalidateDiscountsCache();
        console.log('[Scheduler] All scrapers finished.');
    } catch (e: any) {
        console.error('[Scheduler] Scrape run failed:', e.message);
    } finally {
        running = false;
    }
}

// Monday 06:00 Vilnius time
cron.schedule('0 6 * * 1', runAllScrapers, { timezone: 'Europe/Vilnius' });

// Thursday 06:00 Vilnius time
cron.schedule('0 6 * * 4', runAllScrapers, { timezone: 'Europe/Vilnius' });

// Nightly 03:00 — keep globalScore fresh for anonymous browse
cron.schedule('0 3 * * *', () => {
    recalcGlobalScores().catch(e => console.error('[Scheduler] Global score recalc failed:', e.message));
}, { timezone: 'Europe/Vilnius' });

console.log('[Scheduler] Cron jobs registered — Mon & Thu 06:00, daily 03:00 Europe/Vilnius');
