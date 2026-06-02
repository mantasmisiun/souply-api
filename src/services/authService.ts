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
}

export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<VerifiedTokenClaims> {
    const { payload } = await jose.jwtVerify(idToken, googleJwks, {
        issuer: [GOOGLE_ISSUER, `accounts.google.com`],
        audience: clientId,
    });
    return {
        subject: String(payload.sub ?? ''),
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true,
    };
}

// ── Apple ID token validation ────────────────────────────────────────────

export async function verifyAppleIdToken(idToken: string, clientId: string): Promise<VerifiedTokenClaims> {
    const { payload } = await jose.jwtVerify(idToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: clientId,
    });
    return {
        subject: String(payload.sub ?? ''),
        email: typeof payload.email === 'string' ? payload.email : null,
        // Apple flips `email_verified` to 'true' (string) sometimes — accept both.
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
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
        return { userId: String(existing[0].id), action: 'loginExisting' };
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
