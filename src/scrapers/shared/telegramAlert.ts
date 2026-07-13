const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * dev / staging / production all share one Telegram bot + chat, and the scraper
 * cron lives inside the API process — so without a clear tag, messages from
 * different backends are indistinguishable (staging and prod both run
 * NODE_ENV=production). Resolve a 3-way environment label so every message is
 * stamped with where it came from.
 *
 * Detection uses what each deployment already sets — no new required env var:
 *   - APP_ENV, if set explicitly, always wins.
 *   - NODE_ENV !== 'production'        → 'dev'        (local / test)
 *   - SENTRY_ENVIRONMENT === 'staging' → 'staging'    (.env.staging already sets it)
 *   - otherwise                        → 'production' (Oracle prod)
 */
export function resolveEnv(): 'dev' | 'staging' | 'production' {
    const explicit = process.env.APP_ENV?.toLowerCase();
    if (explicit === 'dev' || explicit === 'staging' || explicit === 'production') return explicit;
    if (process.env.NODE_ENV !== 'production') return 'dev';
    if (process.env.SENTRY_ENVIRONMENT === 'staging') return 'staging';
    return 'production';
}

const ENV_META = {
    dev: { badge: '🧪', label: 'Dev' },
    staging: { badge: '🟠', label: 'Staging' },
    production: { badge: '🟢', label: 'Production' },
} as const;

const ENV = resolveEnv();

/** Branded, env-stamped header prepended to every alert (Telegram HTML). */
function header(): string {
    const { badge, label } = ENV_META[ENV];
    return `${badge} <b>Souply</b> · <i>${label}</i>\n────────────`;
}

export async function notifyTelegram(message: string): Promise<void> {
    if (!TOKEN || !CHAT_ID) {
        console.warn('[Telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert');
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text: `${header()}\n${message}`,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });
    } catch (e) {
        console.error('[Telegram] Failed to send alert:', e);
    }
}
