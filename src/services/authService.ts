/**
 * OAuth + JWT session — Pass B.4 of the šablonai roadmap.
 *
 * Source spec: Documentation/roadmap/sablonai.md Part 6.3.
 *
 *   • `verifyGoogleIdToken` / `verifyAppleIdToken` — validate provider
 *     ID tokens against the issuer's JWKS, returning the subject + email.
 *   • `linkOrCreateVerifiedUser` — given a validated (provider, subject)
 *     pair and the caller's anonymous UUID, either return the existing
 *     verified User row or upgrade the anonymous row in place. Anonymous
 *     data (baskets, lists, receipts) stays attached because we never
 *     change the User.id.
 *   • `issueSessionToken` / `verifySessionToken` — short-form JWT used
 *     as the `Authorization: Bearer …` token for verified-only endpoints.
 *
 * `jose` chosen for both directions because it covers JWKS-backed
 * remote-key validation AND local HMAC signing in one library.
 */

import * as jose from 'jose';
import pool from '../config/db.js';
import { createUser } from '../models/userModel.js';
import { mergeFreshIntoRecovered, MergeRollbackError } from './accountMergeService.js';

// ── Provider config ──────────────────────────────────────────────────────

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

const googleJwks = jose.createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
const appleJwks = jose.createRemoteJWKSet(new URL(APPLE_JWKS_URL));

// ── Session JWT ──────────────────────────────────────────────────────────

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SESSION_ISSUER = 'souply-api';
const SESSION_AUDIENCE = 'souply-app';

function getSessionSecret(): Uint8Array {
    const raw = process.env.SESSION_JWT_SECRET ?? '';
    if (raw.length < 32) {
        throw new Error('SESSION_JWT_SECRET env var must be ≥ 32 chars');
    }
    return new TextEncoder().encode(raw);
}

