import '../config/env.js';
import { sendBetaInviteEmail } from '../services/emailService.js';

/**
 * One-time re-invite for the iOS testers who received the broken TestFlight link
 * before it was fixed. The iOS signups were essentially just one person, so this
 * uses an explicit list rather than a DB query.
 *
 * SAFE BY DEFAULT — dry run (prints who it would email) unless you pass `--send`.
 * To test without hitting real inboxes, point SMTP_HOST/SMTP_PORT at Mailpit
 * (e.g. SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURE=false) and run with
 * `--send`; all mail lands in Mailpit's UI. Then run again with the real SMTP
 * env to actually deliver.
 *
 *   tsx src/scripts/reinviteBeta.ts            # dry run
 *   tsx src/scripts/reinviteBeta.ts --send     # send (uses current SMTP env)
 */
const RECIPIENTS: { email: string; name: string; lang: 'lt' | 'en' }[] = [
    { email: 'vnavikas@gmail.com', name: 'Vismantas', lang: 'lt' },
    // Add your own address here to verify on Mailpit first, then remove:
    // { email: 'you@example.com', name: 'Mantas', lang: 'lt' },
];

const send = process.argv.includes('--send');

(async () => {
    console.log(`[reinvite] ${RECIPIENTS.length} recipient(s) — mode: ${send ? 'SEND' : 'DRY RUN'}`);
    for (const r of RECIPIENTS) {
        if (!send) {
            console.log(`  would email: ${r.email}  (${r.name}, ${r.lang})`);
            continue;
        }
        try {
            await sendBetaInviteEmail({ to: r.email, name: r.name, platform: 'ios', lang: r.lang, reinvite: true });
            console.log(`  ✓ sent: ${r.email}`);
        } catch (e: any) {
            console.error(`  ✗ FAILED: ${r.email} — ${e?.message ?? e}`);
        }
    }
    console.log(`[reinvite] done${send ? '' : ' (dry run — pass --send to actually send)'}.`);
    process.exit(0);
})();
