import cron from 'node-cron';
import { runBarboraPromoScraper } from './barbora/index.js';
import { runIkiPromoScraper } from './iki/index.js';
import { runNorfaPromoScraper } from './norfa/index.js';
import { runRimiPromoScraper } from './rimi/index.js';
import { runLidlPromoScraper } from './lidl/index.js';
import { recalcGlobalScores } from '../models/productInteractionModel.js';
import { invalidateDiscountsCache } from '../models/productModel.js';

// Lithuanian store promo schedule (verified from store websites):
//   IKI      Mon–Sun   → scrape Monday 06:00
//   Lidl     Mon–Sun   → scrape Monday 06:00  (weekly deals)
//   Rimi     Tue–Mon   → scrape Tuesday 06:00
//   Barbora  Tue–Mon   → scrape Tuesday 06:00
//   Norfa    Thu–Wed   → scrape Thursday 06:00 (both weekly and kasoje deals)
//   Lidl     Sat–Sun   → scrape Saturday 06:00 (weekend "super savaitgalis")
//
// Scrapers run sequentially to avoid DB contention and memory spikes
// (Playwright-based scrapers — Lidl, Rimi, Barbora — are heavy).

let running = false;

async function run(label: string, scrapers: (() => Promise<any>)[]) {
    if (running) {
        console.warn(`[Scheduler] ${label}: previous scrape still running — skipping`);
        return;
    }
    running = true;
    console.log(`[Scheduler] ${label}: starting…`);
    try {
        for (const scraper of scrapers) await scraper();
        invalidateDiscountsCache();
        console.log(`[Scheduler] ${label}: finished.`);
    } catch (e: any) {
        console.error(`[Scheduler] ${label}: failed —`, e.message);
    } finally {
        running = false;
    }
}

// Monday 06:00 — IKI + Lidl weekly deals start
cron.schedule('0 6 * * 1', () => run('Mon', [runIkiPromoScraper, runLidlPromoScraper]), { timezone: 'Europe/Vilnius' });

// Tuesday 06:00 — Rimi + Barbora weekly deals start
cron.schedule('0 6 * * 2', () => run('Tue', [runRimiPromoScraper, runBarboraPromoScraper]), { timezone: 'Europe/Vilnius' });

// Thursday 06:00 — Norfa weekly + kasoje deals start
cron.schedule('0 6 * * 4', () => run('Thu', [runNorfaPromoScraper]), { timezone: 'Europe/Vilnius' });

// Saturday 06:00 — Lidl weekend "super savaitgalis" starts
cron.schedule('0 6 * * 6', () => run('Sat', [runLidlPromoScraper]), { timezone: 'Europe/Vilnius' });

// Nightly 03:00 — keep globalScore fresh for anonymous browse
cron.schedule('0 3 * * *', () => {
    recalcGlobalScores().catch(e => console.error('[Scheduler] Global score recalc failed:', e.message));
}, { timezone: 'Europe/Vilnius' });

console.log('[Scheduler] Cron jobs registered — Mon/Tue/Thu/Sat 06:00, daily 03:00 Europe/Vilnius');
