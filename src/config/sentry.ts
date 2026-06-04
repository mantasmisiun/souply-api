import * as Sentry from '@sentry/node';

// Public, write-only ingest DSN (safe to commit — it can only POST events,
// not read them). Overridable via SENTRY_DSN if we ever rotate the project.
const DEFAULT_DSN =
    'https://0a1a504ac1e341498ef57ca059d0deb5@o4511502732361728.ingest.de.sentry.io/4511502767358032';

const dsn = process.env.SENTRY_DSN ?? DEFAULT_DSN;

// Only report from the deployed stacks (staging + prod both run
// NODE_ENV=production). Local dev + the test runner stay silent so we don't
// burn the free-tier quota on our own machines. staging vs prod is told apart
// by SENTRY_ENVIRONMENT (set to "staging" in the staging .env); defaults to
// "production" so an un-set prod box still labels correctly.
const enabled = process.env.NODE_ENV === 'production' && !!dsn;

if (enabled) {
    Sentry.init({
        dsn,
        environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
        release: process.env.SENTRY_RELEASE,
        // Error Monitoring only — no performance tracing/profiling (keeps us
        // inside the free tier). Errors + unhandled rejections still captured.
        tracesSampleRate: 0,
    });
    console.log(`[Sentry] error reporting enabled (${process.env.SENTRY_ENVIRONMENT ?? 'production'})`);
}

export { Sentry };
