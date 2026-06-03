import type { Request, Response, NextFunction } from 'express';
import pool from '../config/db.js';
import {
    verifyGoogleIdToken, verifyAppleIdToken,
    linkOrCreateVerifiedUser, issueSessionToken,
    type AuthProvider,
} from '../services/authService.js';
import {
    assignUsername, isUsernameAvailable,
    type UsernameRejectReason,
} from '../services/usernameService.js';
import { getVerifiedUser } from '../services/authService.js';
import { uploadAvatar, avatarSignedUrl } from '../services/storageService.js';
import { SESSION_COOKIE } from '../middleware/requireVerifiedUser.js';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches the JWT

function getProviderClientId(provider: AuthProvider): string | string[] | null {
    if (provider === 'google') {
        // Comma-separated list so the server trusts ID tokens from ALL of this
        // env's Google clients: the web client AND the native Android/iOS
        // clients (a native token's `aud` is its own client ID, not the web's).
        const ids = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '')
            .split(',').map(s => s.trim()).filter(Boolean);
        return ids.length === 0 ? null : ids.length === 1 ? ids[0] : ids;
    }
    if (provider === 'apple')  return process.env.APPLE_OAUTH_CLIENT_ID  ?? null;
    return null;
}

/**
 * POST /api/auth/oauth
 *
 * Body: { provider: 'google' | 'apple', idToken: string, anonymousUserId: string }
 *
 * Validates the provider ID token, links/upgrades the anonymous UUID to
 * a verified User row, and returns a 30-day session JWT. The client
 * persists the JWT in expo-secure-store and sends it as
 * `Authorization: Bearer <jwt>` on every verified-only endpoint.
 */
export const oauthSignIn = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { provider, idToken, anonymousUserId } = req.body ?? {};
        if (provider !== 'google' && provider !== 'apple') {
            res.status(400).json({ error: 'Invalid provider' });
            return;
        }
        if (typeof idToken !== 'string' || idToken.length === 0) {
            res.status(400).json({ error: 'idToken is required' });
            return;
        }
        if (typeof anonymousUserId !== 'string' || anonymousUserId.length === 0) {
            res.status(400).json({ error: 'anonymousUserId is required' });
            return;
        }
        const clientId = getProviderClientId(provider);
        if (!clientId) {
            // Misconfigured server. Don't leak provider details to the
            // client — just return a generic 503.
            res.status(503).json({ error: 'auth-unavailable' });
            return;
        }

        let claims;
        try {
            claims = provider === 'google'
                ? await verifyGoogleIdToken(idToken, clientId)
                : await verifyAppleIdToken(idToken, clientId);
        } catch {
            res.status(401).json({ error: 'invalid-token' });
            return;
        }
        if (!claims.subject) {
            res.status(401).json({ error: 'invalid-token' });
            return;
        }

        const link = await linkOrCreateVerifiedUser({
            anonymousUserId,
            provider,
            claims,
        });
        const token = await issueSessionToken(link.userId);
        const user = await getVerifiedUser(link.userId);

        // Web session: also set the JWT as an httpOnly cookie so the
        // browser holds it XSS-safely (mobile ignores this and keeps
        // using the `token` from the body as a Bearer header). Host-only
        // (no Domain) so it never leaks to sibling subdomains. `secure`
        // only in production — local dev runs over http://localhost.
        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: SESSION_MAX_AGE_MS,
            path: '/',
        });

        res.json({
            token,
            action: link.action,
            user: {
                id: link.userId,
                username: user?.username ?? null,
                displayName: user?.displayName ?? null,
                bio: user?.bio ?? null,
                avatarUrl: user?.avatarUrl ?? null,
                email: user?.email ?? null,
                authProvider: user?.authProvider ?? null,
            },
        });
    } catch (e) { next(e); }
};

/**
 * POST /api/auth/logout — clears the web session cookie. No-op for
 * mobile (which just drops its stored Bearer token client-side). Always
 * 204 so the client can treat logout as fire-and-forget.
 */
export const logout = async (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).send();
};

/**
 * GET /api/auth/me — returns the current verified user's profile fields.
 * Accepts the Bearer header or the web session cookie.
 */
export const fetchMe = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = req.verifiedUser!;
        res.json({
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            firstName: (user as any).firstName ?? null,
            lastName: (user as any).lastName ?? null,
            bio: user.bio,
            avatarUrl: await avatarSignedUrl(user.avatarUrl),
            email: user.email,
            authProvider: user.authProvider,
        });
    } catch (e) { next(e); }
};

/**
 * PATCH /api/users/me/username — set the verified user's handle.
 * Returns 409 on collision, 429 on rate-limited change.
 */
export const setUsername = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.verifiedUser!.id;
        const { username } = req.body ?? {};
        const result = await assignUsername(userId, String(username ?? ''));
        if (!result.ok) {
            const status = rejectReasonToStatus(result.reason);
            res.status(status).json({ error: result.reason });
            return;
        }
        res.json({ username: result.username });
    } catch (e) { next(e); }
};

/**
 * GET /api/users/username-available?u={candidate} — debounced check
 * used by the username picker UX. Verified-only so unauthenticated
 * clients can't brute-force the namespace.
 */
export const checkUsernameAvailable = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const raw = String(req.query?.u ?? '');
        const out = await isUsernameAvailable(raw);
        res.json(out);
    } catch (e) { next(e); }
};

function rejectReasonToStatus(reason: UsernameRejectReason): number {
    switch (reason) {
        case 'taken': return 409;
        case 'rate-limited': return 429;
        default: return 400;
    }
}

// ── Profile editing ───────────────────────────────────────────────────────

const DISPLAY_NAME_MAX = 60;
const BIO_MAX = 160;

