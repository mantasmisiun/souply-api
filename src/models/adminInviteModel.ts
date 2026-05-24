import crypto from 'crypto';
import pool from '../config/db.js';

function sha256(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function randomToken(): string {
    return crypto.randomBytes(32).toString('hex');
}

// ── Types ──────────────────────────────────────────────────────────────────

export type InviteStatus = 'pending_scan' | 'pending_email' | 'claimed' | 'expired' | 'revoked';
export type AdminRole = 'admin' | 'superadmin';

export interface AdminInvite {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    role: AdminRole;
    notes: string | null;
    status: InviteStatus;
    expiresAt: Date;
    claimedUserId: string | null;
    claimedAt: Date | null;
    createdAt: Date;
    createdBy: string | null;
}

// ── Invite CRUD ────────────────────────────────────────────────────────────

export async function createInvite(opts: {
    email: string;
    firstName: string;
    lastName: string;
    role: AdminRole;
    notes: string;
    createdBy: string;
}): Promise<{ id: number; rawToken: string }> {
    const rawToken = randomToken();
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

    const [result]: any = await pool.query(
        `INSERT INTO AdminInvite (tokenHash, email, firstName, lastName, role, notes, expiresAt, createdBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [tokenHash, opts.email, opts.firstName, opts.lastName, opts.role, opts.notes, expiresAt, opts.createdBy],
    );
    await auditLog({ inviteId: result.insertId, action: 'invite_created', detail: { email: opts.email, role: opts.role } });
    return { id: result.insertId, rawToken };
}

export async function listInvites(): Promise<AdminInvite[]> {
    const [rows]: any = await pool.query(
        `SELECT id, email, firstName, lastName, role, notes, status,
                expiresAt, claimedUserId, claimedAt, createdAt, createdBy
         FROM AdminInvite ORDER BY createdAt DESC`,
    );
    return rows;
}

export async function getInviteById(id: number): Promise<AdminInvite | null> {
    const [rows]: any = await pool.query(
        `SELECT id, email, firstName, lastName, role, notes, status,
                expiresAt, claimedUserId, claimedAt, createdAt, createdBy
         FROM AdminInvite WHERE id = ?`,
        [id],
    );
    return rows[0] ?? null;
}

/** Regenerate the QR token for a pending_scan invite (extends expiry by 24h). */
export async function regenerateToken(id: number): Promise<string> {
    const rawToken = randomToken();
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
        `UPDATE AdminInvite SET tokenHash = ?, expiresAt = ?, status = 'pending_scan'
         WHERE id = ? AND status IN ('pending_scan','expired')`,
        [tokenHash, expiresAt, id],
    );
    await auditLog({ inviteId: id, action: 'qr_regenerated' });
    return rawToken;
}

export async function revokeInvite(id: number): Promise<void> {
    await pool.query(
        `UPDATE AdminInvite SET status = 'revoked' WHERE id = ?`, [id],
    );
    // Strip admin rights if already claimed
    const [rows]: any = await pool.query(`SELECT claimedUserId FROM AdminInvite WHERE id = ?`, [id]);
    const userId: string | null = rows[0]?.claimedUserId ?? null;
    if (userId) {
        await pool.query(`UPDATE User SET isAdmin = 0 WHERE id = ?`, [userId]);
    }
    await auditLog({ inviteId: id, userId: userId ?? undefined, action: 'invite_revoked' });
}

export async function shadowBanInvite(id: number, note: string): Promise<void> {
    const [rows]: any = await pool.query(`SELECT claimedUserId FROM AdminInvite WHERE id = ?`, [id]);
    const userId: string | null = rows[0]?.claimedUserId ?? null;
    await pool.query(`UPDATE AdminInvite SET status = 'revoked' WHERE id = ?`, [id]);
    if (userId) {
        await pool.query(
            `UPDATE User SET shadowBanned = 1, shadowBannedAt = NOW(), shadowBannedNote = ? WHERE id = ?`,
            [note || null, userId],
        );
    }
    await auditLog({ inviteId: id, userId: userId ?? undefined, action: 'shadow_banned', detail: { note } });
}

export async function unshadowUser(userId: string): Promise<void> {
    await pool.query(
        `UPDATE User SET shadowBanned = 0, shadowBannedAt = NULL, shadowBannedNote = NULL WHERE id = ?`,
        [userId],
    );
    await auditLog({ userId, action: 'shadow_lifted' });
}

// ── Claim flow ─────────────────────────────────────────────────────────────

/** Find a valid (not expired, pending_scan) invite by raw QR token. */
export async function findClaimableInvite(rawToken: string): Promise<(AdminInvite & { id: number }) | null> {
    const hash = sha256(rawToken);
    const [rows]: any = await pool.query(
        `SELECT id, email, firstName, lastName, role, notes, status, expiresAt,
                claimedUserId, claimedAt, createdAt, createdBy
         FROM AdminInvite
         WHERE tokenHash = ? AND status = 'pending_scan' AND expiresAt > NOW()`,
        [hash],
    );
    return rows[0] ?? null;
}

/** Mark invite as pending_email and attach an email verification token. Returns raw email token. */
export async function attachEmailToken(inviteId: number, claimedUserId: string): Promise<string> {
    const rawEmailToken = randomToken();
    const emailToken = sha256(rawEmailToken);
    const emailExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 h
    await pool.query(
        `UPDATE AdminInvite
         SET status = 'pending_email', emailToken = ?, emailExpiry = ?,
             claimedUserId = ?, claimedAt = NOW()
         WHERE id = ?`,
        [emailToken, emailExpiry, claimedUserId, inviteId],
    );
    await auditLog({ inviteId, userId: claimedUserId, action: 'qr_claimed' });
    return rawEmailToken;
}

/** Verify email token, grant admin, return the invite on success or null on failure. */
export async function verifyEmailToken(rawEmailToken: string): Promise<AdminInvite | null> {
    const hash = sha256(rawEmailToken);
    const [rows]: any = await pool.query(
        `SELECT id, email, firstName, lastName, role, claimedUserId
         FROM AdminInvite
         WHERE emailToken = ? AND status = 'pending_email' AND emailExpiry > NOW()`,
        [hash],
    );
    const invite = rows[0];
    if (!invite) return null;

    await pool.query(
        `UPDATE AdminInvite SET status = 'claimed', emailToken = NULL, emailExpiry = NULL WHERE id = ?`,
        [invite.id],
    );
    await pool.query(
        `UPDATE User
         SET isAdmin = 1, adminRole = ?, firstName = ?, lastName = ?,
             adminEmail = ?, adminGrantedAt = NOW()
         WHERE id = ?`,
        [invite.role, invite.firstName, invite.lastName, invite.email, invite.claimedUserId],
    );
    await auditLog({
        inviteId: invite.id,
        userId: invite.claimedUserId,
        action: 'admin_granted',
        detail: { role: invite.role, email: invite.email },
    });
    return invite;
}

// ── Audit log ──────────────────────────────────────────────────────────────

export async function auditLog(opts: {
    userId?: string;
    inviteId?: number;
    action: string;
    detail?: object;
}): Promise<void> {
    await pool.query(
        `INSERT INTO AdminInviteLog (userId, inviteId, action, detail) VALUES (?, ?, ?, ?)`,
        [opts.userId ?? null, opts.inviteId ?? null, opts.action, opts.detail ? JSON.stringify(opts.detail) : null],
    );
}

export async function getAuditLog(limit = 100): Promise<any[]> {
    const [rows]: any = await pool.query(
        `SELECT l.id, l.userId, l.inviteId, l.action, l.detail, l.createdAt,
                i.email, i.firstName, i.lastName
         FROM AdminInviteLog l
         LEFT JOIN AdminInvite i ON i.id = l.inviteId
         ORDER BY l.createdAt DESC LIMIT ?`,
        [limit],
    );
    return rows;
}
