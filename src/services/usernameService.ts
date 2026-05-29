/**
 * Username management — Pass B.4 of the šablonai roadmap.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 6.
 *
 *   • `validateUsernameFormat` — pure: charset, length, lowercase
 *   • `isReservedUsername` — pure: hits a static blocklist of brand
 *     names + reserved system handles
 *   • `assignUsername` — orchestrator: checks all of the above + 30-day
 *     rate limit + global uniqueness, then writes
 */

import pool from '../config/db.js';

const MIN = 3;
const MAX = 20;
const FORMAT_RE = /^[a-z0-9_.]+$/;

/**
 * Globally-reserved handles: every chain in the price-comparison universe,
 * plus the obvious system / abuse vectors. Kept in code rather than a DB
 * table so reviewing additions = a git diff, not a SQL audit log.
 */
const RESERVED = new Set<string>([
    // System / brand
    'souply', 'support', 'admin', 'administrator', 'help', 'team',
    'about', 'contact', 'info', 'official', 'root', 'system', 'mod',
    'api', 'static', 'public', 'private', 'login', 'signup', 'signin',
    'logout', 'register', 'me', 'self', 'app', 'web', 'www', 'mail',
    'security', 'press', 'careers', 'jobs', 'blog', 'docs', 'status',
    'privacy', 'terms', 'tos', 'legal',
    // Chains
    'maxima', 'rimi', 'iki', 'norfa', 'lidl', 'aldi', 'kiosko',
    'kausta', 'topo', 'senukai', 'depo',
    // Common abuse
    'null', 'undefined', 'true', 'false',
]);

export interface UsernameValidationOk { ok: true; normalized: string; }
export interface UsernameValidationFail { ok: false; reason: UsernameRejectReason; }
export type UsernameValidation = UsernameValidationOk | UsernameValidationFail;
export type UsernameRejectReason =
    | 'too-short' | 'too-long' | 'bad-format' | 'reserved'
    | 'taken' | 'rate-limited';

/**
 * Format check: 3–20 chars, lowercase, [a-z0-9_.]. Trims whitespace and
 * lowercases before checking so the client's exact casing doesn't matter.
 * Pure — call directly in tests.
 */
export function validateUsernameFormat(raw: unknown): UsernameValidation {
    if (typeof raw !== 'string') return { ok: false, reason: 'bad-format' };
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length < MIN) return { ok: false, reason: 'too-short' };
    if (trimmed.length > MAX) return { ok: false, reason: 'too-long' };
    if (!FORMAT_RE.test(trimmed)) return { ok: false, reason: 'bad-format' };
    if (isReservedUsername(trimmed)) return { ok: false, reason: 'reserved' };
    return { ok: true, normalized: trimmed };
}

export function isReservedUsername(username: string): boolean {
    return RESERVED.has(username.toLowerCase());
}

export const USERNAME_CHANGE_COOLDOWN_DAYS = 30;

/**
 * Pure rate-limit predicate: was the last change within the cooldown
 * window? Driven by `User.usernameSetAt`. Returns false when never set
 * (first-time claim is always allowed).
 */
export function withinChangeCooldown(usernameSetAt: Date | null, nowMs: number = Date.now()): boolean {
    if (!usernameSetAt) return false;
    const elapsedMs = nowMs - usernameSetAt.getTime();
    const cooldownMs = USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    return elapsedMs < cooldownMs;
}

// ── DB-touching orchestrator ─────────────────────────────────────────────

export interface AssignSuccess { ok: true; username: string; }
export interface AssignFail { ok: false; reason: UsernameRejectReason; }
export type AssignResult = AssignSuccess | AssignFail;

/**
 * Atomic-ish handle claim. Order of checks:
 *   1. Format / reserved → 400 immediately
 *   2. Rate limit (only fires when the user already has a username)
 *   3. Uniqueness check + UPDATE — relies on the UNIQUE INDEX as the
 *      ultimate arbiter; a race between two simultaneous claims is
 *      caught by the ER_DUP_ENTRY surface.
 */
export async function assignUsername(userId: string, raw: string): Promise<AssignResult> {
    const validation = validateUsernameFormat(raw);
    if (!validation.ok) return validation;
    const normalized = validation.normalized;

    const [rows]: any = await pool.query(
        `SELECT username, usernameSetAt FROM User WHERE id = ? LIMIT 1`,
        [userId],
    );
    if (rows.length === 0) return { ok: false, reason: 'bad-format' };
    const current = rows[0];

    // First-time claim is free. Subsequent changes are rate-limited.
    if (current.username && current.username !== normalized) {
        if (withinChangeCooldown(current.usernameSetAt ? new Date(current.usernameSetAt) : null)) {
            return { ok: false, reason: 'rate-limited' };
        }
    }

    // No-op when re-claiming the same handle.
    if (current.username === normalized) {
        return { ok: true, username: normalized };
    }

    try {
        await pool.query(
            `UPDATE User SET username = ?, usernameSetAt = NOW() WHERE id = ?`,
            [normalized, userId],
        );
    } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY') return { ok: false, reason: 'taken' };
        throw e;
    }

    return { ok: true, username: normalized };
}

/**
 * Cheap availability check for the username picker UX. Doesn't write
 * anything — the client can ping it on every keystroke (debounced).
 */
export async function isUsernameAvailable(raw: string): Promise<{ available: boolean; reason?: UsernameRejectReason }> {
    const validation = validateUsernameFormat(raw);
    if (!validation.ok) return { available: false, reason: validation.reason };
    const [rows]: any = await pool.query(
        `SELECT id FROM User WHERE username = ? LIMIT 1`,
        [validation.normalized],
    );
    if (rows.length > 0) return { available: false, reason: 'taken' };
    return { available: true };
}
