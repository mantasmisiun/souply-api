import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { sendBetaSignupNotification, sendBetaInviteEmail } from '../services/emailService.js';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * POST /api/beta-signups
 * Body: { name, email, platform: 'ios' | 'android' }
 *
 * Public, unauthenticated — the landing-page beta form. Persists the
 * signup (unique on email, so a repeat submit refreshes rather than
 * duplicates) and fires an internal notification email. The email is
 * fire-and-forget: a mail hiccup must not fail a signup that's already
 * saved.
 */
export const createBetaSignup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name, email, platform, lang } = req.body ?? {};
        const cleanName = typeof name === 'string' ? name.trim() : '';
        const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
        const cleanPlatform = platform === 'android' ? 'android' : 'ios';
        const cleanLang = lang === 'en' ? 'en' : 'lt';

        if (cleanName.length < 2) {
            res.status(400).json({ error: 'Name is required' });
            return;
        }
        if (!EMAIL_RE.test(cleanEmail)) {
            res.status(400).json({ error: 'Valid email is required' });
            return;
        }

        // Read prior state BEFORE the upsert so we can tell a genuine platform
        // switch from a plain re-submit. Re-invite when: brand new, a prior send
        // failed (invitedAt NULL), OR the tester switched platform — so the
        // stored platform never drifts from the invite they actually received
        // (the iOS-then-Android case), and a real switch sends the invite for
        // their new device.
        const [prevRows]: any = await pool.query(
            `SELECT platform, invitedAt FROM BetaSignup WHERE email = ? LIMIT 1`,
            [cleanEmail],
        );
        const prev = prevRows[0] ?? null;
        const shouldInvite = !prev || prev.invitedAt == null || prev.platform !== cleanPlatform;

        await pool.query(
            `INSERT INTO BetaSignup (name, email, platform)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), platform = VALUES(platform)`,
            [cleanName, cleanEmail, cleanPlatform],
        );

        if (!shouldInvite) {
            res.status(200).json({ ok: true, emailSent: true, alreadyInvited: true });
            return;
        }

        // Await the send so the landing form can show a real loading → sent /
        // error state. The row is already saved, so a failed send returns 502
        // and is safely retryable (invitedAt stays NULL until a send succeeds).
        try {
            await sendBetaInviteEmail({ to: cleanEmail, name: cleanName, platform: cleanPlatform, lang: cleanLang });
        } catch (e: any) {
            console.error('[betaSignup] invite email failed:', e?.message);
            res.status(502).json({ ok: false, emailSent: false });
            return;
        }
        await pool.query(`UPDATE BetaSignup SET invitedAt = NOW() WHERE email = ?`, [cleanEmail]);

        // Internal ops ping (to the team) — fire-and-forget, once, after the
        // first successful invite.
        sendBetaSignupNotification({ name: cleanName, email: cleanEmail, platform: cleanPlatform })
            .catch((e) => console.error('[betaSignup] notification email failed:', e?.message));

        res.status(201).json({ ok: true, emailSent: true });
    } catch (e) {
        next(e);
    }
};
