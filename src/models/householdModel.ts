import pool from '../config/db.js';
import { appendMemberJoined } from './householdLedgerModel.js';

/**
 * Souply 2.0 households (Phase 1c). ONE household per user — enforced by
 * HouseholdMember's PRIMARY KEY(userId), not by application checks. Each
 * household owns AT MOST one shared basket (UNIQUE Basket.householdId): the
 * persistent container trips pull items from; it never completes.
 *
 * FAMILY SHOPPING (spec §3) added the "leaving" state and the settlement gate.
 * NOTE THE LAYERING: this file holds membership PRIMITIVES only. The gated
 * leave/remove entry points live in services/householdMembership.ts, because
 * they must consult the ledger, append ledger events and notify people — none
 * of which a model should reach for. There is deliberately no exported
 * "delete this membership unconditionally" function any more: §3.1 says a
 * member cannot leave with a non-zero balance, so every departure goes through
 * the gate.
 */

export interface HouseholdRow {
    id: number;
    createdByUserId: string;
    name: string | null;
    createdAt: string;
}

export interface HouseholdMemberRow {
    userId: string;
    householdId: number;
    role: 'owner' | 'member';
    joinedAt: string;
    /** §3.2.2 — set the moment a departure is requested; NULL for a normal member. */
    leavingRequestedAt: string | null;
    /** The member themselves (self-removal) or the owner who removed them. */
    leavingRequestedBy: string | null;
}

