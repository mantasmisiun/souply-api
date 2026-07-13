import type { Request, Response, NextFunction } from 'express';
import { verifySessionToken } from '../services/authService.js';

/**
 * Session identity for ANY logged-in user — anonymous or OAuth-verified.
 *
 * Both kinds of user carry the same HS256 session JWT (issueSessionToken, sub=userId):
 * an anonymous install gets one from POST /api/users, a verified account from
 * POST /api/auth/oauth. This middleware proves the caller holds a valid token and
 * exposes its subject as `req.authUserId` — WITHOUT the extra `isVerified` gate that
 * requireVerifiedUser applies. Use it on per-user resources (receipts, swipe votes)
 * that anonymous users legitimately own; pair with an ownership check so a valid token
 * for user A can't act on user B's rows.
 *
 * requireVerifiedUser (real-account-only endpoints: publishing, profile) is unchanged
 * and layers the account check on top of the same token.
 */

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Subject of a verified session token, when one was presented. */
            authUserId?: string;
        }
    }
}

/** Name of the web httpOnly session cookie (mobile uses the Bearer header). */
export const SESSION_COOKIE = 'souply_session';

/** Pull the session JWT from the Bearer header (mobile) or the httpOnly cookie (web). */
export function getSessionToken(req: Request): string | null {
    const header = req.header('authorization');
    if (header && header.toLowerCase().startsWith('bearer ')) {
        return header.slice(7).trim();
    }
    const raw = req.headers.cookie;
    if (raw) {
        const m = raw.match(/(?:^|;\s*)souply_session=([^;]+)/);
        if (m) return decodeURIComponent(m[1]);
    }
    return null;
}

/**
 * Require a valid session token (anonymous OR verified). Sets req.authUserId.
 * 401 when absent/invalid. Never trust a userId in the body/params for identity —
 * this is the only trustworthy source.
 */
export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const token = getSessionToken(req);
        if (token) {
            const { userId } = await verifySessionToken(token);
            if (userId) {
                req.authUserId = userId;
                next();
                return;
            }
        }
        // NON-PROD dev-auth shim: souply-web's dev/staging build has no OAuth cookie and
        // authenticates by sending `X-User-Id: <devUserId>`. Honor it ONLY outside
        // production so those builds keep working, while PROD strictly requires a real
        // token/cookie (in prod this header is ignored — the IDOR it used to enable is
        // closed). Same NODE_ENV convention the dev-only receipt purge uses.
        if (process.env.NODE_ENV !== 'production') {
            const h = req.headers['x-user-id'];
            if (typeof h === 'string' && h.length > 0) {
                req.authUserId = h;
                next();
                return;
            }
        }
        res.status(401).json({ error: 'auth-required' });
    } catch {
        res.status(401).json({ error: 'auth-required' });
    }
}

/**
 * Attach req.authUserId when a valid token is present, but never reject.
 * For endpoints that behave differently for known vs anonymous callers yet
 * must stay reachable without a token.
 */
export async function optionalUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
        const token = getSessionToken(req);
        if (token) {
            const { userId } = await verifySessionToken(token);
            if (userId) req.authUserId = userId;
        }
    } catch {
        /* ignore — anonymous */
    }
    next();
}

/**
 * Guard a `/…/:userId/...` (or `/users/:id`) route: the token subject MUST equal the id
 * in the path. Apply AFTER requireUser. 403 on mismatch — a valid token for A can't
 * read/write B's collection. `paramName` defaults to 'userId'; userRoutes use ':id'.
 *
 * Usable both as bare middleware (defaults to ':userId') and as a factory
 * `requireSelfUserParam('id')`.
 */
export function requireSelfUserParam(paramNameOrReq: string | Request, res?: Response, next?: NextFunction): any {
    const make = (paramName: string) => (req: Request, res2: Response, next2: NextFunction): void => {
        const paramId = typeof req.params[paramName] === 'string' ? req.params[paramName].trim() : '';
        if (!req.authUserId || paramId !== req.authUserId) {
            res2.status(403).json({ error: 'forbidden' });
            return;
        }
        next2();
    };
    // Called as middleware directly: (req, res, next) with the default ':userId'.
    if (typeof paramNameOrReq !== 'string') {
        return make('userId')(paramNameOrReq, res as Response, next as NextFunction);
    }
    // Called as a factory: requireSelfUserParam('id').
    return make(paramNameOrReq);
}
