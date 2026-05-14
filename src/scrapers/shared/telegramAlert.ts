const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Anything that isn't `NODE_ENV=production` is considered a dev/test
 * backend and gets a `[DEV]` prefix in every Telegram message.
 *
 * Why: prod and dev backends point at the same Telegram chat, and the
 * scraper cron schedule lives inside the API process (see
 * src/scrapers/scheduler.ts). When both are alive on cron day they
 * both send identical "scrape done" notifications a minute apart —
 * the prefix makes it obvious which backend each one came from
 * instead of looking like a process bug.
 */
const ENV_PREFIX = process.env.NODE_ENV === 'production' ? '' : '[DEV] ';

export async function notifyTelegram(message: string): Promise<void> {
    if (!TOKEN || !CHAT_ID) {
        console.warn('[Telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert');
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text: `${ENV_PREFIX}${message}`, parse_mode: 'HTML' }),
        });
    } catch (e) {
        console.error('[Telegram] Failed to send alert:', e);
    }
}
