import crypto from 'crypto';
import { resolveEnv } from '../scrapers/shared/telegramAlert.js';

/**
 * STAGING/DEV-ONLY test login — lets an automated tester (Hermes) sign in as one
 * designated account without Google/Apple. Off unless TEST_LOGIN_KEY is set, and
 * the API refuses to start if it is set in production (assertTestLoginSafe).
 *
 *   TEST_LOGIN_KEY       shared secret, ≥32 chars; sent as `X-Test-Login-Key`
 *   TEST_LOGIN_USER_ID   the account it signs in as (default below)
 *
 * Read lazily (not at import) so the guard runs where index.ts calls it and
 * tests can toggle it.
 */
export const DEFAULT_TEST_LOGIN_USER_ID = '7e57ab1e-0000-4000-8000-0000000000a1';
const MIN_KEY_LENGTH = 32;

export function isTestLoginEnabled(): boolean {
    return (process.env.TEST_LOGIN_KEY ?? '').length > 0;
}

export function testLoginUserId(): string {
    return process.env.TEST_LOGIN_USER_ID || DEFAULT_TEST_LOGIN_USER_ID;
}

/** Throws when the test login would be enabled somewhere it must never be. */
export function assertTestLoginSafe(): void {
    if (!isTestLoginEnabled()) return;
    if (resolveEnv() === 'production') {
        throw new Error('TEST_LOGIN_KEY is set in production — remove it; the test login is staging/dev only');
    }
    if ((process.env.TEST_LOGIN_KEY ?? '').length < MIN_KEY_LENGTH) {
        throw new Error(`TEST_LOGIN_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    }
}

/** Constant-time compare (digests, so the key's length isn't leaked either). */
export function testLoginKeyMatches(candidate: unknown): boolean {
    if (!isTestLoginEnabled() || typeof candidate !== 'string' || candidate.length === 0) return false;
    const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
    return crypto.timingSafeEqual(digest(candidate), digest(process.env.TEST_LOGIN_KEY as string));
}
