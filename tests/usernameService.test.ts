import {
    validateUsernameFormat,
    isReservedUsername,
    withinChangeCooldown,
    USERNAME_CHANGE_COOLDOWN_DAYS,
} from '../src/services/usernameService.js';

// ---------------------------------------------------------------------------
// validateUsernameFormat
// ---------------------------------------------------------------------------

describe('validateUsernameFormat', () => {
    it('accepts a standard lowercase handle', () => {
        expect(validateUsernameFormat('mantas')).toEqual({ ok: true, normalized: 'mantas' });
    });

    it('normalizes casing and trims whitespace', () => {
        expect(validateUsernameFormat('  ReCePtAi  ')).toEqual({ ok: true, normalized: 'receptai' });
    });

    it('accepts digits, underscores, and dots', () => {
        expect(validateUsernameFormat('recepta1_lt.com')).toEqual({ ok: true, normalized: 'recepta1_lt.com' });
    });

    it('rejects too-short input', () => {
        expect(validateUsernameFormat('ab')).toEqual({ ok: false, reason: 'too-short' });
    });

    it('rejects too-long input', () => {
        expect(validateUsernameFormat('a'.repeat(21))).toEqual({ ok: false, reason: 'too-long' });
    });

    it('rejects unsupported characters', () => {
        expect(validateUsernameFormat('hello world')).toEqual({ ok: false, reason: 'bad-format' });
        expect(validateUsernameFormat('hello-world')).toEqual({ ok: false, reason: 'bad-format' });
        expect(validateUsernameFormat('héllo')).toEqual({ ok: false, reason: 'bad-format' });
    });

    it('rejects reserved handles before passing format', () => {
        expect(validateUsernameFormat('rimi')).toEqual({ ok: false, reason: 'reserved' });
        expect(validateUsernameFormat('SOUPLY')).toEqual({ ok: false, reason: 'reserved' });
    });

    it('rejects non-string inputs', () => {
        expect(validateUsernameFormat(42 as any)).toEqual({ ok: false, reason: 'bad-format' });
        expect(validateUsernameFormat(null as any)).toEqual({ ok: false, reason: 'bad-format' });
        expect(validateUsernameFormat(undefined as any)).toEqual({ ok: false, reason: 'bad-format' });
    });
});

// ---------------------------------------------------------------------------
// isReservedUsername
// ---------------------------------------------------------------------------

describe('isReservedUsername', () => {
    it('matches chain brand handles', () => {
        ['maxima', 'rimi', 'iki', 'norfa', 'lidl'].forEach(h => {
            expect(isReservedUsername(h)).toBe(true);
        });
    });

    it('matches system handles', () => {
        ['admin', 'support', 'souply', 'api', 'me'].forEach(h => {
            expect(isReservedUsername(h)).toBe(true);
        });
    });

    it('is case-insensitive', () => {
        expect(isReservedUsername('SOUPLY')).toBe(true);
        expect(isReservedUsername('Maxima')).toBe(true);
    });

    it('does not match arbitrary handles', () => {
        expect(isReservedUsername('mantas')).toBe(false);
        expect(isReservedUsername('receptai_lt')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// withinChangeCooldown
// ---------------------------------------------------------------------------

describe('withinChangeCooldown', () => {
    const NOW = Date.parse('2026-06-01T00:00:00Z');
    const DAY = 24 * 60 * 60 * 1000;

    it('returns false when usernameSetAt is null (first-time claim)', () => {
        expect(withinChangeCooldown(null, NOW)).toBe(false);
    });

    it('returns true when last change was yesterday', () => {
        expect(withinChangeCooldown(new Date(NOW - 1 * DAY), NOW)).toBe(true);
    });

    it('returns true at the boundary (1 ms before cooldown elapses)', () => {
        const justBefore = new Date(NOW - USERNAME_CHANGE_COOLDOWN_DAYS * DAY + 1);
        expect(withinChangeCooldown(justBefore, NOW)).toBe(true);
    });

    it('returns false exactly when cooldown elapses', () => {
        const exactly = new Date(NOW - USERNAME_CHANGE_COOLDOWN_DAYS * DAY);
        expect(withinChangeCooldown(exactly, NOW)).toBe(false);
    });

    it('returns false when last change was long ago', () => {
        expect(withinChangeCooldown(new Date(NOW - 365 * DAY), NOW)).toBe(false);
    });
});