export const patchProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const hdr = req.header('x-user-id');
        const userId = req.verifiedUser?.id ?? (typeof hdr === 'string' && hdr ? hdr : null);
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        const { displayName, bio, firstName, lastName } = req.body ?? {};
        const updates: string[] = [];
        const args: any[] = [];
        for (const [field, value] of [['firstName', firstName], ['lastName', lastName]] as const) {
            if (value !== undefined) {
                if (typeof value !== 'string' || value.length > 100) {
                    res.status(400).json({ error: `bad-${field}` });
                    return;
                }
                updates.push(`${field} = ?`);
                args.push(value.trim() || null);
            }
        }
        if (displayName !== undefined) {
            if (typeof displayName !== 'string' || displayName.length > DISPLAY_NAME_MAX) {
                res.status(400).json({ error: 'bad-displayName' });
                return;
            }
            updates.push('displayName = ?');
            args.push(displayName.trim() || null);
        }
        if (bio !== undefined) {
            if (typeof bio !== 'string' || bio.length > BIO_MAX) {
                res.status(400).json({ error: 'bad-bio' });
                return;
            }
            updates.push('bio = ?');
            args.push(bio.trim() || null);
        }
        if (updates.length === 0) {
            res.status(400).json({ error: 'no-fields' });
            return;
        }
        args.push(userId);
        await pool.query(`UPDATE User SET ${updates.join(', ')} WHERE id = ?`, args);
        res.status(204).send();
    } catch (e) { next(e); }
};

/**
 * POST /api/users/me/avatar — multipart-y avatar upload, but for v1 we
 * accept a JSON body with `imageBase64` to avoid the multer/multipart
 * setup. The client encodes the picked image to base64 (≤ 2 MB
 * enforced client-side) and sends it. Uploaded under
 * `avatars/{userId}.{ext}` and overwrites on every change.
 */
export const setAvatar = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const hdr = req.header('x-user-id');
        const userId = req.verifiedUser?.id ?? (typeof hdr === 'string' && hdr ? hdr : null);
        if (!userId) {
            res.status(401).json({ error: 'auth-required' });
            return;
        }
        const { imageBase64 } = req.body ?? {};
        if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
            res.status(400).json({ error: 'image-required' });
            return;
        }
        const buf = Buffer.from(imageBase64, 'base64');
        // Raw cap before compression; sharp shrinks it to a 256px JPEG anyway.
        if (buf.length > 6 * 1024 * 1024) {
            res.status(413).json({ error: 'too-large' });
            return;
        }
        // uploadAvatar returns the storage KEY (private bucket); persist it and
        // hand back a freshly-signed URL the client can render immediately.
        const key = await uploadAvatar(userId, buf);
        await pool.query(`UPDATE User SET avatarUrl = ? WHERE id = ?`, [key, userId]);
        res.json({ avatarUrl: await avatarSignedUrl(key) });
    } catch (e) { next(e); }
};

// ── Public profile read ─────────────────────────────────────────────────

/**
 * GET /api/users/@{username} — public-facing profile read for the
 * souply.lt/@{handle} landing page and the in-app preview.
 *
 * Returns the User's display fields plus the count + summary of their
 * `visibility='public'` templates. Returns 404 when the username
 * doesn't resolve to a user.
 */
export const fetchPublicProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const username = String(req.params.username ?? '').toLowerCase().trim();
        if (!username) {
            res.status(400).json({ error: 'username-required' });
            return;
        }
        const [users]: any = await pool.query(
            `SELECT id, username, displayName, bio, avatarUrl
               FROM User WHERE username = ? LIMIT 1`,
            [username],
        );
        const user = users[0];
        if (!user) {
            res.status(404).json({ error: 'not-found' });
            return;
        }
        const [templates]: any = await pool.query(
            `SELECT id, name, shareSlug, useCount, visitCount, collectiveSavingsEur,
                    snapshotCheapestChainId, snapshotTotalEur, snapshotRunnerUpEur,
                    snapshotCalculatedAt,
                    (SELECT COUNT(*) FROM BasketTemplateItem bti WHERE bti.templateId = bt.id) AS itemCount
               FROM BasketTemplate bt
              WHERE userId = ? AND visibility = 'public'
              ORDER BY updatedAt DESC`,
            [user.id],
        );
        const totalCollectiveSavings = templates.reduce(
            (s: number, t: any) => s + Number(t.collectiveSavingsEur ?? 0),
            0,
        );
        const totalInstantiations = templates.reduce(
            (s: number, t: any) => s + Number(t.useCount ?? 0),
            0,
        );
        const totalVisits = templates.reduce(
            (s: number, t: any) => s + Number(t.visitCount ?? 0),
            0,
        );
        res.json({
            username: user.username,
            displayName: user.displayName,
            bio: user.bio,
            avatarUrl: await avatarSignedUrl(user.avatarUrl),
            publicTemplateCount: templates.length,
            totalCollectiveSavingsEur: totalCollectiveSavings,
            totalInstantiations,
            totalVisits,
            templates: templates.map((t: any) => ({
                id: Number(t.id),
                name: t.name,
                shareSlug: t.shareSlug,
                itemCount: Number(t.itemCount ?? 0),
                useCount: Number(t.useCount ?? 0),
                snapshot: t.snapshotCheapestChainId !== null ? {
                    cheapestChainId: Number(t.snapshotCheapestChainId),
                    cheapestTotalEur: t.snapshotTotalEur !== null ? Number(t.snapshotTotalEur) : null,
                    runnerUpTotalEur: t.snapshotRunnerUpEur !== null ? Number(t.snapshotRunnerUpEur) : null,
                    calculatedAt: t.snapshotCalculatedAt
                        ? new Date(t.snapshotCalculatedAt).toISOString() : null,
                } : null,
            })),
        });
    } catch (e) { next(e); }
};