export async function issueSessionToken(userId: string): Promise<string> {
    return new jose.SignJWT({ sub: userId })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(SESSION_ISSUER)
        .setAudience(SESSION_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
        .sign(getSessionSecret());
}

export async function verifySessionToken(token: string): Promise<{ userId: string }> {
    const { payload } = await jose.jwtVerify(token, getSessionSecret(), {
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
    });
    const sub = String(payload.sub ?? '');
    if (!sub) throw new Error('JWT missing sub');
    return { userId: sub };
}

// ── Google ID token validation ───────────────────────────────────────────

export interface VerifiedTokenClaims {
    subject: string;
    email: string | null;
    emailVerified: boolean;
    /** Profile fields from the provider token (Google `profile` scope). Used to
     *  seed displayName/firstName/lastName/avatar on first link so the account
     *  isn't nameless. Null for providers/tokens that don't carry them. */
    name: string | null;
    givenName: string | null;
    familyName: string | null;
    picture: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export async function verifyGoogleIdToken(idToken: string, clientId: string | string[]): Promise<VerifiedTokenClaims> {
    const { payload } = await jose.jwtVerify(idToken, googleJwks, {
        issuer: [GOOGLE_ISSUER, `accounts.google.com`],
        audience: clientId,
    });
    return {
        subject: String(payload.sub ?? ''),
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true,
        name: str(payload.name),
        givenName: str(payload.given_name),
        familyName: str(payload.family_name),
        picture: str(payload.picture),
    };
}

// ── Apple ID token validation ────────────────────────────────────────────

export async function verifyAppleIdToken(idToken: string, clientId: string | string[]): Promise<VerifiedTokenClaims> {
    const { payload } = await jose.jwtVerify(idToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: clientId,
    });
    return {
        subject: String(payload.sub ?? ''),
        email: typeof payload.email === 'string' ? payload.email : null,
        // Apple flips `email_verified` to 'true' (string) sometimes — accept both.
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        // Apple only returns the name in the FIRST authorization's separate
        // `user` field, never in the ID token — so there's nothing to seed here.
        name: null,
        givenName: null,
        familyName: null,
        picture: null,
    };
}

// ── Account linking ──────────────────────────────────────────────────────

export type AuthProvider = 'google' | 'apple';

export interface LinkOutcome {
    userId: string;
    /**
     * `linked`     — anonymous UUID got upgraded; existing data preserved.
     * `loginExisting` — provider had an existing User row; the anonymous
     *                   UUID supplied by the client is abandoned.
     */
    action: 'linked' | 'loginExisting';
}

/**
 * Three cases:
 *   1. A User row with this (authProvider, authSubject) already exists →
 *      return its UUID. The caller's anonymous data on this device is
 *      abandoned (see spec — pre-emptive UI warning).
 *   2. No such row, and the caller's anonymous UUID has no provider yet →
 *      upgrade the anonymous row in place.
 *   3. No such row, and the caller's anonymous UUID already has a
 *      DIFFERENT provider attached (rare — user signed in with one
 *      provider before, now trying another) → return existing UUID
 *      untouched; the caller's claim is rejected silently. For v1 we
 *      treat this as `loginExisting` so the client falls back to the
 *      already-verified account.
 */
/**
 * Seed displayName / firstName / lastName / avatar from the provider token,
 * but ONLY for columns that are still empty — never overwrite a name the user
 * has edited themselves. Runs on every sign-in so an account that predates
 * name capture (or never had a name set) gets backfilled on its next login.
 */
async function backfillProfileFromClaims(userId: string, claims: VerifiedTokenClaims): Promise<void> {
    if (!claims.name && !claims.givenName && !claims.familyName && !claims.picture) return;
    await pool.query(
        `UPDATE User
            SET displayName = COALESCE(NULLIF(displayName, ''), ?),
                firstName   = COALESCE(NULLIF(firstName, ''), ?),
                lastName    = COALESCE(NULLIF(lastName, ''), ?),
                avatarUrl   = COALESCE(NULLIF(avatarUrl, ''), ?)
          WHERE id = ?`,
        [claims.name, claims.givenName, claims.familyName, claims.picture, userId],
    );
}

export async function linkOrCreateVerifiedUser(opts: {
    anonymousUserId: string;
    provider: AuthProvider;
    claims: VerifiedTokenClaims;
}): Promise<LinkOutcome> {
    const { anonymousUserId, provider, claims } = opts;

    // Case 1: provider-pair already mapped to a verified user.
    const [existing]: any = await pool.query(
        `SELECT id FROM User
          WHERE authProvider = ? AND authSubject = ?
          LIMIT 1`,
        [provider, claims.subject],
    );
    if (existing.length > 0) {
        const userId = String(existing[0].id);
        // Backfill the name on existing accounts whose fields are still empty.
        await backfillProfileFromClaims(userId, claims);
        // Silently fold the device's anonymous data (baskets / lists / receipts
        // / votes / points) into the existing verified account, then drop the
        // emptied anon row. Reuses the recovery merge (same shape: fresh anon →
        // existing account); its fast-path also covers the "empty anon" case by
        // just deleting the orphan row.
        //
        // GUARD: only merge a GENUINELY anonymous device row. If this device's
        // UUID is itself a verified account (a second provider login), merging +
        // deleting it would silently destroy a real account — so we skip and
        // just switch identity, leaving both accounts intact.
        if (anonymousUserId !== userId) {
            await createUser(anonymousUserId);
            const [anonRow]: any = await pool.query(
                `SELECT authProvider FROM User WHERE id = ? LIMIT 1`,
                [anonymousUserId],
            );
            const anonIsAnonymous = anonRow.length > 0 && anonRow[0].authProvider === null;
            if (anonIsAnonymous) {
                try {
                    await mergeFreshIntoRecovered(anonymousUserId, userId, null);
                } catch (e) {
                    // Merge failed AND rolled back (it's atomic — no half-merge
                    // possible; a Telegram alert already fired). Fail-OPEN: never
                    // block sign-in. The user still gets their account; the anon
                    // data stays under its own UUID, recoverable later.
                    if (e instanceof MergeRollbackError) {
                        console.error(`[oauth] anon→account merge rolled back, stage=${e.stage}; continuing login`);
                    } else {
                        console.error('[oauth] anon→account merge errored, continuing login:', e);
                    }
                }
            }
        }
        return { userId, action: 'loginExisting' };
    }

    // Ensure the anonymous user row exists (clients sometimes call OAuth
    // before any other API has materialised the User row).
    await createUser(anonymousUserId);

    // Case 3 check: anonymous row already has a different provider linked.
    const [anon]: any = await pool.query(
        `SELECT authProvider FROM User WHERE id = ? LIMIT 1`,
        [anonymousUserId],
    );
    if (anon.length > 0 && anon[0].authProvider !== null) {
        // The anon UUID already represents a verified user. Just return
        // it — the client is in a "you're already signed in" state.
        return { userId: anonymousUserId, action: 'loginExisting' };
    }

    // Case 2: upgrade anonymous → verified in place.
    await pool.query(
        `UPDATE User
            SET authProvider = ?, authSubject = ?,
                email = ?, emailVerified = ?
          WHERE id = ?`,
        [provider, claims.subject, claims.email, claims.emailVerified ? 1 : 0, anonymousUserId],
    );
    // Seed the name/avatar from the provider on this first link.
    await backfillProfileFromClaims(anonymousUserId, claims);
    return { userId: anonymousUserId, action: 'linked' };
}

// ── Verified-user lookup ─────────────────────────────────────────────────

export interface VerifiedUserRow {
    id: string;
    username: string | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    bio: string | null;
    avatarUrl: string | null;
    authProvider: AuthProvider | null;
    email: string | null;
    emailVerified: boolean;
}

export async function getVerifiedUser(userId: string): Promise<VerifiedUserRow | null> {
    const [rows]: any = await pool.query(
        `SELECT id, username, displayName, firstName, lastName, bio, avatarUrl,
                authProvider, email, emailVerified
           FROM User WHERE id = ? LIMIT 1`,
        [userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
        id: String(r.id),
        username: r.username,
        displayName: r.displayName,
        firstName: r.firstName,
        lastName: r.lastName,
        bio: r.bio,
        avatarUrl: r.avatarUrl,
        authProvider: r.authProvider,
        email: r.email,
        emailVerified: !!r.emailVerified,
    };
}

export function isVerified(row: VerifiedUserRow | null): boolean {
    return !!row && row.authProvider !== null;
}
