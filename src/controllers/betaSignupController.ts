import { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { sendBetaSignupNotification } from '../services/emailService.js';

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
        const { name, email, platform } = req.body ?? {};
        const cleanName = typeof name === 'string' ? name.trim() : '';
        const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
        const cleanPlatform = platform === 'android' ? 'android' : 'ios';

        if (cleanName.length < 2) {
            res.status(400).json({ error: 'Name is required' });
            return;
        }
        if (!EMAIL_RE.test(cleanEmail)) {
            res.status(400).json({ error: 'Valid email is required' });
            return;
        }

        await pool.query(
            `INSERT INTO BetaSignup (name, email, platform)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), platform = VALUES(platform)`,
            [cleanName, cleanEmail, cleanPlatform],
        );

        sendBetaSignupNotification({ name: cleanName, email: cleanEmail, platform: cleanPlatform })
            .catch((e) => console.error('[betaSignup] notification email failed:', e?.message));

        res.status(201).json({ ok: true });
    } catch (e) {
        next(e);
    }
};
