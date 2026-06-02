/**
 * One-shot local tester for the beta invite email. No DB, no HTTP server.
 *
 *   npx tsx src/scripts/testBetaInvite.ts you@email.lt ios
 *   npx tsx src/scripts/testBetaInvite.ts you@email.lt android
 *
 * Uses the SMTP_* settings from your local `.env` (point them at Resend
 * — SMTP_HOST=smtp.resend.com, SMTP_USER=resend, SMTP_PASS=re_…,
 * SMTP_FROM="Souply <noreply@souply.lt>") so the souply.lt sender +
 * DKIM/SPF are exercised exactly as in production.
 *
 * Optionally set BETA_TESTFLIGHT_URL / BETA_PLAYSTORE_URL in .env to see
 * the real store button link; otherwise the button points at `#`.
 */
import '../config/env.js'; // loads .env (validates DB vars exist, no connection)
import { sendBetaInviteEmail } from '../services/emailService.js';

const to = process.argv[2];
const platform = (process.argv[3] === 'android' ? 'android' : 'ios') as 'ios' | 'android';
const lang = (process.argv[4] === 'en' ? 'en' : 'lt') as 'lt' | 'en';

if (!to) {
    console.error('Usage: npx tsx src/scripts/testBetaInvite.ts <to-email> [ios|android] [lt|en]');
    process.exit(1);
}

sendBetaInviteEmail({ to, name: 'Mantas', platform, lang })
    .then(() => {
        console.log(`✓ Invite sent to ${to} (${platform}, ${lang})`);
        process.exit(0);
    })
    .catch((e) => {
        console.error('✗ Send failed:', e?.message ?? e);
        process.exit(1);
    });
