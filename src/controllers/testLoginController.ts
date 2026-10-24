import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import { issueSessionToken } from '../services/authService.js';
import { isTestLoginEnabled, testLoginKeyMatches, testLoginUserId } from '../config/testLogin.js';
import { setSessionCookie } from './authController.js';

/**
 * Staging/dev test login (see config/testLogin.ts). Two steps so the shared key
 * never has to pass through a browser or an agent's prompt:
 *
 *   POST /api/auth/test-login         X-Test-Login-Key: <key>
 *        → { token, userId, browserLoginUrl, expiresInSeconds }
 *          (token = Bearer for API tests; the URL carries a one-time code)
 *   GET  /api/auth/test-login/redeem?code=…
 *        → sets the normal session cookie, 302 to the web dashboard
 *
 * The account is a regular VERIFIED user (authProvider set), so it sees exactly
 * what a signed-in creator sees. Its authSubject can't collide with a real Google
 * subject (those are long numeric strings).
 */
const CODE_TTL_MS = 60_000;
const codes = new Map<string, { userId: string; expiresAt: number }>();

async function ensureTestUser(userId: string): Promise<void> {
    await pool.query(
        `INSERT INTO User (id, isAdmin, points, authProvider, authSubject, email, emailVerified,
                           firstName, lastName, displayName)
         VALUES (?, 0, 0, 'google', 'souply-test-hermes', 'hermes@local.test', 1, 'Hermes', 'Test', 'Hermes (test)')
         ON DUPLICATE KEY UPDATE authProvider = 'google', authSubject = 'souply-test-hermes',
                                 email = 'hermes@local.test', emailVerified = 1`,
        [userId],
    );
}

function issueCode(userId: string): string {
    const now = Date.now();
    for (const [c, v] of codes) if (v.expiresAt <= now) codes.delete(c);
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, { userId, expiresAt: now + CODE_TTL_MS });
    return code;
}

export const testLogin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!isTestLoginEnabled()) {
            res.status(404).json({ error: 'not-found' });
            return;
        }
        if (!testLoginKeyMatches(req.header('x-test-login-key'))) {
            res.status(401).json({ error: 'invalid-test-login-key' });
            return;
        }
        const userId = testLoginUserId();
        await ensureTestUser(userId);
        const token = await issueSessionToken(userId);
        setSessionCookie(res, token);
        const apiBase = (process.env.API_PUBLIC_URL ?? '').replace(/\/$/, '');
        res.json({
            token,
            userId,
            browserLoginUrl: `${apiBase}/api/auth/test-login/redeem?code=${issueCode(userId)}`,
            expiresInSeconds: CODE_TTL_MS / 1000,
        });
    } catch (e) { next(e); }
};

export const redeemTestLogin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!isTestLoginEnabled()) {
            res.status(404).json({ error: 'not-found' });
            return;
        }
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const entry = codes.get(code);
        codes.delete(code); // single use, even when expired
        if (!entry || entry.expiresAt <= Date.now()) {
            res.status(400).type('text').send('Test login link is invalid or expired — request a new one.');
            return;
        }
        setSessionCookie(res, await issueSessionToken(entry.userId));
        const web = (process.env.WEB_PUBLIC_URL ?? '').replace(/\/$/, '');
        res.redirect(302, `${web}/dashboard`);
    } catch (e) { next(e); }
};
