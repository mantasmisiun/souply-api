import crypto from 'crypto';
import pool from '../config/db.js';

/**
 * Souply 2.0 invite ledger (Phase 1c): one QR/link token, MANY claimers —
 * the deliberate redesign of the single-flight list-share claimedAt.
 * UNIQUE(tokenId, userId) makes claims idempotent.
 */

export type InviteScope = 'trip' | 'household';

export interface InviteTokenRow {
    id: number;
    code: string;
    scope: InviteScope;
    targetId: number;
    createdByUserId: string;
    revokedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
}

// Unambiguous URL-safe alphabet (no 0/O/1/I/l) — codes are typed by humans
// only as a fallback, but why invite transcription errors.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LEN = 12;

const genCode = (): string => {
    const bytes = crypto.randomBytes(CODE_LEN);
    let out = '';
    for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
};

/** Reuse the live token for (scope, target) when one exists — one QR per thing. */
export const getOrCreateInviteToken = async (
    scope: InviteScope,
    targetId: number,
    createdByUserId: string,
): Promise<InviteTokenRow> => {
    const [existing]: any = await pool.query(
        `SELECT * FROM InviteToken
         WHERE scope = ? AND targetId = ? AND revokedAt IS NULL
           AND (expiresAt IS NULL OR expiresAt > NOW())
         ORDER BY id DESC LIMIT 1`,
        [scope, targetId]);
    if (existing.length) return existing[0];

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const code = genCode();
            const [res]: any = await pool.query(
                'INSERT INTO InviteToken (code, scope, targetId, createdByUserId) VALUES (?, ?, ?, ?)',
                [code, scope, targetId, createdByUserId]);
            const [rows]: any = await pool.query('SELECT * FROM InviteToken WHERE id = ?', [res.insertId]);
            return rows[0];
        } catch (e: any) {
            if (e?.code !== 'ER_DUP_ENTRY') throw e; // code collision → regenerate
        }
    }
    throw new Error('invite code generation failed');
};

export const getInviteByCode = async (code: string): Promise<InviteTokenRow | null> => {
    const [rows]: any = await pool.query('SELECT * FROM InviteToken WHERE code = ?', [code]);
    return rows[0] ?? null;
};

export const inviteIsLive = (t: InviteTokenRow): boolean =>
    t.revokedAt == null && (t.expiresAt == null || new Date(t.expiresAt).getTime() > Date.now());

export const recordInviteClaim = async (tokenId: number, userId: string): Promise<void> => {
    await pool.query(
        'INSERT IGNORE INTO InviteClaim (tokenId, userId) VALUES (?, ?)',
        [tokenId, userId]);
};

export const revokeInvite = async (tokenId: number): Promise<void> => {
    await pool.query('UPDATE InviteToken SET revokedAt = NOW() WHERE id = ?', [tokenId]);
};