/** Create a household + owner membership + the shared basket, atomically. */
export const createHousehold = async (userId: string, name: string | null): Promise<{ householdId: number; sharedBasketId: number }> => {
    const conn = await pool.getConnection();
    let householdId: number;
    let sharedBasketId: number;
    try {
        await conn.beginTransaction();
        const [h]: any = await conn.query(
            'INSERT INTO Household (createdByUserId, name) VALUES (?, ?)', [userId, name]);
        householdId = h.insertId as number;
        // PRIMARY KEY(userId) throws ER_DUP_ENTRY if the user already has a
        // household — the controller maps that to the "leave first" 409.
        await conn.query(
            "INSERT INTO HouseholdMember (userId, householdId, role) VALUES (?, ?, 'owner')",
            [userId, householdId]);
        const [b]: any = await conn.query(
            "INSERT INTO Basket (userId, status, householdId) VALUES (?, 'draft', ?)",
            [userId, householdId]);
        sharedBasketId = b.insertId as number;
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
    // §3.5 — the founder is a member from event one. Appended AFTER the commit
    // and outside the transaction: a rolled-back household must leave no ledger
    // trace, and the ledger is a separate table with its own append discipline.
    await appendMemberJoined({ householdId, member: userId });
    return { householdId, sharedBasketId };
};

export const getHouseholdForUser = async (userId: string): Promise<(HouseholdRow & { role: string; sharedBasketId: number | null; leavingRequestedAt: string | null }) | null> => {
    const [rows]: any = await pool.query(
        `SELECT h.*, hm.role, hm.leavingRequestedAt,
                (SELECT b.id FROM Basket b WHERE b.householdId = h.id LIMIT 1) AS sharedBasketId
         FROM HouseholdMember hm
         JOIN Household h ON h.id = hm.householdId
         WHERE hm.userId = ?`,
        [userId]);
    return rows[0] ?? null;
};

export const getHouseholdMembers = async (householdId: number): Promise<HouseholdMemberRow[]> => {
    const [rows]: any = await pool.query(
        `SELECT userId, householdId, role, joinedAt, leavingRequestedAt, leavingRequestedBy
           FROM HouseholdMember WHERE householdId = ? ORDER BY joinedAt`,
        [householdId]);
    return rows;
};

/** The single membership row of a user (ONE household per user), or null. */
export const getMembership = async (userId: string): Promise<HouseholdMemberRow | null> => {
    const [rows]: any = await pool.query(
        `SELECT userId, householdId, role, joinedAt, leavingRequestedAt, leavingRequestedBy
           FROM HouseholdMember WHERE userId = ? LIMIT 1`,
        [userId]);
    return rows[0] ?? null;
};

export const isHouseholdMember = async (householdId: number, userId: string): Promise<boolean> => {
    const [rows]: any = await pool.query(
        'SELECT 1 FROM HouseholdMember WHERE householdId = ? AND userId = ? LIMIT 1',
        [householdId, userId]);
    return rows.length > 0;
};

export const joinHousehold = async (householdId: number, userId: string): Promise<void> => {
    await pool.query(
        "INSERT INTO HouseholdMember (userId, householdId, role) VALUES (?, ?, 'member')",
        [userId, householdId]);
    // §3.5 — a joiner starts at balance 0 and participates only in receipts
    // recorded AFTER this event. They are never retroactively added to a past
    // trip: every receipt carries its OWN participant set (§1.1).
    await appendMemberJoined({ householdId, member: userId });
};

/**
 * §3.2.2 — the members who may still be added as participants on a new receipt.
 * A member who has requested to leave is excluded IMMEDIATELY, before their
 * settlement completes: that is precisely what stops their balance growing
 * while they wait for a counterparty to confirm.
 */
export const getEligibleParticipantIds = async (householdId: number): Promise<string[]> => {
    const [rows]: any = await pool.query(
        'SELECT userId FROM HouseholdMember WHERE householdId = ? AND leavingRequestedAt IS NULL ORDER BY userId',
        [householdId]);
    return (rows as { userId: string }[]).map(r => r.userId);
};

/**
 * Flip a membership into the "leaving" state. Returns false when it was
 * ALREADY leaving — the `leavingRequestedAt IS NULL` predicate makes this a
 * compare-and-set, so a second tap neither overwrites the original request time
 * nor re-sends the departure notifications.
 */
export const markMemberLeaving = async (
    householdId: number, userId: string, byUserId: string,
): Promise<boolean> => {
    const [res]: any = await pool.query(
        `UPDATE HouseholdMember SET leavingRequestedAt = NOW(), leavingRequestedBy = ?
          WHERE householdId = ? AND userId = ? AND leavingRequestedAt IS NULL`,
        [byUserId, householdId, userId]);
    return res.affectedRows > 0;
};

/** Every member of the household currently in the "leaving" state (§3.2.2). */
export const getLeavingMembers = async (householdId: number): Promise<HouseholdMemberRow[]> => {
    const [rows]: any = await pool.query(
        `SELECT userId, householdId, role, joinedAt, leavingRequestedAt, leavingRequestedBy
           FROM HouseholdMember WHERE householdId = ? AND leavingRequestedAt IS NOT NULL`,
        [householdId]);
    return rows;
};

/**
 * Physically remove ONE membership row. INTERNAL to the departure flow — the
 * §3.1 balance gate lives in services/householdMembership.ts and this must
 * never be called around it. Returns false when the row was already gone, which
 * is what makes the departure flow safe to run twice: the 7-day auto-confirm
 * sweeper races a manual confirm by design.
 */
export const deleteMembershipRow = async (householdId: number, userId: string): Promise<boolean> => {
    const [res]: any = await pool.query(
        'DELETE FROM HouseholdMember WHERE householdId = ? AND userId = ?', [householdId, userId]);
    return res.affectedRows > 0;
};

export const countHouseholdMembers = async (householdId: number): Promise<number> => {
    const [rows]: any = await pool.query(
        'SELECT COUNT(*) AS n FROM HouseholdMember WHERE householdId = ?', [householdId]);
    return Number(rows[0].n);
};

/**
 * Tear down the household: every membership, the shared basket and its items,
 * then the household row — in one transaction.
 *
 * The LEDGER LOG IS NOT DELETED. It is append-only (§1.1); the events remain
 * the record of what those balances were, the model exports no delete path for
 * them, and this is not the place to invent one.
 */
export const dissolveHousehold = async (householdId: number): Promise<void> => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM HouseholdMember WHERE householdId = ?', [householdId]);
        await conn.query(
            'DELETE FROM BasketItem WHERE basketId IN (SELECT id FROM Basket WHERE householdId = ?)', [householdId]);
        await conn.query('DELETE FROM Basket WHERE householdId = ?', [householdId]);
        await conn.query('DELETE FROM Household WHERE id = ?', [householdId]);
        await conn.commit();
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
};
