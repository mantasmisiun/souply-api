import { resolveEnv } from '../src/scrapers/shared/telegramAlert.js';

// resolveEnv drives the FailedReceiptLog `environment` column, the Telegram
// cadence (staging=immediate / dev=silent / prod=digest), and the digest's
// per-env failure filter — so its 3-way resolution is worth pinning down.
describe('resolveEnv', () => {
    const original = { ...process.env };
    afterEach(() => {
        process.env = { ...original };
    });

    it('honours an explicit APP_ENV above everything else', () => {
        process.env.APP_ENV = 'staging';
        process.env.NODE_ENV = 'production';
        expect(resolveEnv()).toBe('staging');
    });

    it('treats a non-production NODE_ENV as dev', () => {
        delete process.env.APP_ENV;
        process.env.NODE_ENV = 'test';
        expect(resolveEnv()).toBe('dev');
    });

    it('distinguishes staging from prod via SENTRY_ENVIRONMENT', () => {
        delete process.env.APP_ENV;
        process.env.NODE_ENV = 'production';
        process.env.SENTRY_ENVIRONMENT = 'staging';
        expect(resolveEnv()).toBe('staging');
    });

    it('falls back to production when NODE_ENV=production and no staging marker', () => {
        delete process.env.APP_ENV;
        process.env.NODE_ENV = 'production';
        delete process.env.SENTRY_ENVIRONMENT;
        expect(resolveEnv()).toBe('production');
    });

    it('ignores an unrecognised APP_ENV value', () => {
        process.env.APP_ENV = 'banana';
        process.env.NODE_ENV = 'test';
        expect(resolveEnv()).toBe('dev');
    });
});
