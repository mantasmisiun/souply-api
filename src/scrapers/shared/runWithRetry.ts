import { notifyTelegram } from './telegramAlert.js';

// Patient retry policy for the chain scrapers. Chain sites — especially the
// Cloudflare-fronted ones (Norfa) and the heavy Playwright ones (Barbora, Lidl)
// — throw transient 5xx / navigation-timeout errors that clear on their own
// within minutes. Retrying immediately tends to hit the same blip, so we wait a
// full hour between attempts to give the site time to recover, and only alert
// if every attempt fails.
//
// Tunable via env (handy for testing without 5-hour waits):
//   SCRAPER_RETRY_DELAY_MS  — gap between attempts (default 1h)
//   SCRAPER_MAX_ATTEMPTS    — total attempts incl. the first (default 5)
const RETRY_DELAY_MS = Number(process.env.SCRAPER_RETRY_DELAY_MS) || 60 * 60 * 1000;
const MAX_ATTEMPTS = Number(process.env.SCRAPER_MAX_ATTEMPTS) || 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run a scraper with up to MAX_ATTEMPTS tries, RETRY_DELAY_MS apart. The wrapped
 * scraper is expected to THROW on failure (it no longer alerts itself) and to
 * send its own ✅ success summary on success. Only when the FINAL attempt fails
 * does this send the 🚨 Telegram alert — transient blips self-heal silently.
 *
 * Never re-throws: a chain that exhausts its retries is alerted and skipped so
 * the rest of the batch (and the discounts-summary refresh) still runs.
 */
export async function runScraperWithRetry(
    name: string,
    fn: () => Promise<void>,
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await fn();
            return; // success — the scraper already sent its own ✅ summary
        } catch (e) {
            lastError = e;
            const m = (e as Error)?.message ?? String(e);
            console.error(`[${name}] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${m}`);
            if (attempt < MAX_ATTEMPTS) {
                console.log(`[${name}] retrying in ${Math.round(RETRY_DELAY_MS / 60000)} min…`);
                await sleep(RETRY_DELAY_MS);
            }
        }
    }

    const m = (lastError as Error)?.message ?? String(lastError);
    const spanH = Math.round((RETRY_DELAY_MS * (MAX_ATTEMPTS - 1)) / 3_600_000);
    console.error(`[${name}] giving up after ${MAX_ATTEMPTS} attempts`);
    await notifyTelegram(
        `🚨 <b>${name}</b> scraper failed\n` +
        `Failed all ${MAX_ATTEMPTS} attempts over ~${spanH}h.\n` +
        `Last error: ${m}`,
    );
}
