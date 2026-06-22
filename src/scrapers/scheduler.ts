import cron from 'node-cron';
import { runBarboraPromoScraper } from './barbora/index.js';
import { runIkiPromoScraper } from './iki/index.js';
import { runNorfaPromoScraper } from './norfa/index.js';
import { runRimiPromoScraper } from './rimi/index.js';
import { runLidlPromoScraper } from './lidl/index.js';
import { runScraperWithRetry } from './shared/runWithRetry.js';
import { recalcGlobalScores } from '../models/productInteractionModel.js';
import { refreshDiscountedSummary } from '../models/productModel.js';
import { propagateCrossChainImages } from '../services/imagePropagationService.js';
import { sendDailyReceiptIssuesReport } from '../services/adminDailyReportService.js';

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

async function run(label: string, scrapers: { name: string; fn: () => Promise<any> }[]) {
    if (running) {
        console.warn(`[Scheduler] ${label}: previous scrape still running — skipping`);
        return;
    }
    running = true;
    console.log(`[Scheduler] ${label}: starting…`);
    try {
        // Each scraper retries on its own (up to 5 attempts, 1h apart) and only
        // alerts after the final failure; a chain that exhausts retries is
        // skipped (not thrown) so the rest of the batch + refresh still run.
        for (const s of scrapers) await runScraperWithRetry(s.name, s.fn);
        console.log(`[Scheduler] ${label}: finished. Refreshing discounts summary…`);
        await refreshDiscountedSummary();
        console.log(`[Scheduler] ${label}: discounts summary refreshed.`);
    } catch (e: any) {
        console.error(`[Scheduler] ${label}: failed —`, e.message);
    } finally {
        running = false;
    }
}

// Monday 06:00 — IKI + Lidl weekly deals start
cron.schedule('0 6 * * 1', () => run('Mon', [{ name: 'IKI', fn: runIkiPromoScraper }, { name: 'Lidl', fn: runLidlPromoScraper }]), { timezone: 'Europe/Vilnius' });

// Tuesday 06:00 — Rimi + Barbora weekly deals start
cron.schedule('0 6 * * 2', () => run('Tue', [{ name: 'Rimi', fn: runRimiPromoScraper }, { name: 'Barbora', fn: runBarboraPromoScraper }]), { timezone: 'Europe/Vilnius' });

// Thursday 06:00 — Norfa weekly + kasoje deals start
cron.schedule('0 6 * * 4', () => run('Thu', [{ name: 'Norfa', fn: runNorfaPromoScraper }]), { timezone: 'Europe/Vilnius' });

// Saturday 06:00 — Lidl weekend "super savaitgalis" starts
cron.schedule('0 6 * * 6', () => run('Sat', [{ name: 'Lidl', fn: runLidlPromoScraper }]), { timezone: 'Europe/Vilnius' });

// Nightly 03:00 — keep globalScore fresh for anonymous browse
cron.schedule('0 3 * * *', () => {
    recalcGlobalScores().catch(e => console.error('[Scheduler] Global score recalc failed:', e.message));
}, { timezone: 'Europe/Vilnius' });

// Nightly 03:30 — propagate cross-chain images so newly-scraped chain
// images flow to siblings that arrived earlier without one. Runs after
// the score recalc so they don't race on the same DB connections.
cron.schedule('30 3 * * *', () => {
    propagateCrossChainImages()
        .then(r => console.log(`[Scheduler] Image propagation: candidates=${r.candidatesFound} propagated=${r.propagated} skipped=${r.skipped} errors=${r.errors}`))
        .catch(e => console.error('[Scheduler] Image propagation failed:', e.message));
}, { timezone: 'Europe/Vilnius' });

// Daily 00:30 — drop promos that expired overnight from the
// DiscountedProductSummary. Without this the table holds rows until
// the next scrape (could be days away), and users would see promos
// that ended hours ago.
cron.schedule('30 0 * * *', () => {
    refreshDiscountedSummary().catch(e => console.error('[Scheduler] Daily discounts refresh failed:', e.message));
}, { timezone: 'Europe/Vilnius' });

// Daily 20:00 — Telegram digest of pending user-flagged
// ReceiptLineIssue rows so the admin gets a daily prompt to clear
// the Žymos inbox. Service skips the send when no rows are pending
// (no Telegram spam on quiet days).
cron.schedule('0 20 * * *', () => {
    sendDailyReceiptIssuesReport()
        .catch(e => console.error('[Scheduler] Daily admin digest failed:', e?.message ?? e));
}, { timezone: 'Europe/Vilnius' });

console.log('[Scheduler] Cron jobs registered — Mon/Tue/Thu/Sat 06:00, daily 00:30 + 03:00 + 03:30 + 20:00 Europe/Vilnius');
