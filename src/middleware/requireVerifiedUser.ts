import type { Request, Response, NextFunction } from 'express';
import { verifySessionToken, getVerifiedUser, isVerified, type VerifiedUserRow } from '../services/authService.js';
import { getSessionToken, SESSION_COOKIE } from './sessionAuth.js';

// Token extraction + cookie name are shared with sessionAuth (anonymous identity);
// re-exported here so existing importers of requireVerifiedUser keep resolving them.
export { SESSION_COOKIE };

declare global {
    namespace Express {
        interface Request {
            verifiedUser?: VerifiedUserRow;
        }
    }
}

/**
 * Verifies the session (Bearer header or httpOnly cookie). Loads the
 * User row and confirms it's actually verified (authProvider IS NOT
 * NULL). On success populates `req.verifiedUser` for downstream handlers.
 *
 * Use on endpoints that require a real account — publishing, profile
 * editing, share-link revocation by non-owner, etc.
 */
export async function requireVerifiedUser(req: Request, res: Response, next: NextFunction) {
    try {
        const token = getSessionToken(req);
        if (!token) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        const { userId } = await verifySessionToken(token);
        const user = await getVerifiedUser(userId);
        if (!isVerified(user)) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        req.verifiedUser = user!;
        next();
    } catch {
        res.status(401).json({ error: 'auth-required' });
    }
}

/**
 * Like `requireVerifiedUser` but never short-circuits. If a valid
 * session is present (Bearer or cookie), populates `req.verifiedUser`.
 * Otherwise silently passes through. Use on endpoints that gate just
 * SOME features on verification (e.g. PATCH template where
 * `visibility=public` requires a verified user but other edits don't).
 */
export async function attachVerifiedUser(req: Request, _res: Response, next: NextFunction) {
    try {
        const token = getSessionToken(req);
        if (!token) return next();
        const { userId } = await verifySessionToken(token);
        const user = await getVerifiedUser(userId);
        if (isVerified(user)) req.verifiedUser = user!;
    } catch {
        // Ignore — anonymous request is still allowed through.
    }
    next();
}
