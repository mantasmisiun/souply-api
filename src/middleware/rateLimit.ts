import { Request, Response, NextFunction } from 'express';

/**
 * Lightweight in-memory, per-IP rate limiter.
 *
 * Sufficient for the single backend instance running this app (OMV box / one
 * Oracle VM). It protects the public, unauthenticated endpoints (beta-signup
 * form, geocode proxy, OAuth sign-in) from request floods and the beta-signup
 * mail-bomb vector. If the backend is ever scaled horizontally, swap this for
 * `express-rate-limit` backed by Redis — the same place the geocode cache
 * would move (see geocodeController).
 *
 * Fixed-window counter: each client IP gets `max` requests per `windowMs`;
 * the window resets on the first request after it elapses. Stale buckets are
 * swept lazily so the Map can't grow unbounded.
 *
 * NOTE: relies on `app.set('trust proxy', 1)` (see index.ts) so `req.ip` is the
 * real client IP behind the Nginx/Traefik reverse proxy, not the proxy's IP.
 */
interface Bucket {
    count: number;
    resetAt: number;
}

export function createRateLimiter(opts: {
    windowMs: number;
    max: number;
    message?: string;
}) {
    const { windowMs, max, message = 'Too many requests. Please try again later.' } = opts;
    const buckets = new Map<string, Bucket>();

    return (req: Request, res: Response, next: NextFunction): void => {
        const now = Date.now();
        const key = req.ip || req.socket.remoteAddress || 'unknown';

        let bucket = buckets.get(key);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;

        // Lazy sweep to keep the Map bounded under churny/abusive IP traffic.
        if (buckets.size > 5000) {
            for (const [k, v] of buckets) {
                if (now >= v.resetAt) buckets.delete(k);
            }
        }

        const resetInSec = Math.ceil((bucket.resetAt - now) / 1000);
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
        res.setHeader('RateLimit-Reset', String(resetInSec));

        if (bucket.count > max) {
            res.setHeader('Retry-After', String(resetInSec));
            res.status(429).json({ error: message });
            return;
        }
        next();
    };
}

// Strict: signing up for the beta is a once-per-person action, so a tight cap
// stops form spam and the mail-bomb vector without affecting any real user.
export const signupLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

// Moderate: other public, unauthenticated endpoints (geocode proxy, OAuth
// sign-in). Generous enough for normal sessions, low enough to blunt abuse.
export const publicLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });

// On-demand map pricing (tap-a-pin to price + "calculate this area"). Generous
// for a real browsing session (many pin taps + a few capped batches), tight
// enough to blunt scripted abuse of the comparison engine.
export const storePricesLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 40 });

// PDF rasterisation is a BLOCKING, CPU/memory-heavy op (poppler spawnSync). Even behind
// auth, cap the rate so one client can't wedge the single Node event loop with a stream
// of PDFs. A real user converts a handful of receipt PDFs per minute at most.
export const pdfConvertLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
